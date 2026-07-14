/**
 * Startup tenancy sync.
 *
 * `GET /v1/subscription` (X-API-Key → `{"plan": "free" | "pro" | "team"}`) is
 * the authoritative signal for what the active key can actually do. At every
 * server start the MCP:
 *
 *   1. fetches the live plan and records it (setLivePlan) so banners, result
 *      structure, and tool descriptions match the key's real scope,
 *   2. persists the plan to ~/.bhived/config.json so offline consumers (the
 *      CLI's quiet refresh, a later offline MCP start) stay accurate, and
 *   3. refreshes the bhived block in installed agent instruction files when
 *      the scope changed, via the `bhived` CLI package's marker-based writer.
 *
 * Steps 2–3 run only when the active key IS the stored key (config.tenancyTrusted)
 * — an out-of-band --key/BHIVED_API_KEY run must not stamp another key's scope
 * onto files that agents using the stored key rely on. Everything is
 * best-effort: failures leave stored-metadata behavior intact and never block
 * server startup.
 */

import { constants } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { detectPlatform } from "bhived/agent-configs";
import type { InstructionScope } from "bhived/global-instructions";
import { refreshOutdatedInstructions } from "bhived/install-global-instructions";
import { BhivedRestClient } from "./client/restClient.js";
import { config, getStoredConfigPath } from "./config.js";
import { setLiveCheckOutcome, setLivePlan } from "./tenancy.js";

type Plan = "free" | "pro" | "team";

/** Per-request timeout for the startup check (one transient retry may follow). */
const SUBSCRIPTION_TIMEOUT_MS = 4500;

/**
 * Fetch the live plan and update local scope state. Safe to call multiple
 * times (bhived://status re-checks on read). Returns the plan, or null when
 * the endpoint could not confirm one — with the failure kind recorded via
 * setLiveCheckOutcome so copy can report 404/401/network distinctly.
 */
export async function fetchLivePlan(timeoutMs = SUBSCRIPTION_TIMEOUT_MS): Promise<Plan | null> {
    if (!config.apiKey) return null;
    try {
        const client = new BhivedRestClient(undefined, timeoutMs);
        const sub = await client.getSubscription();
        const plan = sub.plan;
        if (plan !== "free" && plan !== "pro" && plan !== "team") {
            setLiveCheckOutcome({ kind: "invalid_response" });
            return null;
        }
        setLivePlan(plan);
        setLiveCheckOutcome({ kind: "ok" });
        return plan;
    } catch (error: unknown) {
        const status = (error as { statusCode?: number }).statusCode;
        setLiveCheckOutcome(status !== undefined ? { kind: "http", status } : { kind: "unreachable" });
        return null;
    }
}

/** Full startup sync: live plan → persist to config.json → refresh instruction files. */
export async function syncTenancyAtStartup(): Promise<void> {
    const plan = await fetchLivePlan();
    if (plan === null || !config.tenancyTrusted) return;

    // persistPlan re-verifies at write time that config.json still belongs to
    // the key we checked — `bhived auth` may have switched accounts during the
    // fetch window. When it no longer matches, this key's scope must not be
    // stamped into the config OR the instruction files.
    const storedKeyStillMatches = await persistPlan(plan).catch(() => false);
    if (!storedKeyStillMatches) return;

    await refreshInstructions(plan === "team" ? "team" : "personal");
}

/**
 * Persist the live plan onto ~/.bhived/config.json, preserving every other
 * field, via temp-file + rename so a crash can't truncate the credentials
 * file. Drops stale team metadata when the key is no longer team-provisioned.
 * Returns whether the stored key still matches the active key; the write
 * itself is best-effort (a read-only file does not invalidate the identity).
 */
async function persistPlan(plan: Plan): Promise<boolean> {
    const path = getStoredConfigPath();
    const raw = await readFile(path, "utf-8").catch(() => null);
    if (raw === null) return false;

    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return false;
    }
    if (typeof parsed.apiKey !== "string" || parsed.apiKey !== config.apiKey) return false;

    const planUnchanged = parsed.plan === plan;
    const teamUnchanged = plan === "team" || parsed.team === undefined;
    if (planUnchanged && teamUnchanged) return true;

    parsed.plan = plan;
    if (plan !== "team") delete parsed.team;

    try {
        const tmpPath = `${path}.${process.pid}.tmp`;
        await writeFile(tmpPath, JSON.stringify(parsed, null, 2), {
            encoding: "utf-8",
            mode: constants.S_IRUSR | constants.S_IWUSR,
        });
        await rename(tmpPath, path);
    } catch {
        // Best-effort: an unwritable config.json must not affect the session.
    }
    return true;
}

/**
 * Rewrite the bhived block in already-installed agent instruction files when
 * their stamped scope differs from the verified one (create-nothing refresh).
 */
async function refreshInstructions(scope: InstructionScope): Promise<void> {
    try {
        const updated = await refreshOutdatedInstructions(detectPlatform(), scope);
        for (const result of updated) {
            // stderr only — stdout is the MCP protocol channel.
            console.error(`[bhived] Updated global instructions for ${result.label}: ${result.message}`);
        }
    } catch {
        // Best-effort — never let instruction refresh break server startup.
    }
}
