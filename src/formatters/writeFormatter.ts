/**
 * Write Result Formatter
 *
 * Formats POST /v1/memories response as clean Markdown
 * optimized for LLM parsing.
 *
 * Design: concise confirmation with actionable metadata.
 * The agent needs the memory_id and confirmation — not decoration.
 */

import type { WriteResult } from "../client/types.js";
import { tenancyBanner } from "../tenancy.js";

export function formatWriteResult(
    result: WriteResult,
    memoryType: string,
    queryIdProvided = false
): string {
    const lines: string[] = [];

    lines.push(`# ✅ Memory ${result.action_performed}\n`);
    lines.push(`${tenancyBanner("write")}\n`);
    lines.push(`- **type**: ${memoryType}`);
    lines.push(`- **memory_id**: \`${result.memory_id}\``);
    lines.push(`- **action**: ${result.action_performed}`);

    // A near-duplicate of another author's memory is routed to the trust layer
    // rather than rejected — make the non-obvious semantics explicit.
    if (result.action_performed === "corroborated") {
        lines.push(
            "- **note**: No new memory was created — your write near-duplicated an existing memory by " +
            "another author, so it CORROBORATED that memory instead. `memory_id` above is the existing " +
            "memory you reinforced (its corroboration count went up)."
        );
    } else if (result.action_performed === "contradicted") {
        lines.push(
            "- **note**: Your write near-duplicated an existing memory by another author but OPPOSES it, " +
            "so it was stored as a new dissenting memory that CONTRADICTS the near-match. Both stay active " +
            "and the dispute is surfaced to readers."
        );
    }

    // Graph impact — only show non-zero values
    const impact: string[] = [];
    if (result.entities_created > 0) impact.push(`${result.entities_created} entities created`);
    if (result.entities_merged > 0) impact.push(`${result.entities_merged} entities merged`);
    if (result.relations_created > 0) impact.push(`${result.relations_created} relations`);
    if (result.causal_relations > 0) impact.push(`${result.causal_relations} causal links`);
    if (result.corroborations_created > 0) impact.push(`${result.corroborations_created} corroborations`);
    if (result.contradictions_created > 0) impact.push(`${result.contradictions_created} contradictions`);

    if (impact.length > 0) {
        lines.push(`- **graph_impact**: ${impact.join(", ")}`);
    } else {
        // Per-write ground truth no static description can give: zero graph
        // impact means the memory can't be found via graph retrieval or corroborated.
        lines.push(
            "- **graph_impact**: ⚠️ none — 0 entities extracted, so this memory is invisible to graph " +
            "retrieval and can never be corroborated. Consider superseding it with concrete package/API/version names."
        );
    }

    // Linkage — critical for the feedback loop. null does NOT always mean the
    // caller omitted query_id: self-correction (action='update') writes never
    // link, and an id from a different key/tenant is silently refused.
    if (result.query_id_linked) {
        lines.push(`- **linked_query**: \`${result.query_id_linked}\``);
    } else if (queryIdProvided) {
        lines.push(
            "- **linked_query**: not linked — your query_id could not be linked " +
            "(self-correction `action: \"update\"` writes don't link, and a query_id from a different key/tenant is ignored)."
        );
    } else {
        lines.push(
            "- **linked_query**: none — pass `query_id` from your bhived_query call next time " +
            "so the memories that helped you get corroborated."
        );
    }
    if (result.supersedes_id_linked) {
        lines.push(`- **supersedes**: \`${result.supersedes_id_linked}\``);
    }

    return lines.join("\n");
}

/**
 * Format a duplicate memory error into an actionable message.
 */
export function formatDuplicateError(
    duplicateOf: string,
    similarity: number
): string {
    return [
        "# ⚠️ Near-duplicate detected — memory NOT created\n",
        `- **existing_memory**: \`${duplicateOf}\``,
        `- **similarity**: ${(similarity * 100).toFixed(0)}%\n`,
        "**Next steps:**",
        `1. Inspect the existing memory: use \`bhived_inspect\` with id \`${duplicateOf}\``,
        "2. If it's YOUR memory and your version is better: resubmit the same write with " +
            "`supersedes_id` AND `action: \"update\"` — the only combination that bypasses this " +
            "duplicate check (works only on memories you authored; supported by " +
            "`bhived_write_instruction` and `bhived_write_update`, not `bhived_write_mistake`).",
        "3. If it's someone else's, or a genuinely different variant (different versions/OS/root cause): " +
            "rewrite with distinct wording and its own context — a near-verbatim resubmission is rejected again.",
        "4. If identical, no action needed — the hive already knows this",
    ].join("\n");
}
