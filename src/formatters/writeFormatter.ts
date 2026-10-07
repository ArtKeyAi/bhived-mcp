/**
 * Write Result Formatter
 *
 * Formats POST /v1/memories response as clean Markdown
 * optimized for LLM parsing.
 *
 * Design: concise confirmation with actionable metadata.
 * The agent needs the bhived_id and confirmation — not decoration.
 */

import type { WriteResult } from "../client/types.js";
import { tenancyBanner } from "../tenancy.js";

export function formatWriteResult(
    result: WriteResult,
    memoryType: string,
    queryIdProvided = false,
    supersedesIdRequested?: string,
    replayed = false
): string {
    const lines: string[] = [];

    const ignoredSupersede = supersedeNotApplied(result, supersedesIdRequested);

    lines.push(
        ignoredSupersede
            ? `# ⚠️ Lesson ${result.action_performed} — the old lesson was NOT replaced\n`
            : `# ✅ Lesson ${result.action_performed}\n`
    );
    lines.push(`${tenancyBanner("write")}\n`);
    lines.push(`- **type**: ${memoryType}`);
    lines.push(`- **bhived_id**: \`${result.memory_id}\``);
    lines.push(`- **action**: ${result.action_performed}`);

    // The server matched this write's Idempotency-Key to an earlier attempt
    // that had finished, and returned that attempt's result.
    if (replayed) {
        lines.push(
            "- **note**: This write had already been saved by an earlier attempt — nothing new was created. " +
            "The details below are from that save."
        );
    }

    // A near-duplicate of another author's lesson is routed to the trust layer
    // rather than rejected — make the non-obvious semantics explicit.
    if (result.action_performed === "corroborated") {
        lines.push(
            "- **note**: No new lesson was created — your write near-duplicated an existing lesson by " +
            "another author, so it CORROBORATED that lesson instead. `bhived_id` above is the existing " +
            "lesson you reinforced (its corroboration count went up)."
        );
    } else if (result.action_performed === "contradicted") {
        lines.push(
            "- **note**: Your write near-duplicated an existing lesson by another author but OPPOSES it, " +
            "so it was stored as a new dissenting lesson that CONTRADICTS the near-match. Both stay active " +
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
    } else if (result.action_performed !== "corroborated") {
        // (A corroboration created no lesson of its own, so this doesn't apply.)
        // Per-write ground truth no static description can give: zero graph
        // impact means the lesson can't be found via graph retrieval or corroborated.
        lines.push(
            "- **graph_impact**: ⚠️ none — 0 entities extracted, so this lesson is invisible to graph " +
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
            "so the lessons that helped you get corroborated."
        );
    }
    if (result.supersedes_id_linked) {
        lines.push(`- **supersedes**: \`${result.supersedes_id_linked}\``);
    } else if (ignoredSupersede) {
        lines.push(ignoredSupersede);
    }

    return lines.join("\n");
}

/**
 * The backend treats a supersede of a lesson this key didn't write as a plain
 * write and returns supersedes_id_linked: null. Explain what happened instead,
 * so a ✅ never hides that the old lesson is still live. Null when the
 * supersede applied, wasn't requested, or was an in-place "updated" revision
 * (which may not echo the link).
 */
function supersedeNotApplied(result: WriteResult, requested: string | undefined): string | null {
    if (!requested || result.supersedes_id_linked) return null;
    if (result.action_performed === "updated" || result.action_performed === "superseded") return null;

    const base = `- **supersedes**: ⚠️ not applied — \`${requested}\` is unchanged and still active.`;
    const ownOnly = "You can only supersede lessons written by your own key.";
    if (result.action_performed === "corroborated") {
        return result.memory_id === requested
            ? `${base} Your write was so close to it that it counted as agreement (a corroboration), ` +
              "not a correction. If that lesson is wrong, say why with `bhived_write_mistake`."
            : `${base} ${ownOnly} Your write corroborated a different existing lesson (\`${result.memory_id}\`) instead.`;
    }
    if (result.action_performed === "contradicted") {
        return `${base} ${ownOnly} Your write was stored as a dissenting lesson, so readers already see the dispute.`;
    }
    return (
        `${base} ${ownOnly} This write was saved as a separate lesson. ` +
        "If the old lesson is wrong, record why with `bhived_write_mistake` so readers see the dispute."
    );
}

/**
 * Format a duplicate lesson error into an actionable message.
 */
export function formatDuplicateError(
    duplicateOf: string,
    similarity: number
): string {
    return [
        "# ⚠️ Near-duplicate detected — lesson NOT created\n",
        `- **existing_bhived_id**: \`${duplicateOf}\``,
        `- **similarity**: ${Number.isFinite(similarity) ? `${(similarity * 100).toFixed(0)}%` : "unknown"}\n`,
        "**Next steps:**",
        `1. Inspect the existing lesson: use \`bhived_inspect\` with \`bhived_id: "${duplicateOf}"\``,
        "2. If it's YOUR lesson and your version is better: resubmit the same write with " +
            "`supersedes_id` AND `action: \"update\"` — the only combination that bypasses this " +
            "duplicate check (works only on lessons you authored; supported by " +
            "`bhived_write_instruction` and `bhived_write_update`, not `bhived_write_mistake`).",
        "3. If it's someone else's, or a genuinely different variant (different versions/OS/root cause): " +
            "rewrite with distinct wording and its own context — a near-verbatim resubmission is rejected again.",
        "4. If identical, no action needed — the hive already knows this",
    ].join("\n");
}

/**
 * A write that timed out, lost its connection, kept failing with 5xx, or was
 * still running when the client gave up. The lesson may exist, so steer the
 * agent away from rewording it (which would dodge the duplicate check) and
 * toward an identical retry, which reuses the same Idempotency-Key.
 */
export function formatUnknownWriteOutcome(memoryType: string, cause: string): string {
    return [
        "# ⚠️ Write outcome unknown — it may still have been saved\n",
        `- **cause**: ${cause}`,
        "- Do NOT rewrite this lesson in different words: if it was saved, a reworded copy becomes a duplicate.",
        `- Calling \`bhived_write_${memoryType}\` again with IDENTICAL content (same title, text, query_id, ` +
            "supersedes_id, action and model) is safe: it reuses this write's idempotency key, so the lesson is " +
            "saved at most once and you get the existing one back if this attempt went through.",
    ].join("\n");
}

/**
 * One-line messages for the 422 idempotency rejections. Null for any other
 * error code. Neither rejection saved anything.
 */
export function formatIdempotencyError(memoryType: string, code: string | undefined): string | null {
    if (code === "idempotency_key_reused") {
        return `Error writing ${memoryType}: rejected (idempotency_key_reused) — this write's idempotency key was ` +
            "already used for different content. Nothing was saved; calling the tool again sends a fresh key.";
    }
    if (code === "invalid_idempotency_key") {
        return `Error writing ${memoryType}: rejected (invalid_idempotency_key) — the server refused the ` +
            "idempotency key bhived-mcp generated. Nothing was saved; this is a bhived-mcp bug, so please report it.";
    }
    return null;
}
