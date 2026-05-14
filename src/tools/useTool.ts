/**
 * bhived_use_tool Tool
 *
 * Proxies tool calls to child MCP processes. This is the
 * Level 3 (default) tool delivery mechanism — agents call child
 * MCP tools through this single proxy tool.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { childMcpRegistry } from "../registries/childMcpRegistry.js";

const UseToolInputSchema = z.object({
    mcp: z
        .string()
        .min(1)
        .describe("Name of the child MCP server."),
    tool: z
        .string()
        .min(1)
        .describe("Name of the tool to call."),
    params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Parameters to pass to the tool (as a JSON object)."),
}).strict();

type UseToolInput = z.infer<typeof UseToolInputSchema>;

const USE_TOOL_DESCRIPTION = `Execute a tool from an activated MCP server. Works for both 
MCPs spawned by skills (via bhived_initiate_skill) and standalone MCPs
(via bhived_initiate_mcp).

Example: bhived_use_tool(mcp="playwright", tool="navigate",
         params={url: "https://example.com"})`;

export function registerUseToolTool(server: McpServer): void {
    server.registerTool(
        "bhived_use_tool",
        {
            title: "Use MCP Tool",
            description: USE_TOOL_DESCRIPTION,
            inputSchema: UseToolInputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async (params: UseToolInput) => {
            try {
                // 1. Look up the child MCP
                const entry = childMcpRegistry.get(params.mcp);
                if (!entry) {
                    // List available MCPs to help the agent
                    const available = childMcpRegistry.names();
                    const availableList = available.length > 0
                        ? `\n\nAvailable MCPs: ${available.map((n) => `\`${n}\``).join(", ")}`
                        : "\n\nNo MCPs currently active. Use bhived_initiate_mcp or bhived_initiate_skill to activate one.";

                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ No active MCP named '${params.mcp}'. Use bhived_list_active to see what's available.${availableList}`,
                            },
                        ],
                        isError: true,
                    };
                }

                // 2. Verify the MCP is healthy
                if (entry.status === "crashed") {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ MCP '${params.mcp}' has crashed and is no longer responding. Try restarting it.`,
                            },
                        ],
                        isError: true,
                    };
                }

                // 3. Verify the tool exists
                const toolExists = entry.tools.some((t) => t.name === params.tool);
                if (!toolExists) {
                    const availableTools = entry.tools.map((t) => `\`${t.name}\``).join(", ");
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ Tool '${params.tool}' not found in MCP '${params.mcp}'.\n\nAvailable tools: ${availableTools || "none discovered"}`,
                            },
                        ],
                        isError: true,
                    };
                }

                // 4. Forward the tool call to the child MCP client
                const result = await entry.client.callTool({
                    name: params.tool,
                    arguments: params.params ?? {},
                });

                // 5. Return the result, preserving the child's response format
                if (result.content && Array.isArray(result.content)) {
                    return {
                        content: result.content.map((item) => {
                            if (typeof item === "object" && item !== null && "type" in item) {
                                return item as { type: "text"; text: string };
                            }
                            return { type: "text" as const, text: String(item) };
                        }),
                        isError: result.isError === true,
                    };
                }

                // Fallback: wrap raw result as text
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
                        },
                    ],
                };
            } catch (error: unknown) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error calling tool '${params.tool}' on MCP '${params.mcp}': ${error instanceof Error ? error.message : String(error)}`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );
}
