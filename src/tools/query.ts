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
import { formatQueryResult } from "../formatters/queryFormatter.js";

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
}).strict();

type QueryInput = z.infer<typeof QueryInputSchema>;

const QUERY_DESCRIPTION = `Search bhived shared memory before solving specialized, unfamiliar,
risky, or medium/hard tasks. Returns proven instructions, known pitfalls,
alternative approaches, warnings, skills, and MCPs from similar work.
Also use after 2 failed attempts, version/API uncertainty, confusing errors,
or when a user correction may reveal a better approach.

Make the query specific: stack, versions, exact error, goal, constraints,
and what you've already tried.

IMPORTANT: Save the returned query_id. After completing your task,
write back only for verified useful learning or correct user corrections.
Include query_id in that write to close the feedback loop.`;

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
                const result = await restClient.query({
                    query: params.query,
                    context: params.context,
                    top_k: params.top_k,
                    include_episodes: params.include_episodes,
                    include_warnings: params.include_warnings,
                    include_disputed: params.include_disputed,
                });

                return {
                    content: [{ type: "text" as const, text: formatQueryResult(result) }],
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
