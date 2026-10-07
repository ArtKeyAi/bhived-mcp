/**
 * Capability detail lines shared by bhived_query results and activation output:
 * environment requirements (with whether this machine can satisfy them),
 * informational remote-header requirements, and publisher/quality signals.
 * Values of variables are never shown — only names and where they'd come from.
 */

import type { EnvRequirement } from "../client/types.js";
import {
    getSecretsFilePath,
    normalizeRequirements,
    requirementAvailability,
    requirementLabel,
} from "../childMcp/env.js";

/**
 * "🔑 **Requires:** `BRAVE_API_KEY` (secret, not set)" plus a can't-run note
 * when a required variable has no value on this machine. Null when none.
 */
export function formatEnvRequirements(raw: unknown): string | null {
    const reqs = normalizeRequirements(raw);
    if (reqs.length === 0) return null;

    const availability = requirementAvailability(reqs);
    let missingRequired = 0;
    const items = reqs.map((req) => {
        const source = availability.get(req.name);
        const traits: string[] = [];
        if (req.secret === true) traits.push("secret");
        if (req.required !== true) traits.push("optional");
        if (source === "default") traits.push("default used");
        else if (source) traits.push("set");
        else if (req.required === true) {
            traits.push("**not set**");
            missingRequired++;
        } else traits.push("not set");
        return `\`${req.name}\` (${traits.join(", ")})`;
    });

    const lines = [`🔑 **Requires:** ${items.join(" · ")}`];
    if (missingRequired > 0) {
        lines.push(
            `> Can't run on this machine yet — bhived won't launch it until the variables marked **not set** ` +
            `are in the environment or \`${getSecretsFilePath()}\`.`
        );
    }
    return lines.join("\n");
}

/** Remote-deployment headers. Informational: MCPs run locally over stdio here. */
export function formatHeaderRequirements(raw: unknown): string | null {
    const reqs = normalizeHeaderRequirements(raw);
    if (reqs.length === 0) return null;
    return (
        `🌐 **Remote headers (informational):** ${reqs.map((r) => `\`${requirementLabel(r)}\``).join(", ")} — ` +
        `only used by remote deployments; bhived runs this MCP locally over stdio and does not send them.`
    );
}

function normalizeHeaderRequirements(raw: unknown): EnvRequirement[] {
    // Header names allow "-", so the env-name filter would drop them.
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (req): req is EnvRequirement =>
            Boolean(req) && typeof req === "object" && typeof req.name === "string" && /^[A-Za-z0-9-]+$/.test(req.name)
    );
}

/**
 * "⭐ 57,491 GitHub stars · 🛡️ Audits: Socket: Pass, Snyk: Warn · 👤 Publisher: x".
 * Sources are searched in order (e.g. query meta, then its nested metadata),
 * so missing signals are simply left out. Null when there are none.
 */
export function formatQualitySignals(...sources: Array<Record<string, unknown> | null | undefined>): string | null {
    const pick = (key: string): unknown => {
        for (const source of sources) {
            const value = source?.[key];
            if (value !== undefined && value !== null) return value;
        }
        return undefined;
    };

    const parts: string[] = [];

    const stars = pick("github_stars") ?? pick("stars");
    if (typeof stars === "number" && Number.isFinite(stars) && stars > 0) {
        parts.push(`⭐ ${Math.round(stars).toLocaleString("en-US")} GitHub stars`);
    }

    const audits = pick("security_audits");
    if (audits && typeof audits === "object" && !Array.isArray(audits)) {
        const verdicts = Object.entries(audits)
            .filter(([, verdict]) => typeof verdict === "string")
            .slice(0, 6)
            .map(([vendor, verdict]) => `${vendor}: ${verdict}`);
        if (verdicts.length > 0) parts.push(`🛡️ Audits: ${verdicts.join(", ")}`);
    }

    const publisher = pick("publisher");
    if (typeof publisher === "string" && publisher) {
        parts.push(`👤 Publisher: ${publisher}`);
    } else if (publisher && typeof publisher === "object") {
        const { name, verified } = publisher as { name?: unknown; verified?: unknown };
        if (typeof name === "string" && name) {
            parts.push(`👤 Publisher: ${name}${verified === true ? " (verified)" : ""}`);
        }
    }

    return parts.length > 0 ? parts.join(" · ") : null;
}

/** Narrow an unknown metadata field to a plain object for formatQualitySignals. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
