/**
 * Child MCP environment resolution.
 *
 * The MCP SDK's StdioClientTransport only inherits a small allowlist of system
 * variables (PATH, HOME, ...), so a key exported in the user's shell never
 * reaches a child MCP unless it is passed explicitly. We pass exactly the
 * variables a capability declares in `env_requirements` — never the whole
 * parent environment — resolved in this order:
 *
 *   1. the bhived-mcp process environment (the agent's MCP config or shell)
 *   2. the local secrets file (~/.bhived/secrets.json, or BHIVED_SECRETS_FILE)
 *   3. the requirement's declared default
 *
 * A required variable with no value blocks the launch, so the agent gets a
 * clear "Missing X" message instead of a child that fails at runtime.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnvRequirement, McpStaticEnv } from "../client/types.js";

export type EnvSource = "environment" | "secrets file" | "default";

export interface ResolvedChildEnv {
    /** Static env plus every resolved requirement — values are secrets, never log them. */
    env: Record<string, string>;
    /** Where each resolved requirement came from (names only, safe to show). */
    sources: Record<string, EnvSource>;
    /** Required variables that have no value anywhere. */
    missing: EnvRequirement[];
}

/** Raised before launch when the child cannot run on this machine as configured. */
export class ChildMcpPrerequisiteError extends Error {
    constructor(
        readonly mcpName: string,
        message: string,
        readonly missing: EnvRequirement[] = []
    ) {
        super(message);
        this.name = "ChildMcpPrerequisiteError";
    }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getSecretsFilePath(): string {
    return process.env.BHIVED_SECRETS_FILE || join(homedir(), ".bhived", "secrets.json");
}

/**
 * Read the flat `{ "NAME": "value" }` secrets file. Re-read on every launch so
 * edits apply without restarting the agent; a missing or malformed file is
 * treated as empty.
 */
function readSecretsFile(): Record<string, string> {
    try {
        const parsed: unknown = JSON.parse(readFileSync(getSecretsFilePath(), "utf-8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const secrets: Record<string, string> = {};
        for (const [name, value] of Object.entries(parsed)) {
            if (typeof value === "string" && value !== "") secrets[name] = value;
        }
        return secrets;
    } catch {
        return {};
    }
}

/** Keep only well-formed requirement entries; the backend payload is untrusted input. */
export function normalizeRequirements(raw: unknown): EnvRequirement[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (req): req is EnvRequirement =>
            Boolean(req) && typeof req === "object" && typeof req.name === "string" && ENV_NAME.test(req.name)
    );
}

/** The admin-curated static env as a record (the live API sends `[]` for none). */
export function staticEnv(env: McpStaticEnv | undefined): Record<string, string> {
    if (!env || typeof env !== "object" || Array.isArray(env)) return {};
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (ENV_NAME.test(name) && typeof value === "string") result[name] = value;
    }
    return result;
}

function lookup(
    req: EnvRequirement,
    secrets: Record<string, string>
): { value: string; source: EnvSource } | undefined {
    const fromEnv = process.env[req.name];
    if (fromEnv) return { value: fromEnv, source: "environment" };
    if (secrets[req.name]) return { value: secrets[req.name], source: "secrets file" };
    if (typeof req.default === "string" && req.default !== "") {
        return { value: req.default, source: "default" };
    }
    return undefined;
}

export function resolveChildEnv(mcp: {
    env?: McpStaticEnv;
    env_requirements?: EnvRequirement[];
}): ResolvedChildEnv {
    const env = staticEnv(mcp.env);
    const sources: Record<string, EnvSource> = {};
    const missing: EnvRequirement[] = [];
    const requirements = normalizeRequirements(mcp.env_requirements);
    const secrets = requirements.length > 0 ? readSecretsFile() : {};

    for (const req of requirements) {
        const found = lookup(req, secrets);
        if (found) {
            env[req.name] = found.value;
            sources[req.name] = found.source;
        } else if (req.required === true) {
            missing.push(req);
        }
    }
    return { env, sources, missing };
}

/** Where a requirement would come from on this machine right now, without exposing it. */
export function requirementAvailability(reqs: EnvRequirement[]): Map<string, EnvSource | undefined> {
    const secrets = reqs.length > 0 ? readSecretsFile() : {};
    return new Map(reqs.map((req) => [req.name, lookup(req, secrets)?.source]));
}

/** "BRAVE_API_KEY (secret)" — the label used everywhere a requirement is named. */
export function requirementLabel(req: EnvRequirement): string {
    return req.secret === true ? `${req.name} (secret)` : req.name;
}

/** "Missing BRAVE_API_KEY (secret): Your API key for the service" — one line per variable. */
export function formatMissingEnv(missing: EnvRequirement[]): string {
    return missing
        .map((req) => `Missing ${requirementLabel(req)}${req.description ? `: ${req.description}` : ""}`)
        .join("\n");
}

export function missingEnvHelp(): string {
    return (
        `Set each variable in the environment bhived-mcp runs in (the "env" block of the agent's ` +
        `bhived MCP config, or your shell before starting the agent), or add it to ` +
        `${getSecretsFilePath()} as { "NAME": "value" }. The secrets file is re-read on every ` +
        `activation, so no restart is needed after editing it.`
    );
}
