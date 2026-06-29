/**
 * bhived://status Resource
 *
 * Returns current Bhived system status — graph health and memory counts.
 */

import { restClient } from "../client/restClient.js";
import { getTenancy } from "../tenancy.js";

export async function getStatusContent(): Promise<string> {
    const lines: string[] = [];

    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("📊 Bhived System Status");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("");

    // Tenancy / scope — what this key reads and writes
    const t = getTenancy();
    lines.push("  🏷️ Tenancy (scope of this API key):");
    if (t.state === "team") {
        lines.push(`     🏠 Team: ${t.teamName ?? "(unnamed)"} (${t.teamId})`);
        if (t.plan) lines.push(`     📦 Plan: ${t.plan}`);
        lines.push("     → Reads team-private + public; writes land team-private.");
    } else if (t.state === "personal") {
        lines.push(`     🌍 Personal key (plan: ${t.plan}) — reads/writes the global public brain.`);
    } else {
        lines.push("     ⚠️ Unknown — no team metadata in ~/.bhived/config.json.");
        lines.push("     A team-provisioned key reads team+public and writes team-private;");
        lines.push("     a non-provisioned key silently reads/writes PUBLIC-ONLY with no error.");
        lines.push("     Run `npx bhived setup` so the MCP can confirm your scope.");
    }
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
