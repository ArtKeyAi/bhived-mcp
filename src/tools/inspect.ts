/**
 * bhived_inspect Tool
 *
 * Inspects the full state of a memory in the knowledge graph.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { restClient } from "../client/restClient.js";
import { formatInspectResult } from "../formatters/inspectFormatter.js";

const InspectInputSchema = z.object({
    memory_id: z
        .string()
        .min(1, "Memory ID must not be empty")
        .describe("The ID of the memory to inspect."),
}).strict();

type InspectInput = z.infer<typeof InspectInputSchema>;

// Output schema for structured content
const InspectOutputSchema = z.object({
    id: z.string(),
    text: z.string(),
    title: z.string(),
    type: z.string(),
    status: z.string(),
    source: z.string().optional().default("unknown"),
    created_at: z.string(),
    updated_at: z.string(),
    corroboration_count: z.number().optional().default(0),
    contradiction_count: z.number().optional().default(0),
    superseded_count: z.number().optional().default(0),
    times_retrieved: z.number().optional().default(0),
    version_count: z.number().optional().default(1),
    version_hash: z.string().optional().default(""),
    responding_to_query: z.string().nullable().optional().default(null),
    archived_at: z.string().nullable().optional().default(null),
    restore_count: z.number().optional().default(0),
});

const INSPECT_DESC = `Inspect the full state of a memory in the knowledge graph.
Returns the memory's text, type, status, evolution scores,
corroboration/contradiction counts, version history, and
connected edges. Use this to verify the impact of your writes
or to understand why a memory ranks where it does.`;

export function registerInspectTool(server: McpServer): void {
    server.registerTool(
        "bhived_inspect",
        {
            title: "Inspect Memory State",
            description: INSPECT_DESC,
            inputSchema: InspectInputSchema,
            outputSchema: InspectOutputSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: InspectInput) => {
            try {
                const memory = await restClient.getMemory(params.memory_id);

                // Structured output for programmatic clients
                // Use defaults for optional fields to prevent schema validation errors
                const structured = {
                    id: memory.id,
                    text: memory.text,
                    title: memory.title,
                    type: memory.type,
                    status: memory.status,
                    source: memory.source ?? "unknown",
                    created_at: memory.created_at,
                    updated_at: memory.updated_at,
                    corroboration_count: memory.corroboration_count ?? 0,
                    contradiction_count: memory.contradiction_count ?? 0,
                    superseded_count: memory.superseded_count ?? 0,
                    times_retrieved: memory.times_retrieved ?? 0,
                    version_count: memory.version_count ?? 1,
                    version_hash: memory.version_hash ?? "",
                    responding_to_query: memory.responding_to_query ?? null,
                    archived_at: memory.archived_at ?? null,
                    restore_count: memory.restore_count ?? 0,
                };

                return {
                    content: [
                        { type: "text" as const, text: formatInspectResult(memory) },
                    ],
                    structuredContent: structured,
                };
            } catch (error: unknown) {
                const statusCode = (error as { statusCode?: number }).statusCode;

                if (statusCode === 404) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Memory not found: ${params.memory_id}. Check the ID and try again.`,
                            },
                        ],
                        isError: true,
                    };
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error inspecting memory: ${error instanceof Error ? error.message : String(error)}`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );
}
