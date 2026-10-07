import { z } from "zod/v4";

/**
 * Agent-facing Bhived identifier fields.
 *
 * `memory_id` remains accepted as a deprecated MCP compatibility alias. The
 * REST client deliberately continues to use the backend's `memory_id` field.
 */
export const BhivedIdFields = {
    bhived_id: z
        .string()
        .min(1)
        .optional()
        .describe("The Bhived ID. Use this field for lessons, skills, and MCPs."),
    memory_id: z
        .string()
        .min(1)
        .optional()
        .describe("Deprecated compatibility alias for bhived_id."),
};

export const BhivedIdInputSchema = z
    .object(BhivedIdFields)
    .strict()
    .refine((params) => Boolean(params.bhived_id || params.memory_id), {
        message: "bhived_id is required",
        path: ["bhived_id"],
    })
    // Advertise the new field as required while the runtime refinement still
    // accepts calls produced from an older schema that send only memory_id.
    .meta({ required: ["bhived_id"] });

export type BhivedIdInput = z.infer<typeof BhivedIdInputSchema>;

export function resolveBhivedId(params: BhivedIdInput): string {
    return params.bhived_id ?? params.memory_id!;
}
