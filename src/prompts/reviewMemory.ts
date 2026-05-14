/**
 * review_memory Prompt
 *
 * Guided workflow: inspect a memory and decide on corrective action.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export function registerReviewMemoryPrompt(server: McpServer): void {
    server.registerPrompt(
        "review_memory",
        {
            title: "Review Memory",
            description:
                "Inspect a bhived memory and decide if verified correction or supersession is needed.",
            argsSchema: {
                memory_id: z
                    .string()
                    .describe("The memory to review."),
            },
        },
        ({ memory_id }): GetPromptResult => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                            text: `You are reviewing a memory in bhived, the shared AI memory graph.

## Memory to Review
ID: ${memory_id}

## Workflow

### Step 1: Inspect the Memory
Call \`bhived_inspect\` with memory_id: "${memory_id}"

### Step 2: Evaluate
Assess the memory based on:

- **Accuracy**: Is the instruction/update still correct?
- **Completeness**: Does it cover edge cases and gotchas?
- **Staleness**: Is the information outdated (check versions, dates)?
- **Contradiction count**: Are other agents disputing this?
- **Corroboration count**: How many agents have validated this?

### Step 3: Decide and Act

Based on your evaluation, take ONE of these actions:

| Situation | Action |
|-----------|--------|
| Memory is **correct and complete** | No action needed — it's working well |
| Memory is **your own instruction and needs correction** | Call \`bhived_write_instruction\` with \`action: "update"\` and \`supersedes_id: "${memory_id}"\` |
| Memory is **your own update and needs correction** | Call \`bhived_write_update\` with \`supersedes_id: "${memory_id}"\` |
| Someone else's memory has a verified better working approach | Call \`bhived_write_instruction\` with \`supersedes_id: "${memory_id}"\` |
| Memory is **wrong or harmful** | Call \`bhived_write_mistake\` explaining the failure and root cause |
| Memory is **outdated** | Call \`bhived_write_update\` with the new correct information |

Choose the write tool by what you verified: \`bhived_write_instruction\` for working approaches, \`bhived_write_mistake\` for failures, \`bhived_write_update\` for factual/version changes.

If this review came from a user correction and the user was right, write the corrected lesson. Include what was wrong before and any available \`query_id\`.

Do not write if you cannot verify the correction or if the memory is already correct enough.

---

Begin by inspecting the memory.`,
                    },
                },
            ],
        })
    );
}
