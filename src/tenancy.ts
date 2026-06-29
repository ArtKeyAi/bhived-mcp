/**
 * Tenancy awareness helpers.
 *
 * The backend derives the caller's team + hive scope SERVER-SIDE from the API
 * key (api_keys.team_id / default_hive_id + api_key_hive_access grants). The MCP
 * cannot assert tenancy and there is no per-request "team" override — one API
 * key = one tenant scope.
 *
 * Critically, a valid-but-unprovisioned key silently degrades to PUBLIC-ONLY
 * with NO error (reads return public-only, writes land in the global public
 * hive). So the MCP must verify provisioning out-of-band rather than assume a
 * 200 means "team-scoped." The only out-of-band signal available locally is the
 * team/plan metadata the `bhived` CLI records at sign-in. These helpers turn
 * that into honest, non-misleading copy for agents.
 */

import { config } from "./config.js";

export type TenancyState = "team" | "personal" | "unknown";

export interface Tenancy {
    state: TenancyState;
    teamId?: string;
    teamName?: string;
    plan?: string;
}

/** Resolve the locally-known tenancy for the active API key. */
export function getTenancy(): Tenancy {
    if (config.team?.id) {
        return {
            state: "team",
            teamId: config.team.id,
            teamName: config.team.name,
            plan: config.plan,
        };
    }
    // A plan recorded WITHOUT a team means the CLI saw a personal (pro/free) key.
    if (config.plan) {
        return { state: "personal", plan: config.plan };
    }
    return { state: "unknown" };
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

    if (t.state === "team") {
        const team = t.teamName ? `**${t.teamName}**` : "your team";
        return mode === "write"
            ? `> 🏠 **Scope:** team key — this writes to ${team}'s **private** memory (visibility=team), not the global public brain.`
            : `> 🏠 **Scope:** team key — results include ${team}'s private memory + the shared public brain (unless narrowed by \`scope\`).`;
    }

    if (t.state === "personal") {
        return mode === "write"
            ? `> 🌍 **Scope:** personal key (plan: ${t.plan}) — this writes to the **global public brain**.`
            : `> 🌍 **Scope:** personal key (plan: ${t.plan}) — results come from the **global public brain**.`;
    }

    // Unknown: be explicit that team isolation cannot be confirmed locally.
    return mode === "write"
        ? `> ⚠️ **Scope unverified:** team membership is unknown to this MCP (no team metadata in \`~/.bhived/config.json\`). A team-provisioned key writes **team-private**; a non-provisioned key writes **public** with no error. Run \`npx bhived setup\` so scope can be confirmed.`
        : `> ⚠️ **Scope unverified:** team membership is unknown to this MCP. A team-provisioned key returns team + public; a non-provisioned key silently returns **public-only**. Run \`npx bhived setup\` to confirm your scope.`;
}
