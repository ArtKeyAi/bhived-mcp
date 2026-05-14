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

export function loadConfig(): BhivedConfig {
    const transportArg = process.argv.find((a) => a.startsWith("--transport="));
    const portArg = process.argv.find((a) => a.startsWith("--port="));
    const storedConfig = readStoredConfig();

    // --key is passed as a separate arg: --key <value>
    const keyArgIndex = process.argv.indexOf("--key");
    const keyArg = keyArgIndex !== -1 ? process.argv[keyArgIndex + 1] : undefined;

    return {
        apiUrl: process.env.BHIVED_API_URL ?? storedConfig?.apiUrl ?? "https://mcp.bhived.ai",
        apiKey: keyArg ?? process.env.BHIVED_API_KEY ?? storedConfig?.apiKey,
        timeout: parseInt(process.env.BHIVED_TIMEOUT ?? "30000", 10),
        transport: (transportArg?.split("=")[1] as "stdio" | "http") ?? "stdio",
        httpPort: parseInt(portArg?.split("=")[1] ?? process.env.PORT ?? "3001", 10),

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

