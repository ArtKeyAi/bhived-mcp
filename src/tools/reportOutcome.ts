/**
 * Capability outcome reporting + bhived_report_outcome Tool
 *
 * success_rate on the backend is success reports / activations, so a report
 * must describe what actually happened, never the activation itself:
 *   - MCPs: success when the child launched and listed tools, failure when the
 *     launch failed. Missing local keys/binaries are not reported — they say
 *     nothing about the capability.
 *   - Skills: success when one of its scripts exits 0, or when the agent calls
 *     bhived_report_outcome after using it.
 *
 * Only capabilities activated through bhived in this session can be reported,
 * and each (capability, outcome) pair is sent at most once per session.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { restClient } from "../client/restClient.js";
import { BhivedIdFields, resolveBhivedId } from "./bhivedId.js";

const activated = new Map<string, "skill" | "mcp">();
const reported = new Set<string>();

/** Record that a capability was activated through bhived in this session. */
export function markActivated(bhivedId: string, type: "skill" | "mcp"): void {
    activated.set(bhivedId, type);
}

export function wasActivated(bhivedId: string): boolean {
    return activated.has(bhivedId);
}

export type ReportStatus = "sent" | "skipped" | "failed";

/**
 * Send one outcome report. Never rejects, so automatic callers can fire and
 * forget it. "skipped" means the capability wasn't activated here or the same
 * outcome was already sent this session; a failed send can be retried.
 */
export async function reportOutcome(bhivedId: string, success: boolean, source: string): Promise<ReportStatus> {
    const key = `${bhivedId}\u0000${success}`;
    if (!activated.has(bhivedId) || reported.has(key)) return "skipped";
    reported.add(key); // before the request, so concurrent callers don't double-send

    try {
        await restClient.reportCapability(bhivedId, { success });
        return "sent";
    } catch (err: unknown) {
        reported.delete(key);
        console.error(
            `[${source}] Failed to report outcome for '${bhivedId}': ${err instanceof Error ? err.message : String(err)}`
        );
        return "failed";
    }
}

// ── Tool ─────────────────────────────────────────────────────────

const ReportOutcomeInputSchema = z
    .object({
        ...BhivedIdFields,
        success: z
            .boolean()
            .describe("true if the skill/MCP did what you needed; false if it failed or was unusable."),
    })
    .strict()
    .refine((params) => Boolean(params.bhived_id || params.memory_id), {
        message: "bhived_id is required",
        path: ["bhived_id"],
    })
    .meta({ required: ["bhived_id", "success"] });

type ReportOutcomeInput = z.infer<typeof ReportOutcomeInputSchema>;

const REPORT_OUTCOME_DESCRIPTION = `Report whether a skill or MCP you activated this session actually worked.
This feeds the success rate other agents see in bhived_query results, so report
after you have used the capability for your task:
- success=true: it did what you needed.
- success=false: it failed, gave wrong results, or its instructions didn't work.

MCP launches and skill scripts that exit 0 are reported automatically; use this
for skills without scripts, or when the real outcome differs. Do not report
false for problems on your side — a missing API key, a tool not installed
locally, or your hardware limits (RAM/GPU/disk). Those aren't the capability's
fault.

Example: bhived_report_outcome(bhived_id="mem_abc123", success=true)`;

export function registerReportOutcomeTool(server: McpServer): void {
    server.registerTool(
        "bhived_report_outcome",
        {
            title: "Report Capability Outcome",
            description: REPORT_OUTCOME_DESCRIPTION,
            inputSchema: ReportOutcomeInputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: ReportOutcomeInput) => {
            const bhivedId = resolveBhivedId(params);
            if (!wasActivated(bhivedId)) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text:
                                `❌ '${bhivedId}' was not activated in this session. Only report outcomes for ` +
                                `skills/MCPs you activated with bhived_initiate_skill or bhived_initiate_mcp and actually used.`,
                        },
                    ],
                    isError: true,
                };
            }

            const outcome = params.success ? "success" : "failure";
            const status = await reportOutcome(bhivedId, params.success, "reportOutcome");
            const text = {
                sent: `✅ Recorded ${outcome} for \`${bhivedId}\`.`,
                skipped: `ℹ️ A ${outcome} for \`${bhivedId}\` was already recorded this session — nothing more to do.`,
                failed: `❌ Could not record the ${outcome} for \`${bhivedId}\` (the bhived API request failed). Try again later.`,
            }[status];
            return {
                content: [{ type: "text" as const, text }],
                ...(status === "failed" ? { isError: true } : {}),
            };
        }
    );
}
