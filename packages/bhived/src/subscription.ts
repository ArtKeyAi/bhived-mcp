/**
 * Live subscription/scope lookup.
 *
 * `GET /v1/subscription` is the authoritative, out-of-band signal for what an
 * API key can actually do: the backend reads the key from the `X-API-Key`
 * header and returns the caller's plan:
 *
 *   GET /v1/subscription
 *   X-API-Key: <key>
 *   → 200 {"plan": "free" | "pro" | "team"}
 *
 * This turns "we hope this key is team-provisioned" into verified scope — the
 * device-token response at sign-in may omit plan/team metadata, and a
 * valid-but-unprovisioned key otherwise degrades to public-only with no error.
 */

import type { InstructionScope } from "./globalInstructions.js";

export type SubscriptionPlan = "free" | "pro" | "team";

/**
 * Fetch the caller's plan from GET /v1/subscription. Returns null on any
 * failure (network, non-2xx, unexpected body) — callers must fall back to
 * stored metadata and must NOT treat null as "personal".
 */
export async function fetchSubscriptionPlan(
  apiUrl: string,
  apiKey: string,
  timeoutMs = 8000
): Promise<SubscriptionPlan | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/subscription`, {
      headers: { "X-API-Key": apiKey },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as { plan?: unknown } | null;
    const plan = data?.plan;
    return plan === "free" || plan === "pro" || plan === "team" ? plan : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Map a live-verified plan to the instruction-block scope. */
export function planToScope(plan: SubscriptionPlan): InstructionScope {
  return plan === "team" ? "team" : "personal";
}

/**
 * Derive scope from a stored config snapshot (no network) — the fallback when
 * the live endpoint is unreachable. "unknown" means callers should NOT
 * overwrite a previously-stamped scope in instruction files.
 */
export function scopeFromStored(
  stored: { plan?: string; team?: { id: string; name?: string } } | null
): InstructionScope {
  if (!stored) return "unknown";
  if (stored.plan === "team" || stored.team?.id) return "team";
  if (stored.plan === "pro" || stored.plan === "free") return "personal";
  return "unknown";
}
