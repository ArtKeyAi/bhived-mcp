/**
 * Writers for each agent's user-global instructions file.
 *
 * Two modes:
 *   - create=true  (bhived setup): create the file if missing, merge/append the
 *     bhived block, and update it when the embedded version is stale.
 *   - create=false (every other command): only refresh an EXISTING, outdated
 *     bhived block. Never create files and never append into files that don't
 *     already carry a bhived block — so routine commands stay non-invasive.
 */

import { constants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseDocument, type ParsedNode } from "yaml";
import type { TargetPlatform } from "./agentConfigs.js";
import {
  bhivedInstructionsBlock,
  bhivedVersion,
  extractEmbeddedVersion,
  GLOBAL_INSTRUCTION_TARGETS,
  hasBhivedSection,
  replaceMarkedSection,
  type GlobalInstructionTarget,
  type GlobalTargetId,
} from "./globalInstructions.js";

export type GlobalInstructionStatus = "written" | "updated" | "up-to-date" | "skipped";

export interface GlobalInstructionResult {
  agentId: GlobalTargetId;
  label: string;
  status: GlobalInstructionStatus;
  path?: string;
  message: string;
}

export interface WriteOptions {
  /** When false, only refresh an existing outdated block (never create/append). */
  create: boolean;
}

const CONTINUE_RULE_NAME = "bhived";

export async function installGlobalInstruction(
  agentId: GlobalTargetId,
  platform: TargetPlatform,
  options: WriteOptions
): Promise<GlobalInstructionResult> {
  const target = GLOBAL_INSTRUCTION_TARGETS[agentId];

  if (target.strategy === "skip") {
    return {
      agentId,
      label: target.label,
      status: "skipped",
      message: target.skipReason ?? "no global instructions file on disk.",
    };
  }

  const path = target.resolvePath(platform);
  const version = bhivedVersion();

  switch (target.strategy) {
    case "marker-md":
      return writeMarkerMarkdown(target, path, version, options, target.frontmatter ?? "");
    case "continue-yaml":
      return writeContinueRule(target, path, version, options);
    default:
      return { agentId, label: target.label, status: "skipped", message: "unsupported strategy" };
  }
}

/** Update every agent whose global instructions file already carries an OUTDATED bhived block. */
export async function refreshOutdatedInstructions(platform: TargetPlatform): Promise<GlobalInstructionResult[]> {
  const results: GlobalInstructionResult[] = [];
  for (const agentId of Object.keys(GLOBAL_INSTRUCTION_TARGETS) as GlobalTargetId[]) {
    if (GLOBAL_INSTRUCTION_TARGETS[agentId].strategy === "skip") continue;
    try {
      const result = await installGlobalInstruction(agentId, platform, { create: false });
      if (result.status === "updated") results.push(result);
    } catch {
      // Best-effort: never let instruction refresh break a CLI command.
    }
  }
  return results;
}

async function writeMarkerMarkdown(
  target: GlobalInstructionTarget,
  path: string,
  version: string,
  options: WriteOptions,
  frontmatter = ""
): Promise<GlobalInstructionResult> {
  const block = bhivedInstructionsBlock(version);
  const existing = await readTextIfExists(path);

  if (existing === null) {
    if (!options.create) {
      return skip(target, "not present (run `bhived setup` to create it)");
    }
    await writeText(path, ensureTrailingNewline(frontmatter + block));
    return { agentId: target.agentId, label: target.label, status: "written", path, message: path };
  }

  if (hasBhivedSection(existing)) {
    const embedded = extractEmbeddedVersion(existing);
    if (embedded === version) {
      return { agentId: target.agentId, label: target.label, status: "up-to-date", path, message: path };
    }
    const updated = replaceMarkedSection(existing, block);
    await writeText(path, ensureTrailingNewline(updated));
    return {
      agentId: target.agentId,
      label: target.label,
      status: "updated",
      path,
      message: `${embedded ?? "?"} -> ${version} (${path})`,
    };
  }

  // File exists but has no bhived block.
  if (!options.create) {
    return skip(target, "present without a bhived block (run `bhived setup` to add it)");
  }

  if (frontmatter && !existing.trimStart().startsWith("---")) {
    // Dedicated VS Code instructions file without frontmatter: rewrite with it.
    await writeText(path, ensureTrailingNewline(`${frontmatter}${existing.trim() ? `${existing.trim()}\n\n` : ""}${block}`));
  } else {
    await writeText(path, ensureTrailingNewline(`${existing.trimEnd()}\n\n---\n\n${block}`));
  }
  return { agentId: target.agentId, label: target.label, status: "written", path, message: path };
}

async function writeContinueRule(
  target: GlobalInstructionTarget,
  path: string,
  version: string,
  options: WriteOptions
): Promise<GlobalInstructionResult> {
  const block = bhivedInstructionsBlock(version);
  const existing = await readTextIfExists(path);

  if (existing === null && !options.create) {
    return skip(target, "not present (run `bhived setup` to create it)");
  }

  const source = existing && existing.trim()
    ? existing
    : "name: Bhived Continue Config\nversion: 1.0.0\nschema: v1\n";
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    return skip(target, `existing config is not valid YAML: ${path}`);
  }

  const config = (document.toJS() as Record<string, unknown> | null) ?? {};
  if (typeof config !== "object" || Array.isArray(config)) {
    return skip(target, `existing config must be a YAML object: ${path}`);
  }

  const rules = Array.isArray(config.rules) ? config.rules : [];
  const current = rules.find(
    (rule): rule is Record<string, unknown> =>
      typeof rule === "object" && rule !== null && !Array.isArray(rule) && rule.name === CONTINUE_RULE_NAME
  );

  if (current) {
    const embedded = extractEmbeddedVersion(String(current.rule ?? ""));
    if (embedded === version) {
      return { agentId: target.agentId, label: target.label, status: "up-to-date", path, message: path };
    }
    config.rules = rules.map((rule) =>
      typeof rule === "object" && rule !== null && !Array.isArray(rule) && (rule as Record<string, unknown>).name === CONTINUE_RULE_NAME
        ? { name: CONTINUE_RULE_NAME, rule: block }
        : rule
    );
    document.contents = document.createNode(config) as ParsedNode;
    await writeText(path, ensureTrailingNewline(document.toString({ lineWidth: 0 })));
    return {
      agentId: target.agentId,
      label: target.label,
      status: "updated",
      path,
      message: `${embedded ?? "?"} -> ${version} (${path})`,
    };
  }

  if (!options.create) {
    return skip(target, "present without a bhived rule (run `bhived setup` to add it)");
  }

  config.rules = [...rules, { name: CONTINUE_RULE_NAME, rule: block }];
  document.contents = document.createNode(config) as ParsedNode;
  await writeText(path, ensureTrailingNewline(document.toString({ lineWidth: 0 })));
  return { agentId: target.agentId, label: target.label, status: "written", path, message: path };
}

function skip(target: GlobalInstructionTarget, message: string): GlobalInstructionResult {
  return { agentId: target.agentId, label: target.label, status: "skipped", path: undefined, message };
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf-8", mode: constants.S_IRUSR | constants.S_IWUSR });
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
