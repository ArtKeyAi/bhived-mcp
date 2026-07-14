/**
 * bhived://status Resource
 *
 * Returns current Bhived system status — graph health and memory counts.
 */

import { restClient } from "../client/restClient.js";
import { config } from "../config.js";
import { fetchLivePlan } from "../scopeSync.js";
import { describeLiveCheckFailure, getTenancy } from "../tenancy.js";

export async function getStatusContent(): Promise<string> {
    const lines: string[] = [];

    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("📊 Bhived System Status");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("");

    // Tenancy / scope — re-verified live on every status read so this
    // resource is the place to confirm what the key can actually do.
    // NOTE: the re-check updates this session's OUTPUT only; config.json and
    // instruction files are persisted/refreshed at server startup, not here.
    const recheck = await fetchLivePlan();
    const t = getTenancy();
    const failureDetail = describeLiveCheckFailure();
    const verification =
        recheck !== null
            ? "🔎 Verified live via GET /v1/subscription (re-checked on this read)."
            : t.verified
                ? `🔎 Verified at server startup via GET /v1/subscription — the re-check on this read failed (${failureDetail ?? "unknown reason"}); scope shown may be stale.`
                : `🔎 From sign-in metadata — not verified live (${failureDetail ?? "the live scope check did not succeed"}).`;
    lines.push("  🏷️ Tenancy (scope of this API key):");
    if (t.state === "team") {
        lines.push(`     🏠 Team: ${t.teamName ?? "(unnamed team)"}${t.teamId ? ` (${t.teamId})` : ""}`);
        if (t.plan) lines.push(`     📦 Plan: ${t.plan}`);
        lines.push(`     ${verification}`);
        lines.push("     → Reads team-private + public; writes land team-private.");
    } else if (t.state === "personal") {
        lines.push(`     🌍 Personal key (plan: ${t.plan}) — reads/writes the global public brain.`);
        lines.push(`     ${verification}`);
    } else {
        lines.push(`     ⚠️ Unknown — ${failureDetail ?? "the live scope check did not succeed"},`);
        lines.push(
            config.tenancyTrusted
                ? "     and ~/.bhived/config.json has no scope metadata."
                : "     and the active key (--key/BHIVED_API_KEY) differs from the stored sign-in key, so stored metadata does not apply."
        );
        lines.push("     A team-provisioned key reads team+public and writes team-private;");
        lines.push("     a non-provisioned key silently reads/writes PUBLIC-ONLY with no error.");
        lines.push("     Run `npx bhived setup` to re-verify scope.");
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
