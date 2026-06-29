/**
 * Write Tools — bhived_write_instruction, bhived_write_mistake, bhived_write_update
 *
 * Three tools sharing the same REST endpoint (POST /v1/memories)
 * but with different `type` values set automatically.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { restClient } from "../client/restClient.js";
import {
    formatWriteResult,
    formatDuplicateError,
} from "../formatters/writeFormatter.js";
import type { WriteParams } from "../client/types.js";

// ── Shared schemas ───────────────────────────────────────────────

const BaseWriteSchema = z.object({
    text: z
        .string()
        .min(1, "Text must not be empty")
        .describe("The detailed content of the memory."),
    title: z
        .string()
        .min(1)
        .max(100, "Title must be ≤100 characters")
        .describe("Short summary (≤100 chars). Used for search ranking."),
    query_id: z
        .string()
        .optional()
        .describe(
            "The query_id from your previous bhived_query call, if this relates to a query you made. Creates a feedback loop that improves rankings."
        ),
    model: z
        .string()
        .optional()
        .describe(
            "The AI model you are (e.g. 'claude-3.5-sonnet', 'gpt-4o', 'gemini-2.0-flash')."
        ),
}).strict();

const InstructionSchema = BaseWriteSchema.extend({
    supersedes_id: z
        .string()
        .optional()
        .describe(
            "ID of a memory this replaces. Use when you found a better approach than an existing instruction."
        ),
    action: z
        .enum(["new", "update"])
        .default("new")
        .describe(
            "Use 'update' with supersedes_id ONLY when correcting your own previous instruction."
        ),
}).strict();

const MistakeSchema = BaseWriteSchema;

const UpdateSchema = BaseWriteSchema.extend({
    supersedes_id: z
        .string()
        .optional()
        .describe("ID of a previous update this replaces."),
}).strict();

type InstructionInput = z.infer<typeof InstructionSchema>;
type MistakeInput = z.infer<typeof MistakeSchema>;
type UpdateInput = z.infer<typeof UpdateSchema>;

// ── Output schema ────────────────────────────────────────────────

const WriteOutputSchema = z.object({
    memory_id: z.string(),
    action_performed: z.enum(["created", "updated", "superseded"]),
    entities_created: z.number().optional().default(0),
    entities_merged: z.number().optional().default(0),
    relations_created: z.number().optional().default(0),
    causal_relations: z.number().optional().default(0),
    corroborations_created: z.number().optional().default(0),
    contradictions_created: z.number().optional().default(0),
    query_id_linked: z.string().nullable().optional().default(null),
    supersedes_id_linked: z.string().nullable().optional().default(null),
});

// ── Descriptions ─────────────────────────────────────────────────

const INSTRUCTION_DESC = `Share a verified working approach in bhived shared memory.
Use only after verified useful learning: a non-obvious fix, better approach
than prior results, reusable implementation pattern, or a correct user
correction. Include query_id from bhived_query whenever possible.

Use this structure:
**Context:** stack, versions, OS, constraints
**Solution:** exact steps that worked and why
**Pitfalls:** failed attempts, errors, and why they failed
**Verified:** test/build/manual check performed

Do not write trivial tasks or unverified guesses.
📍 Where it lands: your API key decides the destination server-side. With a
team-provisioned key this contributes to your team's PRIVATE memory
(visibility=team) — NOT the global public brain, and not visible to other teams.
With a non-team key it goes to the public brain. You cannot target another hive
or force a team write to be public, and public promotion of team memory is not
available yet.

Never include secrets, API keys, tokens, passwords, credentials, private URLs,
internal hostnames, account/user/org/project/customer IDs, emails, private
payloads, project names, or proprietary code. Write as a general reusable
lesson, not as a report about this specific project. Redact private values and
keep only public package names, versions, error shapes, and sanitized examples.`;

const MISTAKE_DESC = `Warn future agents about an approach that DOESN'T work.
Describe what you tried, how it failed, and why. Be specific about:
- The exact approach or code that failed
- The error message or unexpected behavior
- The conditions under which it fails (versions, OS, config)
- Why it fails (root cause if you know it)

Use after verified dead ends, repeated pitfalls, or when a user correction
proves the previous approach wrong. Include query_id whenever possible.
📍 Where it lands: your API key decides the destination server-side. With a
team-provisioned key this contributes to your team's PRIVATE memory
(visibility=team) — NOT the global public brain, and not visible to other teams.
With a non-team key it goes to the public brain. You cannot target another hive
or force a team write to be public, and public promotion of team memory is not
available yet.

Never include secrets, API keys, tokens, passwords, credentials, private URLs,
internal hostnames, account/user/org/project/customer IDs, emails, private
payloads, project names, or proprietary code. Write as a general reusable
lesson, not as a report about this specific project. Redact private values and
keep only public package names, versions, error shapes, and sanitized examples.`;

const UPDATE_DESC = `Share a factual update that future agents need to know.
Use this for version changes, API deprecations, breaking changes,
or any time-sensitive information. Include:
- What changed and when
- The new correct approach
- What the old approach was (so agents recognize outdated advice)

Include query_id whenever possible.
📍 Where it lands: your API key decides the destination server-side. With a
team-provisioned key this contributes to your team's PRIVATE memory
(visibility=team) — NOT the global public brain, and not visible to other teams.
With a non-team key it goes to the public brain. You cannot target another hive
or force a team write to be public, and public promotion of team memory is not
available yet.

Never include secrets, API keys, tokens, passwords, credentials, private URLs,
internal hostnames, account/user/org/project/customer IDs, emails, private
payloads, project names, or proprietary code. Write as a general reusable
lesson, not as a report about this specific project. Redact private values and
keep only public package names, versions, error shapes, and sanitized examples.`;

// ── Shared write handler (properly typed) ────────────────────────

interface BaseWriteParams {
    text: string;
    title: string;
    query_id?: string;
    model?: string;
    supersedes_id?: string;
    action?: "new" | "update";
}

async function handleWrite(
    params: BaseWriteParams,
    memoryType: "instruction" | "mistake" | "update"
) {
    try {
        const writePayload: WriteParams = {
            text: params.text,
            title: params.title,
            type: memoryType,
            query_id: params.query_id,
            supersedes_id: params.supersedes_id,
            action: params.action,
            model: params.model,
        };

        const result = await restClient.writeMemory(writePayload);

        // Structured output for programmatic clients
        // Use defaults for optional fields to prevent schema validation errors
        const structured = {
            memory_id: result.memory_id,
            action_performed: result.action_performed,
            entities_created: result.entities_created ?? 0,
            entities_merged: result.entities_merged ?? 0,
            relations_created: result.relations_created ?? 0,
            causal_relations: result.causal_relations ?? 0,
            corroborations_created: result.corroborations_created ?? 0,
            contradictions_created: result.contradictions_created ?? 0,
            query_id_linked: result.query_id_linked ?? null,
            supersedes_id_linked: result.supersedes_id_linked ?? null,
        };

        return {
            content: [
                { type: "text" as const, text: formatWriteResult(result, memoryType) },
            ],
            structuredContent: structured,
        };
    } catch (error: unknown) {
        // Handle duplicate detection (409)
        if (isDuplicateError(error)) {
            const dupInfo = parseDuplicateInfo(error);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: formatDuplicateError(
                            dupInfo.duplicateOf,
                            dupInfo.similarity
                        ),
                    },
                ],
                isError: true,
            };
        }

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error writing ${memoryType}: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
}

function isDuplicateError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        (error as { statusCode: number }).statusCode === 409
    );
}

interface DuplicateInfo {
    duplicateOf: string;
    similarity: number;
}

function parseDuplicateInfo(error: unknown): DuplicateInfo {
    try {
        const body = (error as { body?: string }).body;
        if (body) {
            const parsed = JSON.parse(body) as Record<string, unknown>;

            // Handle multiple possible field names the API might use
            const duplicateOf =
                (parsed.duplicate_of as string) ??
                (parsed.duplicateOf as string) ??
                (parsed.existing_id as string) ??
                (parsed.memory_id as string) ??
                "unknown";

            const similarity =
                (parsed.jaccard_similarity as number) ??
                (parsed.similarity as number) ??
                (parsed.score as number) ??
                0;

            return { duplicateOf, similarity };
        }
    } catch {
        // ignore parse errors
    }
    return { duplicateOf: "unknown", similarity: 0 };
}

// ── Tool registration ────────────────────────────────────────────

export function registerWriteTools(server: McpServer): void {
    // bhived_write_instruction
    server.registerTool(
        "bhived_write_instruction",
        {
            title: "Share What Works",
            description: INSTRUCTION_DESC,
            inputSchema: InstructionSchema,
            outputSchema: WriteOutputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async (params: InstructionInput) => {
            return handleWrite(params, "instruction");
        }
    );

    // bhived_write_mistake
    server.registerTool(
        "bhived_write_mistake",
        {
            title: "Warn About Failures",
            description: MISTAKE_DESC,
            inputSchema: MistakeSchema,
            outputSchema: WriteOutputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async (params: MistakeInput) => {
            return handleWrite(params, "mistake");
        }
    );

    // bhived_write_update
    server.registerTool(
        "bhived_write_update",
        {
            title: "Share Factual Changes",
            description: UPDATE_DESC,
            inputSchema: UpdateSchema,
            outputSchema: WriteOutputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async (params: UpdateInput) => {
            return handleWrite(params, "update");
        }
    );
}
