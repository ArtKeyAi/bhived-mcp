/**
 * bhived_query Tool
 *
 * Searches bhived shared memory and returns
 * ranked recommendations, warnings, and disputed pairs.
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
import { formatQueryResult, formatQueryResultV2 } from "../formatters/queryFormatter.js";

const QueryInputSchema = z.object({
    query: z
        .string()
        .min(1, "Query must not be empty")
        .describe(
            "Describe what you need help with. Include what you've already tried and what went wrong."
        ),
    context: z
        .string()
        .optional()
        .describe(
            "Optional: your environment, tech stack, constraints, and approaches that didn't work."
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
        .describe("Reconstruct temporal episode chains in results."),
    include_warnings: z
        .boolean()
        .default(true)
        .describe("Run negative-aware filter for warnings."),
    include_disputed: z
        .boolean()
        .default(true)
        .describe("Look up disputed memory pairs."),
    scope: z
        .enum(["team_plus_global", "team_only", "global_only"])
        .optional()
        .describe(
            "Which memory to search (default team_plus_global): " +
            "'team_plus_global' = your team's private memory + the shared public brain; " +
            "'team_only' = ONLY your team's memory (no public fallback — an empty team hive returns nothing); " +
            "'global_only' = ONLY the shared public brain. " +
            "Use team_only to avoid public noise, global_only to browse only public knowledge. " +
            "Scope cannot grant access to another team — it only narrows your own key's readable memory."
        ),
    separate_sources: z
        .boolean()
        .default(false)
        .describe(
            "When true, return team-private and public results as TWO distinct sections " +
            "(via /v2/query) so you can tell proprietary team knowledge from public knowledge. " +
            "When false (default), return a single merged, ranked list (via /v1/query)."
        ),
}).strict();

type QueryInput = z.infer<typeof QueryInputSchema>;

const QUERY_DESCRIPTION = `Search bhived shared memory before solving specialized, unfamiliar,
risky, or medium/hard tasks. Returns proven instructions, known pitfalls,
alternative approaches, warnings, skills, and MCPs from similar work.
Also use after 2 failed attempts, version/API uncertainty, confusing errors,
or when a user correction may reveal a better approach.

Make the query specific: stack, versions, exact error, goal, constraints,
and what you've already tried.

Scope: by default this searches your team's private memory plus the shared
public brain. Use the optional 'scope' argument to narrow (team_only / global_only),
or 'separate_sources' to see team vs public knowledge as distinct sections.

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
                // separate_sources picks /v2/query (split tiers) vs /v1/query (merged).
                const text = params.separate_sources
                    ? formatQueryResultV2(await restClient.queryV2(requestParams))
                    : formatQueryResult(await restClient.query(requestParams), params.scope);

                return {
                    content: [{ type: "text" as const, text }],
                };
            } catch (error: unknown) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error querying bhived: ${error instanceof Error ? error.message : String(error)}\n\nNext step: continue with local reasoning if the task is urgent, or retry bhived_query with a narrower query after checking network/API configuration.`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );
}
