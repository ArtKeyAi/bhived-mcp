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

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { restClient } from "../client/restClient.js";
import { skillRegistry } from "../registries/skillRegistry.js";
import { resourceRegistry, ResourceRegistry } from "../registries/resourceRegistry.js";
import { childMcpManager } from "../childMcp/manager.js";
import type { ChildMcpTool } from "../registries/childMcpRegistry.js";
import type { McpConfig } from "../client/types.js";
import { config } from "../config.js";

// ── Input Schema ─────────────────────────────────────────────────

const InitiateSkillInputSchema = z.object({
    memory_id: z
        .string()
        .min(1)
        .describe("The bhived skill memory/capability ID to activate."),
}).strict();

type InitiateSkillInput = z.infer<typeof InitiateSkillInputSchema>;

// ── Tool Description ─────────────────────────────────────────────

const INITIATE_SKILL_DESCRIPTION = `Load and activate a skill from bhived shared memory.
Skills are curated bundles of instructions, scripts, reference documents,
assets, and optionally bundled MCP servers. Once activated, you gain access
to the skill's SKILL.md instructions and can use:
- bhived_run_script to execute the skill's scripts
- bhived_read_resource to read reference docs and assets
- bhived_use_tool for any bundled MCP tools

Example: bhived_initiate_skill(memory_id="mem_abc123")`;

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
            try {
                // Limit is automatically managed by the registry to the last 5 skills.

                // 2. Call backend to activate and get the payload
                const activation = await restClient.activateCapability(params.memory_id);

                // 3. Validate response
                if (!activation.ok) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ Backend declined activation for memory '${params.memory_id}'.`,
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
                                    `❌ Memory '${params.memory_id}' is a **${activation.capability_type}**, not a skill. ` +
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
                const skillName = payload.name;

                // 4. Normalize resource maps — backend may return keys with
                //    type-prefix (e.g. "scripts/generate.py" in the scripts dict).
                //    Strip the prefix so lookups work with plain filenames.
                const cleanScripts = stripTypePrefix("scripts", payload.scripts ?? {});
                const cleanRefs = stripTypePrefix("references", payload.references ?? {});
                const cleanAssets = stripTypePrefix("assets", payload.assets ?? {});

                // 5. Check if already active (idempotent re-activation)
                if (skillRegistry.has(skillName)) {
                    const existing = skillRegistry.get(skillName)!;
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: formatSkillOutput(
                                    skillName,
                                    existing.skill_md,
                                    existing.scripts,
                                    existing.references,
                                    existing.assets,
                                    existing.mcp_names,
                                    true
                                ),
                            },
                        ],
                    };
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
                                    memory_id: params.memory_id,
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
                                `⚠️ Failed to spawn bundled MCP '${mcpConfig.name}': ${msg}`
                            );
                            console.error(
                                `[initiateSkill] Failed to spawn bundled MCP '${mcpConfig.name}': ${msg}`
                            );
                        }
                    }
                }

                // 8. Register skill in SkillRegistry (with cleaned keys)
                skillRegistry.add({
                    memory_id: params.memory_id,
                    name: skillName,
                    skill_md: payload.skill_md,
                    scripts: cleanScripts,
                    references: cleanRefs,
                    assets: cleanAssets,
                    mcp_names: spawnedMcpNames,
                    activated_at: new Date(),
                    status: "active",
                });

                // 8. Fire-and-forget activation tracking
                restClient
                    .reportCapability(params.memory_id, {
                        success: true,
                    })
                    .catch((err: unknown) => {
                        console.error(
                            `[initiateSkill] Failed to report activation: ${err instanceof Error ? err.message : String(err)}`
                        );
                    });

                // 10. Build and return output
                const output = formatSkillOutput(
                    skillName,
                    payload.skill_md,
                    cleanScripts,
                    cleanRefs,
                    cleanAssets,
                    spawnedMcpNames,
                    false,
                    allBundledTools,
                    mcpErrors
                );

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: output,
                        },
                    ],
                };
            } catch (error: unknown) {
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

// ── Helpers ──────────────────────────────────────────────────────

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
    skillMd: string,
    scripts: Record<string, string>,
    references: Record<string, string>,
    assets: Record<string, string>,
    mcpNames: string[],
    isReactivation: boolean,
    bundledTools?: Array<{ mcpName: string; tools: ChildMcpTool[] }>,
    mcpErrors?: string[]
): string {
    const lines: string[] = [];

    // Header
    if (isReactivation) {
        lines.push(`## ♻️ Skill Already Active: ${skillName}\n`);
        lines.push(`This skill is already activated. Here are its instructions:\n`);
    } else {
        lines.push(`## ✅ Skill Activated: ${skillName}\n`);
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

    return lines.join("\n");
}
