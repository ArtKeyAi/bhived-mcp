/**
 * Tenancy awareness helpers.
 *
 * The backend derives the caller's team + hive scope SERVER-SIDE from the API
 * key (api_keys.team_id / default_hive_id + api_key_hive_access grants). The MCP
 * cannot assert tenancy and there is no per-request "team" override — one API
 * key = one tenant scope.
 *
 * Verification: at every server start the MCP calls `GET /v1/subscription`
 * (X-API-Key → `{"plan": "free" | "pro" | "team"}`) — the authoritative signal
 * for the key's real scope — via syncTenancyAtStartup() in scopeSync.ts, and
 * records the result here with setLivePlan(). The live plan always wins over
 * the team/plan metadata the `bhived` CLI recorded at sign-in, because a
 * valid-but-unprovisioned key silently degrades to PUBLIC-ONLY with NO error
 * and provisioning can change after sign-in. When the live check fails, the
 * stored metadata is the fallback and copy stays explicitly cautious.
 */

import { config } from "./config.js";

export type TenancyState = "team" | "personal" | "unknown";

export interface Tenancy {
    state: TenancyState;
    teamId?: string;
    teamName?: string;
    plan?: string;
    /** True when the state comes from a live GET /v1/subscription check. */
    verified: boolean;
}

let livePlan: "free" | "pro" | "team" | undefined;

/** Record the live plan fetched from GET /v1/subscription (authoritative). */
export function setLivePlan(plan: "free" | "pro" | "team"): void {
    livePlan = plan;
}

/**
 * Outcome of the most recent GET /v1/subscription attempt, so copy can tell
 * "older backend without the endpoint" apart from "rejected key" and
 * "network down" instead of blaming connectivity for everything.
 */
export type LiveCheckOutcome =
    | { kind: "not_run" }
    | { kind: "ok" }
    | { kind: "http"; status: number }
    | { kind: "invalid_response" }
    | { kind: "unreachable" };

let liveCheckOutcome: LiveCheckOutcome = { kind: "not_run" };

export function setLiveCheckOutcome(outcome: LiveCheckOutcome): void {
    liveCheckOutcome = outcome;
}

export function getLiveCheckOutcome(): LiveCheckOutcome {
    return liveCheckOutcome;
}

/** Human-readable reason the last live check yielded no plan; null after success. */
export function describeLiveCheckFailure(): string | null {
    switch (liveCheckOutcome.kind) {
        case "ok":
            return null;
        case "not_run":
            return "the live scope check has not run (no API key configured)";
        case "http":
            if (liveCheckOutcome.status === 404) {
                return "this backend does not expose GET /v1/subscription (older server) — using stored metadata";
            }
            if (liveCheckOutcome.status === 401 || liveCheckOutcome.status === 403) {
                return `the backend rejected this key (HTTP ${liveCheckOutcome.status}) — re-run \`npx bhived setup\``;
            }
            return `GET /v1/subscription returned HTTP ${liveCheckOutcome.status}`;
        case "invalid_response":
            return "GET /v1/subscription returned an unrecognized plan";
        case "unreachable":
            return "the backend could not be reached";
    }
}

/**
 * Provenance phrase for scope claims in agent-facing copy (tool descriptions,
 * server instructions). MUST track `verified` — claiming verification that
 * never happened recreates the silent-degrade trap this feature removes.
 */
export function verificationPhrase(): string {
    return getTenancy().verified
        ? "verified via GET /v1/subscription"
        : "from sign-in metadata — live verification unavailable this session; check bhived://status";
}

/** Resolve tenancy: live subscription check first, stored sign-in metadata as fallback. */
export function getTenancy(): Tenancy {
    const verified = livePlan !== undefined;
    const plan = livePlan ?? config.plan;

    if (plan === "team") {
        return {
            state: "team",
            teamId: config.team?.id,
            teamName: config.team?.name,
            plan,
            verified,
        };
    }
    if (verified) {
        // Live plan says pro/free — personal even if stale team metadata exists.
        return { state: "personal", plan, verified };
    }
    // Unverified fallbacks: stored team metadata outranks a stored plan string.
    if (config.team?.id) {
        return {
            state: "team",
            teamId: config.team.id,
            teamName: config.team.name,
            plan,
            verified: false,
        };
    }
    // A plan recorded WITHOUT a team means the CLI saw a personal (pro/free) key.
    if (plan) {
        return { state: "personal", plan, verified: false };
    }
    return { state: "unknown", verified: false };
}

/**
 * One-line scope banner for query/write output.
 *
 * `mode`:
 *  - "read"  → describes where results came from.
 *  - "write" → describes where a write lands (team-private vs public).
 */
export function tenancyBanner(mode: "read" | "write"): string {
    const t = getTenancy();
    const via = t.verified
        ? "verified via `GET /v1/subscription`"
        : "from sign-in metadata — live verification unavailable";

    if (t.state === "team") {
        const team = t.teamName ? `**${t.teamName}**` : "your team";
        return mode === "write"
            ? `> 🏠 **Scope:** team key (${via}) — this writes to ${team}'s **private** memory (visibility=team), not the global public brain.`
            : `> 🏠 **Scope:** team key (${via}) — results include ${team}'s private memory + the shared public brain (unless narrowed by \`scope\`).`;
    }

    if (t.state === "personal") {
        return mode === "write"
            ? `> 🌍 **Scope:** personal key (plan: ${t.plan}, ${via}) — this writes to the **global public brain**; never include anything confidential or team-internal.`
            : `> 🌍 **Scope:** personal key (plan: ${t.plan}, ${via}) — results come from the **global public brain**; this key has no private team tier.`;
    }

    // Unknown: the live check yielded no plan AND no stored metadata applies.
    const why = describeLiveCheckFailure() ?? "the live scope check did not succeed";
    const metadataNote = config.tenancyTrusted
        ? "`~/.bhived/config.json` has no scope metadata"
        : "the active key (from `--key`/`BHIVED_API_KEY`) differs from the stored sign-in key, so stored scope metadata does not apply to it";
    return mode === "write"
        ? `> ⚠️ **Scope unverified:** ${why}, and ${metadataNote}. A team-provisioned key writes **team-private**; a non-provisioned key writes **public** with no error. Run \`npx bhived setup\` or check \`bhived://status\` to confirm scope.`
        : `> ⚠️ **Scope unverified:** ${why}, and ${metadataNote}. A team-provisioned key returns team + public; a non-provisioned key silently returns **public-only**. Run \`npx bhived setup\` or check \`bhived://status\` to confirm scope.`;
}
