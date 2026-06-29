/**
 * Bhived MCP Server — Configuration
 *
 * Environment-based configuration for the REST API connection,
 * authentication, timeouts, transport selection, and capability limits.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BhivedConfig {
    /** Base URL of the Bhived REST API */
    apiUrl: string;
    /** API key for REST API authentication (sent as X-API-Key header) */
    apiKey: string | undefined;
    /** Request timeout in milliseconds */
    timeout: number;
    /** Transport mode: "stdio" or "http" */
    transport: "stdio" | "http";
    /** HTTP port (only used when transport is "http") */
    httpPort: number;
    /** Max retries when the backend returns 503 models_warming on a query */
    modelWarmupRetries: number;

    // ── Tenancy (derived from the API key, surfaced via stored config) ───
    //
    // The backend derives team + hive scope SERVER-SIDE from the API key; the
    // MCP cannot assert tenancy. These fields are populated only when the
    // `bhived` CLI recorded them at sign-in (the device-token response includes
    // `plan` and, for team keys, `team`). They let the MCP HONESTLY tell agents
    // which scope a key has — a valid-but-unprovisioned key silently degrades to
    // public-only with no error, so absence of `team` here does NOT prove the key
    // is personal; it only means team membership is unknown locally.

    /** Team scope recorded at CLI sign-in for a team-provisioned key. */
    team?: { id: string; name?: string };
    /** Plan recorded at CLI sign-in (e.g. "team", "pro", "free"). */
    plan?: string;

    // ── Capability limits ────────────────────────────────────────────

    /** Maximum number of active skills at any time */
    maxActiveSkills: number;
    /** Maximum number of standalone (non-skill-bundled) child MCPs */
    maxStandaloneMcps: number;
    /** Maximum total child MCP processes (standalone + skill-bundled) */
    maxChildProcesses: number;
    /** Maximum bundled MCPs per skill */
    maxBundledMcps: number;
    /** Script execution timeout in milliseconds */
    scriptTimeout: number;
    /** Health check interval for child MCPs in milliseconds */
    childHealthInterval: number;
}

/** parseInt with a finite, non-negative guard so misconfig can't yield NaN. */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
    const n = parseInt(raw ?? String(fallback), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(): BhivedConfig {
    const transportArg = process.argv.find((a) => a.startsWith("--transport="));
    const portArg = process.argv.find((a) => a.startsWith("--port="));
    const storedConfig = readStoredConfig();

    // --key is passed as a separate arg: --key <value>
    const keyArgIndex = process.argv.indexOf("--key");
    const keyArg = keyArgIndex !== -1 ? process.argv[keyArgIndex + 1] : undefined;

    // Tenancy metadata only applies to the key actually in use. If the key is
    // supplied out-of-band (--key / BHIVED_API_KEY) and differs from the one the
    // CLI stored, the stored team/plan would be misleading, so we only trust it
    // when the active key matches the stored key (or no explicit key was given).
    const activeKey = keyArg ?? process.env.BHIVED_API_KEY ?? storedConfig?.apiKey;
    const tenancyTrusted =
        storedConfig?.apiKey !== undefined && activeKey === storedConfig.apiKey;

    return {
        apiUrl: process.env.BHIVED_API_URL ?? storedConfig?.apiUrl ?? "https://mcp.bhived.ai",
        apiKey: activeKey,
        timeout: parseInt(process.env.BHIVED_TIMEOUT ?? "30000", 10),
        transport: (transportArg?.split("=")[1] as "stdio" | "http") ?? "stdio",
        httpPort: parseInt(portArg?.split("=")[1] ?? process.env.PORT ?? "3001", 10),
        // Guarded: a non-numeric value must NOT become NaN, or the warming-retry
        // loop in restClient (warmingAttempts >= NaN is always false) never exits.
        modelWarmupRetries: parseNonNegativeInt(process.env.BHIVED_WARMUP_RETRIES, 5),
        team: tenancyTrusted ? storedConfig?.team : undefined,
        plan: tenancyTrusted ? storedConfig?.plan : undefined,

        // Capability limits (configurable via env vars)
        maxActiveSkills: parseInt(process.env.BHIVED_MAX_SKILLS ?? "5", 10),
        maxStandaloneMcps: parseInt(process.env.BHIVED_MAX_STANDALONE_MCPS ?? "5", 10),
        maxChildProcesses: parseInt(process.env.BHIVED_MAX_CHILD_PROCESSES ?? "10", 10),
        maxBundledMcps: parseInt(process.env.BHIVED_MAX_BUNDLED_MCPS ?? "3", 10),
        scriptTimeout: parseInt(process.env.BHIVED_SCRIPT_TIMEOUT ?? "30000", 10),
        childHealthInterval: parseInt(process.env.BHIVED_HEALTH_INTERVAL ?? "30000", 10),
    };
}

interface StoredBhivedConfig {
    apiUrl?: string;
    apiKey?: string;
    team?: { id: string; name?: string };
    plan?: string;
}

function readStoredConfig(): StoredBhivedConfig | null {
    const configPath = join(homedir(), ".bhived", "config.json");

    if (!existsSync(configPath)) return null;

    try {
        const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as StoredBhivedConfig;
        if (!parsed.apiKey) return null;
        return parsed;
    } catch {
        return null;
    }
}

/** Singleton config instance */
export const config = loadConfig();

