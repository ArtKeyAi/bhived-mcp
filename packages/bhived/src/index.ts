#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authenticateWithBrowser } from "./auth.js";
import {
  AGENT_IDS,
  detectPlatform,
  getAgentConfig,
  parseFlags,
  parsePlatform,
  type AgentId,
  type TargetPlatform,
} from "./agentConfigs.js";
import {
  deleteStoredConfig,
  getConfigPath,
  maskApiKey,
  readStoredConfig,
  updateStoredPlan,
  type StoredBhivedConfig,
} from "./configFile.js";
import type { InstructionScope } from "./globalInstructions.js";
import { detectAgentInstall, installAgentConfig } from "./installAgentConfigs.js";
import {
  installGlobalInstruction,
  refreshOutdatedInstructions,
} from "./installGlobalInstructions.js";
import { fetchSubscriptionPlan, planToScope, scopeFromStored } from "./subscription.js";

const command = process.argv[2] ?? "help";

try {
  // Keep global bhived instruction blocks current on every command (best-effort,
  // silent unless something was actually outdated). `setup` handles this itself.
  if (!["help", "--help", "-h", "setup"].includes(command)) {
    await refreshInstructionsQuietly();
  }

  switch (command) {
    case "auth":
      await runAuth();
      break;
    case "setup":
      await runSetup();
      break;
    case "status":
      await runStatus();
      break;
    case "logout":
      await runLogout();
      break;
    case "remove":
      await runRemove();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function runAuth(): Promise<ResolvedScope> {
  const config = await authenticateWithBrowser({ packageVersion: await getPackageVersion() });
  console.log(`Authenticated${config.user?.email ? ` as ${config.user.email}` : ""}.`);
  console.log(`Saved Bhived credentials to ${getConfigPath()}.`);
  console.log(`API key: ${maskApiKey(config.apiKey)}`);
  const resolved = await resolveScope(config);
  printScope(resolved);
  return resolved;
}

interface ResolvedScope {
  scope: InstructionScope;
  plan?: string;
  team?: { id: string; name?: string };
  /** True when the scope came from a live GET /v1/subscription call. */
  verified: boolean;
}

/**
 * Resolve the key's real scope: live `GET /v1/subscription` first, stored
 * sign-in metadata as fallback. A live result is persisted to config.json
 * (best-effort — a read-only file must not break the command). Either way,
 * a known scope is re-stamped into existing agent instruction files so their
 * bhived block matches the key in use — critical after `bhived auth` switched
 * accounts while the live check was unavailable.
 */
async function resolveScope(stored: StoredBhivedConfig): Promise<ResolvedScope> {
  const livePlan = await fetchSubscriptionPlan(stored.apiUrl, stored.apiKey);
  if (livePlan) {
    const scope = planToScope(livePlan);
    await updateStoredPlan(livePlan).catch(() => {
      // Best-effort: the verified scope is still reported and re-persisted next run.
    });
    await refreshInstructionsWithScope(scope);
    return {
      scope,
      plan: livePlan,
      team: livePlan === "team" ? stored.team : undefined,
      verified: true,
    };
  }
  const scope = scopeFromStored(stored);
  if (scope !== "unknown") {
    await refreshInstructionsWithScope(scope);
  }
  return { scope, plan: stored.plan, team: stored.team, verified: false };
}

/** Best-effort re-stamp of existing instruction files with a KNOWN scope. */
async function refreshInstructionsWithScope(scope: InstructionScope): Promise<void> {
  try {
    const updated = await refreshOutdatedInstructions(detectPlatform(), scope);
    for (const result of updated) {
      console.log(`[bhived] Updated global instructions for ${result.label}: ${result.message}`);
    }
  } catch {
    // Best-effort — never block a command on instruction refresh.
  }
}

function printScope(resolved: ResolvedScope): void {
  const via = resolved.verified
    ? "verified via GET /v1/subscription"
    : "from sign-in metadata; the live scope check did not succeed";
  if (resolved.scope === "team") {
    const teamName = resolved.team?.name ?? resolved.team?.id;
    console.log(`Scope: team${teamName ? ` "${teamName}"` : ""} — reads team+public, writes team-private (${via}).`);
  } else if (resolved.scope === "personal") {
    console.log(`Scope: personal (plan: ${resolved.plan ?? "unknown"}) — reads/writes the global public brain (${via}).`);
  } else {
    console.log("Scope: unknown — the live scope check (GET /v1/subscription) did not succeed and no scope metadata is stored. It will be verified on the next successful connection.");
  }
}

async function runSetup(): Promise<void> {
  const flags = parseFlags(process.argv.slice(3));
  const platform = parsePlatform(flags);
  const flagSet = new Set(
    Array.from(flags.entries())
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .filter((key): key is AgentId | "all" => key === "all" || (AGENT_IDS as readonly string[]).includes(key))
  );
  const explicitAgents = AGENT_IDS.filter((id) => flagSet.has(id));
  const forceAll = flags.has("force-all");
  const detectInstalledOnly = !forceAll && (flagSet.has("all") || explicitAgents.length === 0);
  const selectedAgents = forceAll || detectInstalledOnly ? [...AGENT_IDS] : explicitAgents;
  const writeInstructions = !flags.has("no-instructions");
  const writeMcp = !flags.has("instructions-only");
  const existing = await readStoredConfig();

  console.log("Bhived setup");
  console.log(`Platform: ${platform}${flags.has("platform") ? " (overridden)" : " (auto-detected)"}`);

  let resolved: ResolvedScope;
  if (existing) {
    console.log(`Auth: already signed in${existing.user?.email ? ` as ${existing.user.email}` : ""}`);
    console.log(`Credentials: ${getConfigPath()} (${maskApiKey(existing.apiKey)})`);
    resolved = await resolveScope(existing);
    printScope(resolved);
  } else {
    console.log("Auth: browser sign-in required");
    resolved = await runAuth();
  }

  console.log("");
  await installAgentConfigs(selectedAgents, platform, detectInstalledOnly, {
    writeMcp,
    writeInstructions,
    // Stamp instruction files with the verified scope only; "unknown" would
    // overwrite a previously-verified scope with weaker conditional copy.
    scope: resolved.scope === "unknown" ? undefined : resolved.scope,
  });
}

async function runStatus(): Promise<void> {
  const config = await readStoredConfig();

  if (!config) {
    console.log("Authenticated: no");
    console.log("Run: npx bhived setup");
    return;
  }

  console.log("Authenticated: yes");
  if (config.user?.email) console.log(`User: ${config.user.email}`);
  console.log(`API URL: ${config.apiUrl}`);
  console.log(`API key: ${maskApiKey(config.apiKey)}`);

  const resolved = await resolveScope(config);
  if (resolved.scope === "team" && resolved.team?.id) {
    console.log(`Team: ${resolved.team.name ?? "(unnamed)"} (${resolved.team.id})`);
  }
  if (resolved.plan) console.log(`Plan: ${resolved.plan}`);
  printScope(resolved);
  console.log(`Config: ${getConfigPath()}`);
}

async function runLogout(): Promise<void> {
  await deleteStoredConfig();
  console.log("Removed local Bhived credentials.");
}

async function runRemove(): Promise<void> {
  console.log("Automatic client config removal is not implemented yet.");
  console.log("Local credentials can be removed with: npx bhived logout");
}

function printHelp(): void {
  console.log(`Bhived CLI

Usage:
  bhived setup [agent flags]
  bhived auth
  bhived status
  bhived logout
  bhived remove

Agent flags:
  --all              Check installed supported agents and install only those found (default)
  --claude-code      Claude Code config
  --claude-desktop   Claude Desktop config
  --cursor           Cursor config
  --vscode           VS Code / GitHub Copilot workspace config
  --windsurf         Windsurf config
  --cline            Cline config
  --gemini           Gemini CLI config
  --opencode         OpenCode workspace config
  --codex            OpenAI Codex config
  --antigravity      Google Antigravity config when supported
  --openclaw         OpenClaw config
  --roo-code         Roo Code config
  --continue         Continue config
  --zed              Zed config
  --force-all        Install all supported configs without detection

Options:
  --platform          Override auto-detected OS for docs/testing: windows|macos|linux
  --no-instructions   Only install MCP config; skip the global instructions file
  --instructions-only Only write the global instructions file; skip MCP config

Global instructions:
  On setup, bhived writes its Memory Protocol block into each detected agent's
  user-global instructions file (e.g. ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md,
  ~/.gemini/GEMINI.md) so it applies to all sessions — never the opened project.
  Every other bhived command refreshes that block if a newer version ships.
  Claude Desktop and Cursor keep global instructions in-app (no file) and are skipped.

Environment:
  BHIVED_WEBSITE_URL  Override website URL for auth, e.g. http://localhost:3000
`);
}

interface InstallOptions {
  writeMcp: boolean;
  writeInstructions: boolean;
  /** Verified key scope to stamp into instruction blocks; omit when unknown. */
  scope?: InstructionScope;
}

async function installAgentConfigs(
  agentIds: AgentId[],
  platform: TargetPlatform,
  detectInstalledOnly: boolean,
  options: InstallOptions
): Promise<void> {
  const mode = detectInstalledOnly ? "detect installed agents" : agentIds.length === AGENT_IDS.length ? "force all supported agents" : "explicit agent selection";

  const scope = options.writeMcp && options.writeInstructions
    ? "MCP config + global instructions"
    : options.writeMcp
      ? "MCP config"
      : "global instructions";
  console.log(`Install (${scope})`);
  console.log(`Mode: ${mode}`);
  if (detectInstalledOnly) {
    console.log("Detection: checking known app/config paths before writing");
  }
  if (options.writeMcp) {
    console.log("Safety: preserving existing MCP servers; only `bhived` is added or replaced");
    console.log("Secrets: no API key is written into agent configs; agents read `~/.bhived/config.json`");
  }
  if (options.writeInstructions) {
    console.log("Instructions: bhived protocol block written to each agent's user-global instructions file");
  }
  console.log("");

  let mcpInstalled = 0;
  let instructionsChanged = 0;
  let detectedCount = 0;
  const configuredLabels = new Set<string>();
  const skippedLabels: string[] = [];

  for (const agentId of agentIds) {
    const config = getAgentConfig(agentId, platform);
    if (detectInstalledOnly) {
      const detection = await detectAgentInstall(agentId, platform);
      if (!detection.installed) {
        skippedLabels.push(config.label);
        console.log(`[skip] ${config.label}: not detected`);
        console.log(`       Checked: ${detection.reason}`);
        continue;
      }
      detectedCount++;
      console.log(`[detect] ${config.label}: ${detection.reason}`);
    }

    if (options.writeMcp) {
      const result = await installAgentConfig(agentId, platform);
      if (result.status === "installed") {
        mcpInstalled++;
        configuredLabels.add(config.label);
        console.log(`[ok] ${config.label}: MCP config -> ${result.path ?? result.message}`);
      } else {
        console.log(`[skip] ${config.label}: MCP config — ${result.message}`);
      }
    }

    if (options.writeInstructions) {
      const instr = await installGlobalInstruction(agentId, platform, { create: true, scope: options.scope });
      switch (instr.status) {
        case "written":
          instructionsChanged++;
          configuredLabels.add(config.label);
          console.log(`[ok] ${config.label}: instructions -> ${instr.path ?? instr.message}`);
          break;
        case "updated":
          instructionsChanged++;
          configuredLabels.add(config.label);
          console.log(`[ok] ${config.label}: instructions updated ${instr.message}`);
          break;
        case "up-to-date":
          console.log(`[ok] ${config.label}: instructions already current (${instr.path ?? instr.message})`);
          break;
        case "skipped":
          console.log(`[skip] ${config.label}: instructions — ${instr.message}`);
          break;
      }
    }
  }

  // Universal cross-tool file (~/.agents/AGENTS.md). Written once per run when
  // instructions are enabled, unless detect-mode surfaced no agents at all.
  if (options.writeInstructions && (!detectInstalledOnly || configuredLabels.size > 0)) {
    const universal = await installGlobalInstruction("universal", platform, { create: true, scope: options.scope });
    switch (universal.status) {
      case "written":
        instructionsChanged++;
        configuredLabels.add(universal.label);
        console.log(`[ok] ${universal.label}: instructions -> ${universal.path ?? universal.message}`);
        break;
      case "updated":
        instructionsChanged++;
        configuredLabels.add(universal.label);
        console.log(`[ok] ${universal.label}: instructions updated ${universal.message}`);
        break;
      case "up-to-date":
        console.log(`[ok] ${universal.label}: instructions already current (${universal.path ?? universal.message})`);
        break;
      case "skipped":
        console.log(`[skip] ${universal.label}: instructions — ${universal.message}`);
        break;
    }
  }

  console.log("");
  console.log("Summary");
  if (detectInstalledOnly) console.log(`Detected: ${detectedCount}/${agentIds.length}`);
  if (options.writeMcp) console.log(`MCP configs installed/updated: ${mcpInstalled}`);
  if (options.writeInstructions) console.log(`Instruction files written/updated: ${instructionsChanged}`);
  if (configuredLabels.size > 0) console.log(`Configured: ${[...configuredLabels].join(", ")}`);
  if (skippedLabels.length > 0 && skippedLabels.length <= 8) console.log(`Not detected: ${skippedLabels.join(", ")}`);

  if (detectInstalledOnly && configuredLabels.size === 0) {
    console.log("");
    console.log("No supported agents were detected.");
    console.log("To configure one anyway, run an explicit flag such as `bhived setup --opencode` or `bhived setup --openclaw`.");
    console.log("To force every supported agent, run `bhived setup --force-all`.");
  }

  if (configuredLabels.size > 0) {
    console.log("");
    console.log("Next steps");
    if (options.writeMcp) console.log("Restart any configured agent/client so it reloads MCP servers.");
    if (options.writeInstructions) console.log("New chats/sessions will pick up the bhived protocol from the global instructions file.");
  }
}

/** Refresh only outdated bhived blocks that already exist; print a concise note if anything changed. */
async function refreshInstructionsQuietly(): Promise<void> {
  try {
    const platform: TargetPlatform = detectPlatform();
    // Offline scope from the stored config (no network per command) — the
    // stored plan is kept fresh by resolveScope() on auth/status/setup and by
    // the MCP server's startup sync. "unknown" preserves the stamped scope.
    const storedScope = scopeFromStored(await readStoredConfig());
    const updated = await refreshOutdatedInstructions(
      platform,
      storedScope === "unknown" ? undefined : storedScope
    );
    for (const result of updated) {
      console.log(`[bhived] Updated global instructions for ${result.label}: ${result.message}`);
    }
  } catch {
    // Best-effort — never block a command on instruction refresh.
  }
}

async function getPackageVersion(): Promise<string> {
  try {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8")) as { version?: string };
    return packageJson.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
