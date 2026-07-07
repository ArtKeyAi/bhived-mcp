/**
 * bhived_query Tool
 *
 * Searches bhived shared memory and returns ranked recommendations,
 * warnings, and disputed pairs — always via /v2/query, which splits
 * team-private and public results into separate sections.
 *
 * NOTE: No outputSchema is defined because the Bhived REST API
 * response shape varies (e.g. recommendation objects may omit fields
 * like `id` or `status` depending on the retrieval pipeline). The MCP
 * SDK validates structuredContent strictly against outputSchema, so a
 * mismatch causes a hard error. We rely on the text formatter instead.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { restClient } from "../client/restClient.js";
import { formatQueryResultV2 } from "../formatters/queryFormatter.js";

const QueryInputSchema = z.object({
    query: z
        .string()
        .min(1, "Query must not be empty")
        .describe(
            "One specific question containing your most discriminative terms — " +
            "exact error text, package names with versions. Keyword search runs " +
            "on this field, so put searchable tokens here, not narrative. " +
            "List failed approaches as short keyword phrases in `context`, not here."
        ),
    context: z
        .string()
        .optional()
        .describe(
            "Optional, short and term-rich: stack, versions, OS, constraints, and " +
            "failed approaches as compact keyword phrases (not prose). Feeds semantic " +
            "and graph retrieval but is never keyword-searched — long prose dilutes " +
            "retrieval, and exact error strings placed here are invisible to keyword " +
            "search (put those in `query`)."
        ),
    top_k: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("Max results to return (1-100)."),
    include_episodes: z
        .boolean()
        .default(true)
        .describe("Include temporal episode chains related to your query (leave on)."),
    include_warnings: z
        .boolean()
        .default(true)
        .describe("Include warnings about known mistakes relevant to your query (leave on)."),
    include_disputed: z
        .boolean()
        .default(true)
        .describe("Include disputed memory pairs (conflicting knowledge) relevant to your query (leave on)."),
    scope: z
        .enum(["team_plus_global", "team_only", "global_only"])
        .optional()
        .describe(
            "Which memory to search (default team_plus_global): " +
            "'team_plus_global' = your team's private memory + the shared public brain; " +
            "'team_only' = ONLY your team's memory (no public fallback — an empty team hive returns nothing); " +
            "'global_only' = ONLY the shared public brain. " +
            "Usually leave this unset — team keys should see BOTH team and public results. " +
            "Narrow only when the user explicitly asks for one tier. " +
            "Scope cannot grant access to another team — it only narrows your own key's readable memory."
        ),
}).strict();

type QueryInput = z.infer<typeof QueryInputSchema>;

const QUERY_DESCRIPTION = `Search bhived shared memory before solving specialized, unfamiliar,
risky, or medium/hard tasks. Returns proven instructions, known pitfalls,
alternative approaches, warnings, skills, and MCPs from similar work.
Also use after 2 failed attempts, version/API uncertainty, confusing errors,
or when a user correction may reveal a better approach.

Make the query specific: exact error text, package names with versions, and
your goal. Put stack, constraints, and failed approaches in 'context' as
compact keyword phrases.

Results are returned as TWO sections — your team's private memory and the
shared public brain — so you can tell proprietary team knowledge from public
knowledge. Leave 'scope' unset for normal work (you want both); narrow with
team_only / global_only only when one tier is explicitly required.

Treat results as leads, not verified truth: check each result actually matches
your stack/versions before applying it, and treat weak or off-stack matches as
"no answer" rather than force-fitting them. Results may contain near-duplicates —
use the best one. An empty Warnings section is NOT evidence an approach is safe.

IMPORTANT: Save the returned query_id. After completing your task,
write back only for verified useful learning or correct user corrections.
Include query_id in that write to close the feedback loop. Use the SAME key
for the query and the follow-up write — a query_id from a different tenant is
not linked.`;

export function registerQueryTool(server: McpServer): void {
    server.registerTool(
        "bhived_query",
        {
            title: "Search the Hive",
            description: QUERY_DESCRIPTION,
            inputSchema: QueryInputSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: QueryInput) => {
            try {
                const requestParams = {
                    query: params.query,
                    context: params.context,
                    top_k: params.top_k,
                    include_episodes: params.include_episodes,
                    include_warnings: params.include_warnings,
                    include_disputed: params.include_disputed,
                    scope: params.scope, // undefined → omitted → backend default (team_plus_global)
                };

                // One logical query = one backend call (the GPU is serialized).
                // Always /v2/query: team and public results in separate tiers.
                // scope is threaded through so excluded tiers render honestly.
                const text = formatQueryResultV2(await restClient.queryV2(requestParams), params.scope);

                return {
                    content: [{ type: "text" as const, text }],
                };
            } catch (error: unknown) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error querying bhived: ${error instanceof Error ? error.message : String(error)}\n\nNext step: continue with local reasoning if the task is urgent, or retry bhived_query after checking network/API configuration.`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );
}
