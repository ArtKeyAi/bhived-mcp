/**
 * bhived_initiate_skill Tool
 *
 * Activates a skill from the Bhived backend, registers it in
 * the SkillRegistry, populates the ResourceRegistry, and spawns
 * any bundled child MCPs via the ChildMcpManager.
 *
 * Returns the full SKILL.md content along with resource listings
 * and bundled MCP tool tables so the agent can immediately use them.
 */

import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { restClient } from "../client/restClient.js";
import { skillRegistry } from "../registries/skillRegistry.js";
import { resourceRegistry, ResourceRegistry } from "../registries/resourceRegistry.js";
import { childMcpManager } from "../childMcp/manager.js";
import { childMcpRegistry } from "../registries/childMcpRegistry.js";
import { ChildMcpPrerequisiteError, missingEnvHelp, normalizeRequirements } from "../childMcp/env.js";
import type { ChildMcpTool } from "../registries/childMcpRegistry.js";
import type { McpConfig, SkillPayload } from "../client/types.js";
import { config } from "../config.js";
import { asRecord, formatQualitySignals } from "../formatters/capabilityFormatter.js";
import {
    BhivedIdInputSchema,
    resolveBhivedId,
    type BhivedIdInput,
} from "./bhivedId.js";
import { markActivated } from "./reportOutcome.js";

// ── Input Schema ─────────────────────────────────────────────────

const InitiateSkillInputSchema = BhivedIdInputSchema;
type InitiateSkillInput = BhivedIdInput;

// ── Tool Description ─────────────────────────────────────────────

const INITIATE_SKILL_DESCRIPTION = `Load and activate a skill discovered through Bhived.
Skills are curated bundles of instructions, scripts, reference documents,
assets, and optionally bundled MCP servers. Once activated, you gain access
to the skill's SKILL.md instructions and can use:
- bhived_run_script to execute the skill's scripts
- bhived_read_resource to read reference docs and assets
- bhived_use_tool for any bundled MCP tools

Calling this again for an active skill re-fetches it and reloads it if the
server's copy changed since you activated it.

Pass bhived_id. The deprecated memory_id alias is accepted for compatibility.

Example: bhived_initiate_skill(bhived_id="mem_abc123")`;

// ── Registration ─────────────────────────────────────────────────

export function registerInitiateSkillTool(server: McpServer): void {
    server.registerTool(
        "bhived_initiate_skill",
        {
            title: "Initiate Skill",
            description: INITIATE_SKILL_DESCRIPTION,
            inputSchema: InitiateSkillInputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: InitiateSkillInput) => {
            const bhivedId = resolveBhivedId(params);
            try {
                // Limit is automatically managed by the registry to the last 5 skills.

                // 2. Call backend to activate and get the payload
                const activation = await restClient.activateCapability(bhivedId);

                // 3. Validate response
                if (!activation.ok) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ Backend declined activation for Bhived item '${bhivedId}'.`,
                            },
                        ],
                        isError: true,
                    };
                }

                if (activation.capability_type !== "skill") {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    `❌ Bhived item '${bhivedId}' is a **${activation.capability_type}**, not a skill. ` +
                                    `Use \`bhived_initiate_mcp\` instead.`,
                            },
                        ],
                        isError: true,
                    };
                }

                if (!activation.skill_payload) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ Activation succeeded but no skill payload was returned. The backend may be misconfigured.`,
                            },
                        ],
                        isError: true,
                    };
                }

                const payload = activation.skill_payload;
                // One activation per skill at a time: overlapping calls would both
                // stop and respawn its bundled MCPs and orphan a process.
                return await withSkillLock(payload.name, () => loadSkill(bhivedId, payload));
            } catch (error: unknown) {
                const statusCode = (error as { statusCode?: number }).statusCode;
                if (statusCode === 404) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    `❌ Skill '${bhivedId}' is not available to this API key/tenant. ` +
                                    `Capabilities outside your readable hives return 404 (treated as nonexistent, ` +
                                    `not "forbidden"). Don't assume an ID seen under another key/team is activatable here — ` +
                                    `query with this key (or use bhived_list_active) to see which capabilities you can use.`,
                            },
                        ],
                        isError: true,
                    };
                }
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `❌ Error activating skill: ${error instanceof Error ? error.message : String(error)}`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );
}

// ── Loading ──────────────────────────────────────────────────────

const skillLocks = new Map<string, Promise<unknown>>();

/** Run activations of the same skill one at a time. */
async function withSkillLock<T>(skillName: string, task: () => Promise<T>): Promise<T> {
    const run = (skillLocks.get(skillName) ?? Promise.resolve()).then(task);
    const settled = run.catch(() => undefined);
    skillLocks.set(skillName, settled);
    try {
        return await run;
    } finally {
        if (skillLocks.get(skillName) === settled) skillLocks.delete(skillName);
    }
}

async function loadSkill(bhivedId: string, payload: SkillPayload) {
    const skillName = payload.name;

    // 4. Normalize resource maps — backend may return keys with
    //    type-prefix (e.g. "scripts/generate.py" in the scripts dict).
    //    Strip the prefix so lookups work with plain filenames.
    const cleanScripts = stripTypePrefix("scripts", payload.scripts ?? {});
    const cleanRefs = stripTypePrefix("references", payload.references ?? {});
    const cleanAssets = stripTypePrefix("assets", payload.assets ?? {});
    // Activation responses carry no version hash, so compare what an agent can
    // observe. Hashed over the normalized maps so key order or "scripts/"
    // prefixes alone never count as a change.
    const contentHash = fingerprint([
        payload.description ?? "",
        payload.skill_md ?? "",
        cleanScripts,
        cleanRefs,
        cleanAssets,
        payload.mcp_configs ?? [],
    ]);
    const mcpHash = fingerprint(payload.mcp_configs ?? []);
    markActivated(bhivedId, "skill");

    // 5. Already active: unchanged → serve the cached copy; changed on
    //    the server (or another skill with the same name) → reload.
    let mode: SkillOutputMode = { kind: "activation" };
    const existing = skillRegistry.get(skillName);
    if (existing) {
        const unchanged = existing.memory_id === bhivedId && existing.content_hash === contentHash;
        // A bundled MCP that isn't running (e.g. its key was missing last time)
        // is retried on re-activation rather than serving the cached copy.
        const bundledDown = (payload.mcp_configs ?? [])
            .slice(0, config.maxBundledMcps)
            .some((mcp) => childMcpRegistry.get(mcp.name)?.status !== "active");
        if (unchanged && !bundledDown) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: formatSkillOutput(
                            skillName,
                            bhivedId,
                            existing.skill_md,
                            existing.scripts,
                            existing.references,
                            existing.assets,
                            existing.mcp_names,
                            { kind: "reactivation" }
                        ),
                    },
                ],
            };
        }
        mode = unchanged
            ? { kind: "reactivation" }
            : existing.memory_id === bhivedId
                ? { kind: "updated" }
                : { kind: "replaced", previousId: existing.memory_id };
        // Bundled MCPs keep running (and keep their state) unless their own
        // configuration changed; the spawn loop below reuses running ones.
        if (mode.kind === "replaced" || existing.mcp_hash !== mcpHash) {
            await childMcpManager.stopBySkill(skillName);
        }
        resourceRegistry.removeBySkill(skillName);
        skillRegistry.remove(skillName);
    }

    // 6. Register all resources in ResourceRegistry
    const resourceTypes: Array<{ type: string; map: Record<string, string> }> = [
        { type: "scripts", map: cleanScripts },
        { type: "references", map: cleanRefs },
        { type: "assets", map: cleanAssets },
    ];

    for (const { type, map } of resourceTypes) {
        for (const [filename, content] of Object.entries(map)) {
            const uri = ResourceRegistry.buildUri(skillName, type, filename);
            const mimeType = ResourceRegistry.inferMimeType(filename);
            resourceRegistry.add(uri, {
                content,
                mimeType,
                source_skill: skillName,
            });
        }
    }

    // 6. Spawn bundled MCPs (if any)
    const spawnedMcpNames: string[] = [];
    const allBundledTools: Array<{ mcpName: string; tools: ChildMcpTool[] }> = [];
    const mcpErrors: string[] = [];

    if (payload.mcp_configs && payload.mcp_configs.length > 0) {
        // Enforce per-skill bundled MCP limit
        const configsToSpawn = payload.mcp_configs.slice(0, config.maxBundledMcps);
        if (payload.mcp_configs.length > config.maxBundledMcps) {
            mcpErrors.push(
                `⚠️ Skill declares ${payload.mcp_configs.length} bundled MCPs but max is ${config.maxBundledMcps}. ` +
                `Only the first ${config.maxBundledMcps} will be spawned.`
            );
        }

        for (const mcpConfig of configsToSpawn) {
            try {
                const result = await childMcpManager.spawn(
                    mcpConfig as McpConfig,
                    {
                        source: `skill:${skillName}`,
                        memory_id: bhivedId,
                    }
                );
                spawnedMcpNames.push(result.name);
                allBundledTools.push({
                    mcpName: result.name,
                    tools: result.tools,
                });
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                mcpErrors.push(
                    error instanceof ChildMcpPrerequisiteError
                        ? `⚠️ Bundled MCP '${mcpConfig.name}' not started — ${msg.replace(/\n/g, "; ")}. ` +
                          (error.missing.length > 0 ? missingEnvHelp() : "")
                        : `⚠️ Failed to spawn bundled MCP '${mcpConfig.name}': ${msg}`
                );
                console.error(
                    `[initiateSkill] Failed to spawn bundled MCP '${mcpConfig.name}': ${msg}`
                );
            }
        }
    }

    // 8. Register skill in SkillRegistry (with cleaned keys). The registry keeps
    //    the most recent few; fully unload whichever skill it pushes out, or its
    //    MCPs keep running and a later activation would reuse its stale copies.
    const evicted = skillRegistry.add({
        memory_id: bhivedId,
        name: skillName,
        skill_md: payload.skill_md,
        scripts: cleanScripts,
        references: cleanRefs,
        assets: cleanAssets,
        mcp_names: spawnedMcpNames,
        // Untrusted payload: keep well-formed names only, never BHIVED_*.
        env_requirements: normalizeRequirements(
            payload.env_requirements ?? payload.metadata?.env_requirements
        ),
        activated_at: new Date(),
        status: "active",
        content_hash: contentHash,
        mcp_hash: mcpHash,
    });
    if (evicted) {
        await childMcpManager.stopBySkill(evicted.name);
        resourceRegistry.removeBySkill(evicted.name);
    }

    // 8. No outcome report here: activating says nothing about whether
    //    the skill works. Scripts exiting 0 or bhived_report_outcome do.

    // 9. Build and return output
    const output = formatSkillOutput(
        skillName,
        bhivedId,
        payload.skill_md,
        cleanScripts,
        cleanRefs,
        cleanAssets,
        spawnedMcpNames,
        mode,
        allBundledTools,
        mcpErrors,
        formatQualitySignals(asRecord(payload.metadata))
    );

    return {
        content: [
            {
                type: "text" as const,
                text: output,
            },
        ],
    };
}

// ── Helpers ──────────────────────────────────────────────────────

type SkillOutputMode =
    | { kind: "activation" }
    | { kind: "reactivation" }
    | { kind: "updated" }
    | { kind: "replaced"; previousId: string };

/** sha256 of a JSON value with object keys sorted, so key order never matters. */
function fingerprint(value: unknown): string {
    const sorted = JSON.stringify(value, (_key, v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : v
    );
    return createHash("sha256").update(sorted).digest("hex");
}

/**
 * Strip type-prefix from resource map keys.
 * Backend may return keys like "scripts/generate.py" inside the scripts dict.
 * We normalize to just "generate.py" so lookups by plain filename work.
 */
function stripTypePrefix(
    type: string,
    map: Record<string, string>
): Record<string, string> {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) {
        const cleanKey = key.startsWith(`${type}/`)
            ? key.slice(type.length + 1)
            : key;
        cleaned[cleanKey] = value;
    }
    return cleaned;
}

function formatSkillOutput(
    skillName: string,
    bhivedId: string,
    skillMd: string,
    scripts: Record<string, string>,
    references: Record<string, string>,
    assets: Record<string, string>,
    mcpNames: string[],
    mode: SkillOutputMode,
    bundledTools?: Array<{ mcpName: string; tools: ChildMcpTool[] }>,
    mcpErrors?: string[],
    qualitySignals?: string | null
): string {
    const lines: string[] = [];

    // Header
    switch (mode.kind) {
        case "reactivation":
            lines.push(`## ♻️ Skill Already Active: ${skillName}\n`);
            lines.push(`This skill is already activated and unchanged on the server. Here are its instructions:\n`);
            break;
        case "updated":
            lines.push(`## 🔄 Skill Updated: ${skillName}\n`);
            lines.push(
                `The server's copy changed since you activated it, so it was reloaded. ` +
                `Use these instructions and resources instead of the earlier ones:\n`
            );
            break;
        case "replaced":
            lines.push(`## 🔄 Skill Activated: ${skillName}\n`);
            lines.push(
                `This replaces a different skill with the same name (bhived_id \`${mode.previousId}\`) ` +
                `that was active before. Use these instructions instead of the earlier ones:\n`
            );
            break;
        default:
            lines.push(`## ✅ Skill Activated: ${skillName}\n`);
    }
    if (qualitySignals) {
        lines.push(`${qualitySignals}\n`);
    }

    // Full SKILL.md content
    lines.push(skillMd);
    lines.push("\n---");

    // Resources table
    const hasResources =
        Object.keys(scripts).length > 0 ||
        Object.keys(references).length > 0 ||
        Object.keys(assets).length > 0;

    if (hasResources) {
        lines.push("\n### Available Resources\n");
        lines.push("| Type | Path | Access |");
        lines.push("|------|------|--------|");

        for (const [filename] of Object.entries(scripts)) {
            lines.push(
                `| script | scripts/${filename} | \`bhived_run_script(skill="${skillName}", script="${filename}")\` |`
            );
        }
        for (const [filename] of Object.entries(references)) {
            lines.push(
                `| reference | references/${filename} | \`bhived_read_resource(skill="${skillName}", path="references/${filename}")\` |`
            );
        }
        for (const [filename] of Object.entries(assets)) {
            lines.push(
                `| asset | assets/${filename} | \`bhived_read_resource(skill="${skillName}", path="assets/${filename}")\` |`
            );
        }
    }

    // Bundled MCP tools table
    if (bundledTools && bundledTools.length > 0) {
        lines.push("\n### Bundled MCP Tools (spawned automatically)\n");
        lines.push("| MCP | Tool | Description |");
        lines.push("|-----|------|-------------|");

        for (const { mcpName, tools } of bundledTools) {
            for (const tool of tools) {
                const desc = tool.description
                    ? tool.description.split("\n")[0].substring(0, 80)
                    : "—";
                lines.push(
                    `| ${mcpName} | \`${tool.name}\` | ${desc} |`
                );
            }
        }

        lines.push(
            `\n> Use \`bhived_use_tool(mcp="<name>", tool="<tool>", params={...})\` to call these tools.`
        );
    } else if (mcpNames.length > 0) {
        lines.push(`\n### Bundled MCPs: ${mcpNames.map((n) => `\`${n}\``).join(", ")}`);
    }

    // MCP spawn errors/warnings
    if (mcpErrors && mcpErrors.length > 0) {
        lines.push("\n### ⚠️ MCP Spawn Warnings\n");
        for (const err of mcpErrors) {
            lines.push(`- ${err}`);
        }
    }

    lines.push(
        `\n> After using this skill for your task, report whether it worked: ` +
        `\`bhived_report_outcome(bhived_id="${bhivedId}", success=true|false)\`. ` +
        `Scripts that exit 0 are reported as successes automatically.`
    );

    return lines.join("\n");
}
