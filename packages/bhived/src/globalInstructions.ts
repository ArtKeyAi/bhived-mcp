/**
 * Global instructions bootstrapper.
 *
 * Writes the compact bhived Memory Protocol block into each supported agent's
 * USER-GLOBAL instructions file — the file the agent auto-loads for every
 * session across all projects — instead of the currently-opened workspace.
 *
 * Every path below was verified against the vendor's official documentation
 * for Windows, macOS, and Linux. Agents whose global instructions live only in
 * an app database / UI (no file on disk) are marked `skip` — we never invent a
 * path for them.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, TargetPlatform } from "./agentConfigs.js";

export const BHIVED_START = "<!-- BHIVED_INSTRUCTIONS_START -->";
export const BHIVED_END = "<!-- BHIVED_INSTRUCTIONS_END -->";
export const VERSION_PREFIX = "<!-- BHIVED_VERSION:";
export const VERSION_SUFFIX = "-->";
export const SCOPE_PREFIX = "<!-- BHIVED_SCOPE:";
export const SCOPE_SUFFIX = "-->";

/**
 * The API key's verified scope, stamped into the instruction block so the
 * protocol copy matches what the key can actually do:
 *  - "team"     → GET /v1/subscription returned plan "team".
 *  - "personal" → GET /v1/subscription returned plan "pro" or "free".
 *  - "unknown"  → the live check has never succeeded and no stored metadata
 *                 exists; the block keeps conditional both-cases copy.
 */
export type InstructionScope = "team" | "personal" | "unknown";

/**
 * Global-instruction targets: the 14 MCP agents plus a cross-tool "universal"
 * target (`~/.agents/AGENTS.md`) that any agents.md-compliant tool reads.
 * "universal" is intentionally NOT an AgentId — it has no MCP server config.
 */
export type GlobalTargetId = AgentId | "universal";

/** How a given agent stores its user-global instructions on disk. */
export type GlobalInstructionStrategy =
  | "marker-md" // Markdown file (optionally with YAML frontmatter); merge via BHIVED markers.
  | "continue-yaml" // Instructions live as a `rules:` entry in config.yaml.
  | "skip"; // No global file on disk (stored in app DB/UI) — cannot write.

/** YAML frontmatter some agents require for a rule/instructions file to apply globally. */
export const CURSOR_FRONTMATTER = "---\nalwaysApply: true\n---\n\n";
export const VSCODE_FRONTMATTER = "---\napplyTo: '**'\n---\n\n";

export interface GlobalInstructionTarget {
  agentId: GlobalTargetId;
  label: string;
  strategy: GlobalInstructionStrategy;
  /** Human-readable filename shown in output (e.g. "CLAUDE.md"). */
  filename: string;
  /** Absolute path resolver for a writable target; returns "" when strategy is "skip". */
  resolvePath: (platform: TargetPlatform) => string;
  /** YAML frontmatter to prepend for a "marker-md" file that needs it (Cursor/VS Code). */
  frontmatter?: string;
  /** Why a "skip" target cannot be written, and what the user should do instead. */
  skipReason?: string;
  /** Extra guidance surfaced after a successful write. */
  note?: string;
  /** Official documentation confirming the path. */
  docs: string;
}

// ── Version ──────────────────────────────────────────────────────
// Read once from the CLI's own package.json so the embedded version marker
// tracks the published bhived version.

let CLI_VERSION = "unknown";
try {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkgJson = JSON.parse(await readFile(pkgPath, "utf-8")) as { version?: string };
  CLI_VERSION = pkgJson.version ?? "unknown";
} catch {
  // Non-fatal: fall back to "unknown"; the marker still round-trips.
}

export function bhivedVersion(): string {
  return CLI_VERSION;
}

// ── Protocol block ───────────────────────────────────────────────

/** Scope-specific line telling agents what THIS key reads and where writes land. */
const SCOPE_LINES: Record<InstructionScope, string> = {
  team:
    "- Your API key is **team-scoped**: `bhived_query` reads your team's private memory + the shared public brain (returned as separate sections), and writes land in your **team's private memory** — not the global public brain. Use `scope` (`team_only`/`global_only`) on `bhived_query` to narrow reads.",
  personal:
    "- Your API key is **personal**: reads and writes use the **global public brain** only — there is no private team tier on this key, so never write anything confidential or team-internal. `scope: team_only` on `bhived_query` returns nothing; leave `scope` unset.",
  unknown:
    "- Your API key sets your scope: a team key reads team + public and **writes land in your team's private memory** (not the public brain); a personal key reads/writes the global public brain only. Use `scope` (`team_only`/`global_only`) on `bhived_query` to narrow.",
};

/**
 * The bhived Memory Protocol, wrapped in idempotent start/end/version/scope
 * markers. `scope` should be the key's verified scope when known — the CLI and
 * the MCP server re-verify it via GET /v1/subscription and rewrite this block
 * when it changes.
 */
export function bhivedInstructionsBlock(
  version: string = CLI_VERSION,
  scope: InstructionScope = "unknown"
): string {
  return `${BHIVED_START}
${VERSION_PREFIX} ${version} ${VERSION_SUFFIX}
${SCOPE_PREFIX} ${scope} ${SCOPE_SUFFIX}
# bhived Memory Protocol

bhived is shared memory for AI agents. Before solving specialized, unfamiliar, risky, or medium/hard work, query bhived first instead of guessing.

## Use bhived

- For any specialized, unfamiliar, risky, or medium/hard task, first read enough local context to ask a specific question, then call \`bhived_query\`.
- Also query after 2 failed attempts, version/API uncertainty, confusing errors, or when the user corrects you and you need to verify the better approach.
- Ask specific queries with stack, versions, exact error, goal, constraints, and what you already tried.
- Save the returned \`query_id\`. Treat it as required if you later write back.
- Verify results actually match your stack/versions before applying them — scores are retrieval match, not verified correctness, and an empty Warnings section does not mean an approach is safe.
- If results include a relevant skill or MCP, activate it before solving manually. Use only capabilities that clearly match the task.
${SCOPE_LINES[scope]}

## Close the Loop

- Write back only after verified useful learning: non-obvious fix, better approach than results, repeated pitfall, version/API change, or a correct user correction.
- If the user corrected you and they were right, write the corrected lesson with \`query_id\` and mention what was wrong before.
- Use the **same key** for the query and the follow-up write — a \`query_id\` from a different tenant/hive is not linked.
- Use \`bhived_write_instruction\` for what worked, \`bhived_write_mistake\` for dead ends/errors, and \`bhived_write_update\` for factual/version changes.
- Keep writes under ~350 words, name concrete packages/APIs/versions, and quote error messages verbatim.
- Do not write for trivial tasks, unverified guesses, secrets, credentials, private URLs, or user/customer data.

## Write Format

Use concise, searchable text. For instructions:

\`\`\`
**Context:** stack, versions, OS, constraints
**Solution:** exact steps that worked
**Pitfalls:** failed attempts, errors quoted verbatim, and why they failed
**Verified:** test/build/manual check performed
\`\`\`

For mistakes: approach tried → exact error (verbatim) → why it failed → what to do instead.
${BHIVED_END}`;
}

// ── Marker helpers ───────────────────────────────────────────────

export function hasBhivedSection(content: string): boolean {
  return content.includes(BHIVED_START) && content.includes(BHIVED_END);
}

export function extractEmbeddedVersion(content: string): string | null {
  const versionStart = content.indexOf(VERSION_PREFIX);
  if (versionStart === -1) return null;

  const afterPrefix = versionStart + VERSION_PREFIX.length;
  const versionEnd = content.indexOf(VERSION_SUFFIX, afterPrefix);
  if (versionEnd === -1) return null;
  return content.substring(afterPrefix, versionEnd).trim();
}

/** Extract the stamped scope from a block; null for pre-scope blocks or garbage. */
export function extractEmbeddedScope(content: string): InstructionScope | null {
  const scopeStart = content.indexOf(SCOPE_PREFIX);
  if (scopeStart === -1) return null;

  const afterPrefix = scopeStart + SCOPE_PREFIX.length;
  const scopeEnd = content.indexOf(SCOPE_SUFFIX, afterPrefix);
  if (scopeEnd === -1) return null;
  const value = content.substring(afterPrefix, scopeEnd).trim();
  return value === "team" || value === "personal" || value === "unknown" ? value : null;
}

/**
 * Compare version strings (`1.2.3`, `1.3.0-rc.1`): -1 when `a` is older than
 * `b`, 0 equal, 1 newer. Semver-aware where it matters here: a prerelease
 * (`-suffix`) sorts OLDER than its release core. Asymmetric on garbage by
 * design: an unparseable STAMPED version (`a`) sorts older so the block gets
 * refreshed, but an unparseable RUNNING version (`b`, e.g. the "unknown"
 * fallback when package.json is unreadable) must never judge a validly-stamped
 * block as outdated — that would rewrite every file with version "unknown".
 */
export function compareVersions(a: string | null, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const da = pa.core[i] ?? 0;
    const db = pb.core[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  // Equal numeric cores: the version WITH a prerelease suffix is older.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

function parseVersion(value: string | null): { core: number[]; pre: string | null } | null {
  if (!value) return null;
  const dash = value.indexOf("-");
  const coreStr = dash === -1 ? value : value.slice(0, dash);
  if (!/^\d+(\.\d+)*$/.test(coreStr)) return null;
  return {
    core: coreStr.split(".").map((n) => parseInt(n, 10)),
    pre: dash === -1 ? null : value.slice(dash + 1),
  };
}

/** Replace the marked bhived block in `content` with `newSection`, preserving surrounding text. */
export function replaceMarkedSection(content: string, newSection: string): string {
  const startIdx = content.indexOf(BHIVED_START);
  const endIdx = content.indexOf(BHIVED_END);
  if (startIdx === -1 || endIdx === -1) return content;

  const before = content.substring(0, startIdx).trimEnd();
  const after = content.substring(endIdx + BHIVED_END.length).trimStart();
  if (!before) return after ? `${newSection}\n\n${after}` : newSection;
  return after ? `${before}\n\n${newSection}\n\n${after}` : `${before}\n\n${newSection}`;
}

// ── Path resolvers ───────────────────────────────────────────────

function home(...segments: string[]): string {
  return join(homedir(), ...segments);
}

function appData(): string {
  return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
}

/** XDG-style config base. OpenCode uses ~/.config even on Windows; honor XDG_CONFIG_HOME elsewhere. */
function xdgConfig(platform: TargetPlatform): string {
  if (platform !== "windows" && process.env.XDG_CONFIG_HOME) {
    return process.env.XDG_CONFIG_HOME;
  }
  return home(".config");
}

// ── Verified per-agent global instruction targets ────────────────
// Sources are the vendor's official docs (or official GitHub), confirmed for
// Windows / macOS / Linux. See docs URL on each entry.

export const GLOBAL_INSTRUCTION_TARGETS: Record<GlobalTargetId, GlobalInstructionTarget> = {
  universal: {
    agentId: "universal",
    label: "Universal (cross-tool AGENTS.md)",
    strategy: "marker-md",
    filename: "AGENTS.md",
    docs: "https://agents.md",
    // The shared cross-tool location read by agents.md-compliant tools
    // (e.g. Cline reads ~/.agents/AGENTS.md as a global rule).
    resolvePath: () => home(".agents", "AGENTS.md"),
    note: "~/.agents/AGENTS.md is the cross-tool global file read by agents.md-compliant tools.",
  },
  "claude-code": {
    agentId: "claude-code",
    label: "Claude Code",
    strategy: "marker-md",
    filename: "bhived.md",
    docs: "https://code.claude.com/docs/en/memory",
    // Dedicated user-level rule file (loaded for all projects), leaving the
    // user's own ~/.claude/CLAUDE.md untouched. Respects $CLAUDE_CONFIG_DIR.
    resolvePath: () => join(process.env.CLAUDE_CONFIG_DIR || home(".claude"), "rules", "bhived.md"),
    note: "Dedicated rule in ~/.claude/rules/ (loaded across all projects; respects $CLAUDE_CONFIG_DIR).",
  },
  "claude-desktop": {
    agentId: "claude-desktop",
    label: "Claude Desktop",
    strategy: "skip",
    filename: "",
    docs: "https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features",
    resolvePath: () => "",
    skipReason: "no global instructions file on disk (Claude Desktop stores instructions in-app).",
  },
  cursor: {
    agentId: "cursor",
    label: "Cursor",
    strategy: "marker-md",
    filename: "bhived.mdc",
    frontmatter: CURSOR_FRONTMATTER,
    docs: "https://cursor.com/docs/rules",
    // Global rules directory (~/.cursor/rules/) — the same target the Context7
    // CLI writes to. Not officially documented, but the de-facto ecosystem path;
    // harmless if Cursor ignores it. `alwaysApply: true` makes it always-on.
    resolvePath: () => home(".cursor", "rules", "bhived.mdc"),
    note: "Global Cursor rule at ~/.cursor/rules/bhived.mdc (alwaysApply: true).",
  },
  vscode: {
    agentId: "vscode",
    label: "VS Code / GitHub Copilot",
    strategy: "marker-md",
    filename: "bhived.instructions.md",
    frontmatter: VSCODE_FRONTMATTER,
    docs: "https://code.visualstudio.com/docs/copilot/customization/custom-instructions",
    resolvePath: (platform) => {
      if (platform === "windows") return join(appData(), "Code", "User", "prompts", "bhived.instructions.md");
      if (platform === "macos") return home("Library", "Application Support", "Code", "User", "prompts", "bhived.instructions.md");
      return home(".config", "Code", "User", "prompts", "bhived.instructions.md");
    },
    note: "Applies globally via `applyTo: '**'` frontmatter; synced through Settings Sync.",
  },
  windsurf: {
    agentId: "windsurf",
    label: "Windsurf",
    strategy: "marker-md",
    filename: "global_rules.md",
    docs: "https://docs.windsurf.com/windsurf/cascade/memories",
    resolvePath: () => home(".codeium", "windsurf", "memories", "global_rules.md"),
    note: "global_rules.md is always-on across all workspaces (6,000-char limit).",
  },
  cline: {
    agentId: "cline",
    label: "Cline",
    strategy: "marker-md",
    filename: "bhived.md",
    docs: "https://docs.cline.bot/features/cline-rules",
    // Global "Cline/Rules" directory; on Linux it can be ~/Cline/Rules when ~/Documents is absent.
    resolvePath: (platform) => {
      if (platform === "linux") {
        const documents = home("Documents", "Cline", "Rules");
        return existsSyncSafe(home("Documents")) ? join(documents, "bhived.md") : home("Cline", "Rules", "bhived.md");
      }
      return home("Documents", "Cline", "Rules", "bhived.md");
    },
    note: "Dropped into the global Cline Rules directory (combined with your other global rules).",
  },
  gemini: {
    agentId: "gemini",
    label: "Gemini CLI",
    strategy: "marker-md",
    filename: "GEMINI.md",
    docs: "https://geminicli.com/docs/cli/gemini-md/",
    resolvePath: () => home(".gemini", "GEMINI.md"),
    note: "~/.gemini/GEMINI.md is the global context file loaded first in every session.",
  },
  opencode: {
    agentId: "opencode",
    label: "OpenCode",
    strategy: "marker-md",
    filename: "AGENTS.md",
    docs: "https://opencode.ai/docs/rules/",
    resolvePath: (platform) => join(xdgConfig(platform), "opencode", "AGENTS.md"),
    note: "~/.config/opencode/AGENTS.md applies across all opencode sessions.",
  },
  codex: {
    agentId: "codex",
    label: "OpenAI Codex CLI",
    strategy: "marker-md",
    filename: "AGENTS.md",
    docs: "https://developers.openai.com/codex/guides/agents-md",
    resolvePath: () => {
      const codexHome = process.env.CODEX_HOME;
      return codexHome ? join(codexHome, "AGENTS.md") : home(".codex", "AGENTS.md");
    },
    note: "~/.codex/AGENTS.md is the global instruction file (respects $CODEX_HOME).",
  },
  antigravity: {
    agentId: "antigravity",
    label: "Google Antigravity",
    strategy: "marker-md",
    filename: "GEMINI.md",
    docs: "https://antigravity.google/docs/rules-workflows",
    // Antigravity's global rules file is ~/.gemini/GEMINI.md — the same file as Gemini CLI.
    resolvePath: () => home(".gemini", "GEMINI.md"),
    note: "~/.gemini/GEMINI.md is Antigravity's global rules file (shared with Gemini CLI).",
  },
  openclaw: {
    agentId: "openclaw",
    label: "OpenClaw",
    strategy: "marker-md",
    filename: "AGENTS.md",
    docs: "https://docs.openclaw.ai/concepts/agent-workspace",
    // Workspace default is ~/.openclaw/workspace, overridable via OPENCLAW_WORKSPACE_DIR.
    resolvePath: () => {
      const ws = process.env.OPENCLAW_WORKSPACE_DIR;
      return ws ? join(ws, "AGENTS.md") : home(".openclaw", "workspace", "AGENTS.md");
    },
    note: "Workspace AGENTS.md is loaded at the start of every session (respects $OPENCLAW_WORKSPACE_DIR).",
  },
  "roo-code": {
    agentId: "roo-code",
    label: "Roo Code",
    strategy: "marker-md",
    filename: "bhived.md",
    docs: "https://docs.roocode.com/features/custom-instructions",
    resolvePath: () => home(".roo", "rules", "bhived.md"),
    note: "Dropped into the fixed global rules directory ~/.roo/rules/ (applies to all projects).",
  },
  continue: {
    agentId: "continue",
    label: "Continue",
    strategy: "continue-yaml",
    filename: "config.yaml",
    docs: "https://docs.continue.dev/customize/deep-dives/configuration",
    resolvePath: () => home(".continue", "config.yaml"),
    note: "Added as a global `rules:` entry named `bhived` in ~/.continue/config.yaml.",
  },
  zed: {
    agentId: "zed",
    label: "Zed",
    strategy: "marker-md",
    filename: "AGENTS.md",
    docs: "https://zed.dev/docs/ai/rules",
    resolvePath: (platform) => {
      if (platform === "windows") return join(appData(), "Zed", "AGENTS.md");
      return home(".config", "zed", "AGENTS.md");
    },
    note: "Global ~/.config/zed/AGENTS.md is included in every conversation.",
  },
};

function existsSyncSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
