/**
 * bhived_initiate_mcp Tool
 *
 * Activates an MCP from the bhived backend,
 * spawns it as a child process via the ChildMcpManager,
 * discovers its tools, and returns usage instructions.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { restClient } from "../client/restClient.js";
import { childMcpRegistry } from "../registries/childMcpRegistry.js";
import { childMcpManager } from "../childMcp/manager.js";
import type { ChildMcpTool } from "../registries/childMcpRegistry.js";
import { config } from "../config.js";
import type { ActivationResponse, McpPayload } from "../client/types.js";
import {
    ChildMcpPrerequisiteError,
    missingEnvHelp,
    normalizeRequirements,
} from "../childMcp/env.js";
import {
    asRecord,
    formatEnvRequirements,
    formatHeaderRequirements,
    formatQualitySignals,
} from "../formatters/capabilityFormatter.js";
import {
    BhivedIdInputSchema,
    resolveBhivedId,
    type BhivedIdInput,
} from "./bhivedId.js";

// ── Input Schema ─────────────────────────────────────────────────

const InitiateMcpInputSchema = BhivedIdInputSchema;
type InitiateMcpInput = BhivedIdInput;

// ── Tool Description ─────────────────────────────────────────────

const INITIATE_MCP_DESCRIPTION = `Activate and spawn an MCP server discovered through Bhived.
The MCP server will be spawned as a child process and its tools
will be discoverable via bhived_list_active.

Use bhived_use_tool to call the spawned MCP's tools.

Some MCPs need API keys (shown as "Requires" in bhived_query results). Only the
declared variables are passed to the child, read from this server's environment
or ~/.bhived/secrets.json. If a required one is missing the MCP is not launched
and the result names the missing variable — prefer an MCP you can run.

Pass bhived_id. The deprecated memory_id alias is accepted for compatibility.

Example: bhived_initiate_mcp(bhived_id="mem_ghi789")`;

// ── Registration ─────────────────────────────────────────────────

export function registerInitiateMcpTool(server: McpServer): void {
    server.registerTool(
        "bhived_initiate_mcp",
        {
            title: "Initiate MCP",
            description: INITIATE_MCP_DESCRIPTION,
            inputSchema: InitiateMcpInputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: InitiateMcpInput) => {
            const bhivedId = resolveBhivedId(params);
            let activation: ActivationResponse | undefined;
            try {
                // 1. Check standalone MCP limit
                const standaloneCount = childMcpRegistry.countBySource("standalone");
                if (standaloneCount >= config.maxStandaloneMcps) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    `❌ Maximum standalone MCP limit reached (${config.maxStandaloneMcps}). ` +
                                    `Stop an MCP with bhived_stop_mcp before spawning another.\n\n` +
                                    `Active standalone MCPs: ${childMcpRegistry
                                        .listBySource("standalone")
                                        .map((e) => `\`${e.config.name}\``)
                                        .join(", ")}`,
                            },
                        ],
                        isError: true,
                    };
                }

                // 2. Check total child process limit
                if (childMcpRegistry.count() >= config.maxChildProcesses) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    `❌ Maximum total child process limit reached (${config.maxChildProcesses}). ` +
                                    `Stop an MCP to free resources.`,
                            },
                        ],
                        isError: true,
                    };
                }

                // 3. Call backend to activate and get the payload
                activation = await restClient.activateCapability(bhivedId);

                // 4. Validate response
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

                if (activation.capability_type !== "mcp") {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    `❌ Bhived item '${bhivedId}' is a **${activation.capability_type}**, not an MCP. ` +
                                    `Use \`bhived_initiate_skill\` instead.`,
                            },
                        ],
                        isError: true,
                    };
                }

                if (!activation.mcp_payload) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ Activation succeeded but no MCP payload was returned. The backend may be misconfigured.`,
                            },
                        ],
                        isError: true,
                    };
                }

                const payload = activation.mcp_payload;
                const mcpName = payload.name;

                // ── Debug: log payload for diagnostics ──
                console.error(
                    `[initiateMcp] Payload received for '${mcpName}':\n` +
                    `  command: ${payload.command}\n` +
                    `  args: ${JSON.stringify(payload.args)}\n` +
                    `  env requirements: ${JSON.stringify(normalizeRequirements(payload.env_requirements).map((r) => r.name))}\n` +
                    `  tools_hint: ${JSON.stringify(payload.tools_hint)}`
                );

                // 5. Check if already running (idempotent)
                if (childMcpRegistry.has(mcpName)) {
                    const existing = childMcpRegistry.get(mcpName)!;
                    if (existing.status === "active") {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: formatMcpOutput(payload, existing.tools, true),
                                },
                            ],
                        };
                    }
                    // If crashed, we'll respawn below (manager handles cleanup)
                }

                // 6. Spawn via ChildMcpManager. Missing keys/binaries are this
                //    machine's problem, not the MCP's — refuse without reporting.
                let spawnResult;
                try {
                    spawnResult = await childMcpManager.spawn(payload, {
                        source: "standalone",
                        memory_id: bhivedId,
                    });
                } catch (error: unknown) {
                    if (error instanceof ChildMcpPrerequisiteError) {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: formatPrerequisiteError(payload, error),
                                },
                            ],
                            isError: true,
                        };
                    }
                    throw error;
                }

                // 7. Fire-and-forget activation tracking
                restClient
                    .reportCapability(bhivedId, {
                        success: true,
                    })
                    .catch((err: unknown) => {
                        console.error(
                            `[initiateMcp] Failed to report activation: ${err instanceof Error ? err.message : String(err)}`
                        );
                    });

                // 8. Return output with tool listing
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: formatMcpOutput(payload, spawnResult.tools, false),
                        },
                    ],
                };
            } catch (error: unknown) {
                const statusCode = (error as { statusCode?: number }).statusCode;
                if (statusCode === 404) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    `❌ MCP '${bhivedId}' is not available to this API key/tenant. ` +
                                    `Capabilities outside your readable hives return 404 (treated as nonexistent, ` +
                                    `not "forbidden"). Don't assume an ID seen under another key/team is activatable here — ` +
                                    `query with this key (or use bhived_list_active) to see which capabilities you can use.`,
                            },
                        ],
                        isError: true,
                    };
                }

                const errorMsg = error instanceof Error ? error.message : String(error);

                // Include debug info about what we tried to spawn
                const debugInfo = activation?.mcp_payload
                    ? `\n\n**Debug payload:**\n` +
                      `- command: \`${activation.mcp_payload.command}\`\n` +
                      `- args: \`${JSON.stringify(activation.mcp_payload.args)}\`\n` +
                      `- env requirements: ${normalizeRequirements(activation.mcp_payload.env_requirements).map((r) => r.name).join(", ") || "(none)"}\n` +
                      `- name: ${activation.mcp_payload.name}`
                    : "";

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `❌ Error spawning MCP: ${errorMsg}${debugInfo}`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );
}

// ── Formatting helpers ───────────────────────────────────────────

function formatPrerequisiteError(payload: McpPayload, error: ChildMcpPrerequisiteError): string {
    const lines = [`## ❌ MCP Not Started: ${payload.name}\n`, error.message, ""];
    if (error.missing.length > 0) {
        lines.push(missingEnvHelp());
        lines.push("");
        lines.push(
            "Ask the user for the value — never invent one — or pick a different MCP from your " +
            "bhived_query results whose requirements are already set."
        );
    }
    return lines.join("\n");
}

function formatMcpOutput(
    payload: McpPayload,
    tools: ChildMcpTool[],
    isReconnection: boolean
): string {
    const mcpName = payload.name;
    const lines: string[] = [];

    // Header
    if (isReconnection) {
        lines.push(`## ♻️ MCP Already Running: ${mcpName}\n`);
        lines.push(`This MCP is already spawned and active.\n`);
    } else {
        lines.push(`## ✅ MCP Spawned: ${mcpName}\n`);
    }

    // Description
    if (payload.description) {
        lines.push(payload.description);
        lines.push("");
    }

    const details = [
        formatEnvRequirements(payload.env_requirements),
        formatHeaderRequirements(payload.header_requirements),
        formatQualitySignals(asRecord(payload.metadata)),
    ].filter((line): line is string => line !== null);
    if (details.length > 0) {
        lines.push(details.join("\n"));
        lines.push("");
    }

    // Tools table
    if (tools.length > 0) {
        lines.push("### Available Tools\n");
        lines.push("| Tool | Description |");
        lines.push("|------|-------------|");

        for (const tool of tools) {
            const desc = tool.description
                ? tool.description.split("\n")[0].substring(0, 100)
                : "—";
            lines.push(`| \`${tool.name}\` | ${desc} |`);
        }

        lines.push("");
        lines.push("### Usage\n");
        lines.push("Call tools via the proxy:\n");
        lines.push("```");
        lines.push(
            `bhived_use_tool(mcp="${mcpName}", tool="<tool_name>", params={...})`
        );
        lines.push("```");
    } else {
        lines.push(
            "\n> ⚠️ No tools discovered from this MCP. It may need additional configuration."
        );
    }

    return lines.join("\n");
}
