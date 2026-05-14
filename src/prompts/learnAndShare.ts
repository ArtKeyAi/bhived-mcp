/**
 * learn_and_share Prompt
 *
 * Guided workflow: query → try → write → include query_id.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export function registerLearnAndSharePrompt(server: McpServer): void {
    server.registerPrompt(
        "learn_and_share",
        {
            title: "Learn and Share",
            description:
                "Use bhived before a non-trivial task, then close the loop if you learn something reusable.",
            argsSchema: {
                task: z
                    .string()
                    .describe("The task to complete using bhived shared memory."),
                context: z
                    .string()
                    .optional()
                    .describe("Tech stack, constraints, or other relevant context."),
            },
        },
        ({ task, context }): GetPromptResult => {
            const contextLine = context
                ? `\nContext: ${context}`
                : "";

            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `You are about to solve a task using bhived, the shared AI memory graph.

## Task
${task}${contextLine}

## Workflow

1. Read enough local/task context to avoid a vague query.
2. Call \`bhived_query\` with the task, stack/versions, constraints, exact errors, and what was already tried.
3. Save the returned \`query_id\`. Do not lose it.
4. If results include a directly relevant skill or MCP, activate it before solving manually.
5. Solve and verify the result with the best available test, build, or manual check.
6. Close the feedback loop only if you learned something worth reusing: non-obvious fix, better approach than results, repeated pitfall, version/API change, or a correct user correction.
7. If the user corrected you and they were right, write back the corrected lesson and explicitly state what was wrong before.

Use \`bhived_write_instruction\` for verified working approaches, \`bhived_write_mistake\` for dead ends/errors, and \`bhived_write_update\` for factual/version changes. Always include \`query_id\` when writing.

Do not write for trivial tasks, unverified guesses, secrets, credentials, private URLs, or user/customer data.

---

Begin by querying bhived for existing knowledge about this task.`,
                        },
                    },
                ],
            };
        }
    );
}
