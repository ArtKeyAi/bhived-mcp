/**
 * bhived_list_active Tool
 *
 * Shows all currently active skills, standalone MCPs, their resources,
 * and available tools. Gives the agent a clear inventory of what's loaded.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { skillRegistry } from "../registries/skillRegistry.js";
import { childMcpRegistry } from "../registries/childMcpRegistry.js";
import { resourceRegistry } from "../registries/resourceRegistry.js";

const ListActiveInputSchema = z.object({
    type: z
        .enum(["skills", "mcps", "resources", "all"])
        .default("all")
        .describe('Filter by type: "skills", "mcps", "resources", or "all" (default: "all").'),
}).strict();

type ListActiveInput = z.infer<typeof ListActiveInputSchema>;

const LIST_ACTIVE_DESCRIPTION = `Show all currently active skills, standalone MCPs, their 
resources, and available tools. Use to see what capabilities are loaded.

Returns a breakdown of:
- Active skills with their scripts, references, assets, and bundled MCPs
- Standalone MCP servers and their discovered tools
- All available MCP tools across child MCPs
- All registered resources from active skills`;

export function registerListActiveTool(server: McpServer): void {
    server.registerTool(
        "bhived_list_active",
        {
            title: "List Active Capabilities",
            description: LIST_ACTIVE_DESCRIPTION,
            inputSchema: ListActiveInputSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (params: ListActiveInput) => {
            try {
                const sections: string[] = [];
                const showAll = params.type === "all";

                // ── Skills section ──────────────────────────────────────
                if (showAll || params.type === "skills") {
                    const skills = skillRegistry.list();
                    if (skills.length === 0) {
                        sections.push("## 🔧 Active Skills\n\n*No skills currently active.*\n");
                    } else {
                        let skillSection = "## 🔧 Active Skills\n\n";
                        for (const skill of skills) {
                            const scriptCount = Object.keys(skill.scripts).length;
                            const refCount = Object.keys(skill.references).length;
                            const assetCount = Object.keys(skill.assets).length;
                            const mcpCount = skill.mcp_names.length;

                            skillSection += `### ${skill.name}\n`;
                            skillSection += `- **Status**: ${skill.status === "active" ? "✅ Active" : "⚠️ Error"}\n`;
                            skillSection += `- **Activated**: ${skill.activated_at.toISOString()}\n`;
                            skillSection += `- **Memory ID**: \`${skill.memory_id}\`\n`;
                            skillSection += `- **Resources**: ${scriptCount} scripts, ${refCount} references, ${assetCount} assets\n`;

                            if (scriptCount > 0) {
                                skillSection += `- **Scripts**: ${Object.keys(skill.scripts).map((s) => `\`${s}\``).join(", ")}\n`;
                            }
                            if (refCount > 0) {
                                skillSection += `- **References**: ${Object.keys(skill.references).map((r) => `\`${r}\``).join(", ")}\n`;
                            }
                            if (mcpCount > 0) {
                                skillSection += `- **Bundled MCPs**: ${skill.mcp_names.map((m) => `\`${m}\``).join(", ")}\n`;
                            }
                            skillSection += "\n";
                        }
                        sections.push(skillSection);
                    }
                }

                // ── MCPs section ────────────────────────────────────────
                if (showAll || params.type === "mcps") {
                    const mcps = childMcpRegistry.list();
                    if (mcps.length === 0) {
                        sections.push("## 🔌 Active MCPs\n\n*No child MCPs currently running.*\n");
                    } else {
                        let mcpSection = "## 🔌 Active MCPs\n\n";

                        // Group by source
                        const standalone = mcps.filter((m) => m.source === "standalone");
                        const skillBundled = mcps.filter((m) => m.source !== "standalone");

                        if (standalone.length > 0) {
                            mcpSection += "### Standalone MCPs\n\n";
                            mcpSection += "| Name | Status | Tools | Spawned |\n";
                            mcpSection += "|------|--------|-------|---------|\n";
                            for (const entry of standalone) {
                                const name = childMcpRegistry.names().find(
                                    (n) => childMcpRegistry.get(n) === entry
                                ) ?? "unknown";
                                const toolNames = entry.tools.map((t) => t.name).join(", ") || "–";
                                const status = entry.status === "active" ? "✅" : "💀";
                                mcpSection += `| ${name} | ${status} | ${toolNames} | ${entry.spawned_at.toISOString()} |\n`;
                            }
                            mcpSection += "\n";
                        }

                        if (skillBundled.length > 0) {
                            mcpSection += "### Skill-Bundled MCPs\n\n";
                            mcpSection += "| Name | Source | Status | Tools |\n";
                            mcpSection += "|------|--------|--------|-------|\n";
                            for (const entry of skillBundled) {
                                const name = childMcpRegistry.names().find(
                                    (n) => childMcpRegistry.get(n) === entry
                                ) ?? "unknown";
                                const toolNames = entry.tools.map((t) => t.name).join(", ") || "–";
                                const status = entry.status === "active" ? "✅" : "💀";
                                mcpSection += `| ${name} | ${entry.source} | ${status} | ${toolNames} |\n`;
                            }
                            mcpSection += "\n";
                        }

                        // Combined tools list
                        const allTools = mcps.flatMap((m) => {
                            const mcpName = childMcpRegistry.names().find(
                                (n) => childMcpRegistry.get(n) === m
                            ) ?? "unknown";
                            return m.tools.map((t) => ({
                                mcp: mcpName,
                                tool: t.name,
                                description: t.description,
                            }));
                        });

                        if (allTools.length > 0) {
                            mcpSection += "### All Available MCP Tools\n\n";
                            mcpSection += "| MCP | Tool | Description |\n";
                            mcpSection += "|-----|------|-------------|\n";
                            for (const t of allTools) {
                                const desc = t.description.length > 60
                                    ? t.description.slice(0, 57) + "..."
                                    : t.description;
                                mcpSection += `| ${t.mcp} | ${t.tool} | ${desc} |\n`;
                            }
                            mcpSection += "\n";
                        }

                        sections.push(mcpSection);
                    }
                }

                // ── Resources section ───────────────────────────────────
                if (showAll || params.type === "resources") {
                    const resources = resourceRegistry.list();
                    if (resources.length === 0) {
                        sections.push("## 📁 Registered Resources\n\n*No resources currently registered.*\n");
                    } else {
                        let resSection = "## 📁 Registered Resources\n\n";
                        resSection += "| Skill | Type | Path | MIME |\n";
                        resSection += "|-------|------|------|------|\n";
                        for (const r of resources) {
                            const shortUri = r.uri.replace("bhived://skill/", "");
                            const parts = shortUri.split("/");
                            const skill = parts[0];
                            const type = parts[1];
                            const path = parts.slice(1).join("/");
                            resSection += `| ${skill} | ${type} | ${path} | ${r.mimeType} |\n`;
                        }
                        resSection += "\n";
                        sections.push(resSection);
                    }
                }

                // ── Summary ─────────────────────────────────────────────
                const summary = `---\n📊 **Summary**: ${skillRegistry.count()} skills, ${childMcpRegistry.count()} child MCPs, ${resourceRegistry.count()} resources`;

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: sections.join("\n") + summary,
                        },
                    ],
                };
            } catch (error: unknown) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error listing active capabilities: ${error instanceof Error ? error.message : String(error)}`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );
}
