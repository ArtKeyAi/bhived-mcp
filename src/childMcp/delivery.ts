/**
 * Child MCP Tool Delivery — 3-Level Fallback
 *
 * Determines how discovered child MCP tools should be surfaced
 * to the calling agent, based on the client's capabilities.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Level │ When                        │ How                      │
 * │───────│─────────────────────────────│──────────────────────────│
 * │   1   │ Client supports listChanged │ Native tool registration │
 * │   2   │ Known-good client (curated) │ Register + instruct      │
 * │   3   │ Default / unknown client    │ via bhived_use_tool    │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * IMPORTANT: Default to Level 3 (proxy). Reliability > convenience.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChildMcpTool } from "../registries/childMcpRegistry.js";

// ── Types ────────────────────────────────────────────────────────

export type DeliveryLevel = 1 | 2 | 3;

export interface DeliveryResult {
    /** Which level was used */
    level: DeliveryLevel;
    /** Human-readable description of how tools are delivered */
    description: string;
    /** If level 1/2: the native tool names registered. If level 3: empty. */
    registeredToolNames: string[];
}

export interface DeliveryContext {
    /** The McpServer instance (for registering native tools at level 1/2) */
    server: McpServer;
    /** Whether the client declared tools.listChanged capability */
    clientSupportsListChanged: boolean;
    /** Name identifier of the client application */
    clientName?: string;
}

// ── Known-good clients (Level 2) ────────────────────────────────
// Curated list of client names known to handle tool list refresh.
// These clients can see newly registered tools if instructed to refresh.

const KNOWN_GOOD_CLIENTS: Set<string> = new Set([
    // Add client names here as they're verified to support refresh
    // Example: "cursor", "cline", "continue"
]);

// ── Delivery strategy ───────────────────────────────────────────

/**
 * Detect the appropriate delivery level based on client capabilities.
 */
export function detectDeliveryLevel(ctx: DeliveryContext): DeliveryLevel {
    // Level 1: Client explicitly supports tools.listChanged
    if (ctx.clientSupportsListChanged) {
        return 1;
    }

    // Level 2: Known-good client that handles refresh
    if (ctx.clientName && KNOWN_GOOD_CLIENTS.has(ctx.clientName.toLowerCase())) {
        return 2;
    }

    // Level 3: Default — everything goes through bhived_use_tool proxy
    return 3;
}

/**
 * Execute the delivery strategy for a set of child MCP tools.
 *
 * Level 1 (Native): Register each tool as `{mcpName}__{toolName}`
 *   and rely on the SDK to send `notifications/tools/list_changed`.
 *
 * Level 2 (Refresh): Same as Level 1, but also instruct the agent
 *   to refresh the tool list.
 *
 * Level 3 (Proxy): Don't register native tools — everything goes
 *   through `bhived_use_tool(mcp="...", tool="...", params={...})`.
 */
export function executeDelivery(
    level: DeliveryLevel,
    mcpName: string,
    tools: ChildMcpTool[],
    _ctx: DeliveryContext
): DeliveryResult {
    switch (level) {
        case 1:
            // For now, Level 1 is reserved for future implementation.
            // Registering tools natively at runtime requires the low-level
            // Server API (not McpServer), which has different lifecycle semantics.
            // We default down to Level 3 for safety.
            console.error(
                `[Delivery] Level 1 detected for '${mcpName}' but native registration ` +
                `is not yet implemented. Falling back to Level 3 (proxy).`
            );
            return {
                level: 3,
                description: formatProxyDescription(mcpName, tools),
                registeredToolNames: [],
            };

        case 2:
            // Similar to Level 1: requires runtime tool registration.
            // Reserved for future implementation.
            console.error(
                `[Delivery] Level 2 detected for '${mcpName}' but refresh-based ` +
                `registration is not yet implemented. Falling back to Level 3 (proxy).`
            );
            return {
                level: 3,
                description: formatProxyDescription(mcpName, tools),
                registeredToolNames: [],
            };

        case 3:
        default:
            return {
                level: 3,
                description: formatProxyDescription(mcpName, tools),
                registeredToolNames: [],
            };
    }
}

/**
 * Build the full delivery result (detect + execute) in one call.
 */
export function deliverTools(
    mcpName: string,
    tools: ChildMcpTool[],
    ctx: DeliveryContext
): DeliveryResult {
    const level = detectDeliveryLevel(ctx);
    return executeDelivery(level, mcpName, tools, ctx);
}

// ── Formatting helpers ───────────────────────────────────────────

function formatProxyDescription(mcpName: string, tools: ChildMcpTool[]): string {
    if (tools.length === 0) {
        return `MCP '${mcpName}' spawned but no tools were discovered. It may need additional configuration.`;
    }

    const lines: string[] = [];
    lines.push(`Tools are available via proxy. Use \`bhived_use_tool\` to call them:\n`);

    for (const tool of tools) {
        const desc = tool.description
            ? ` — ${tool.description.split("\n")[0].substring(0, 80)}`
            : "";
        lines.push(`- \`bhived_use_tool(mcp="${mcpName}", tool="${tool.name}", params={...})\`${desc}`);
    }

    return lines.join("\n");
}

/**
 * Build a namespaced tool name for Level 1/2 native registration.
 * Format: {mcpName}__{toolName}
 *
 * Reserved for future implementation.
 */
export function buildNativeToolName(mcpName: string, toolName: string): string {
    return `${mcpName}__${toolName}`;
}

/**
 * Parse a namespaced tool name back into MCP and tool names.
 *
 * Reserved for future implementation.
 */
export function parseNativeToolName(nativeName: string): { mcpName: string; toolName: string } | null {
    const idx = nativeName.indexOf("__");
    if (idx === -1) return null;
    return {
        mcpName: nativeName.substring(0, idx),
        toolName: nativeName.substring(idx + 2),
    };
}
