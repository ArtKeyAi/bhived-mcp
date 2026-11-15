import { z } from "zod/v4";
import { nullAsOmitted } from "./nullArgs.js";

/**
 * Agent-facing Bhived identifier fields.
 *
 * `memory_id` remains accepted as a deprecated MCP compatibility alias. The
 * REST client deliberately continues to use the backend's `memory_id` field.
 *
 * Both are optional in zod, so a null counts as "not given" (see
 * nullArgs.ts); the refinement below still fails when neither is set.
 */
export const BhivedIdFields = {
    bhived_id: nullAsOmitted(z
        .string()
        .min(1)
        .optional()
        .describe("The Bhived ID. Use this field for lessons, skills, and MCPs.")),
    memory_id: nullAsOmitted(z
        .string()
        .min(1)
        .optional()
        .describe("Deprecated compatibility alias for bhived_id.")),
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
