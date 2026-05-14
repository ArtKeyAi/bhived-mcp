/**
 * bhived://status Resource
 *
 * Returns current Bhived system status — graph health and memory counts.
 */

import { restClient } from "../client/restClient.js";

export async function getStatusContent(): Promise<string> {
    const lines: string[] = [];

    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("📊 Bhived System Status");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("");

    // Health check
    try {
        const health = await restClient.getHealth();
        const icon = health.status === "ok" ? "🟢" : "🟡";
        lines.push(`  ${icon} Status: ${health.status}`);
        lines.push(`  📦 Version: ${health.version}`);
        lines.push(`  📊 Graph: ${health.graph_connected ? "✅ connected" : "❌ disconnected"}`);
        lines.push(`  🔴 Redis: ${health.redis_connected ? "✅ connected" : "❌ disconnected"}`);
    } catch (error: unknown) {
        lines.push(`  ❌ Health check failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    lines.push("");

    // Memory counts
    try {
        const memories = await restClient.listMemories({ limit: 1 });
        lines.push(`  📝 Total memories: ${memories.total}`);
    } catch (error: unknown) {
        lines.push(`  ❌ Memory count failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    return lines.join("\n");
}
