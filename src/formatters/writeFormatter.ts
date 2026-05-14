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

export function formatWriteResult(result: WriteResult, memoryType: string): string {
    const lines: string[] = [];

    lines.push(`# ✅ Memory ${result.action_performed}\n`);
    lines.push(`- **type**: ${memoryType}`);
    lines.push(`- **memory_id**: \`${result.memory_id}\``);
    lines.push(`- **action**: ${result.action_performed}`);

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
    }

    // Linkage — critical for the feedback loop
    if (result.query_id_linked) {
        lines.push(`- **linked_query**: \`${result.query_id_linked}\``);
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
        "2. If your version is better, resubmit with `supersedes_id` to replace it",
        "3. If identical, no action needed — the hive already knows this",
    ].join("\n");
}
