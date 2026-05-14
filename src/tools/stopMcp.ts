/**
 * bhived_stop_mcp Tool
 *
 * Stops an MCP process.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { childMcpRegistry } from "../registries/childMcpRegistry.js";
import { childMcpManager } from "../childMcp/manager.js";

// ── Input Schema ─────────────────────────────────────────────────

const StopMcpInputSchema = z.object({
    mcp: z
        .string()
        .min(1)
        .describe("Name of the MCP server to stop."),
}).strict();

type StopMcpInput = z.infer<typeof StopMcpInputSchema>;

// ── Tool Description ─────────────────────────────────────────────

const STOP_MCP_DESCRIPTION = `Stop a running MCP server and free its resources.

Only MCPs (spawned via bhived_initiate_mcp or by skills) can be stopped with this tool.

Example: bhived_stop_mcp(mcp="playwright")`;

// ── Registration ─────────────────────────────────────────────────

export function registerStopMcpTool(server: McpServer): void {
    server.registerTool(
        "bhived_stop_mcp",
        {
            title: "Stop MCP",
            description: STOP_MCP_DESCRIPTION,
            inputSchema: StopMcpInputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (params: StopMcpInput) => {
            try {
                // 1. Look up MCP in ChildMcpRegistry
                const entry = childMcpRegistry.get(params.mcp);
                if (!entry) {
                    const available = childMcpRegistry.names();
                    const availableList = available.length > 0
                        ? `\n\nActive MCPs: ${available.map((n) => `\`${n}\``).join(", ")}`
                        : "\n\nNo MCPs currently active.";

                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ No active MCP named '${params.mcp}'.${availableList}`,
                            },
                        ],
                        isError: true,
                    };
                }

                // Standalone restriction removed

                // 3. Capture info before stopping
                const toolCount = entry.tools.length;
                const toolNames = entry.tools.map((t) => t.name);

                // 4. Stop via ChildMcpManager
                await childMcpManager.stop(params.mcp);

                // 5. Build summary
                const lines: string[] = [];
                lines.push(`## ✅ MCP Stopped: ${params.mcp}\n`);
                lines.push("### Cleanup Summary\n");
                lines.push(`- 🔌 Process terminated`);
                lines.push(`- 🔧 ${toolCount} tool(s) removed: ${toolNames.map((n) => `\`${n}\``).join(", ") || "none"}`);

                // Show remaining capacity
                const remainingStandalone =
                    childMcpRegistry.countBySource("standalone");
                const remainingTotal = childMcpRegistry.count();
                lines.push(
                    `\n> ${remainingStandalone} standalone MCP(s) remaining. ${remainingTotal} total child process(es) active.`
                );

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: lines.join("\n"),
                        },
                    ],
                };
            } catch (error: unknown) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `❌ Error stopping MCP '${params.mcp}': ${error instanceof Error ? error.message : String(error)}`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );
}
