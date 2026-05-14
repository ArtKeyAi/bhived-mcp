/**
 * Inspect Formatter
 *
 * Formats GET /v1/memories/{id} response as clean Markdown
 * optimized for LLM parsing.
 *
 * Design: structured sections with clear key:value pairs
 * for reliable extraction. Uses markdown semantics that
 * every LLM understands natively.
 */

import type { MemoryDetail } from "../client/types.js";

export function formatInspectResult(mem: MemoryDetail): string {
    const lines: string[] = [];

    lines.push(`# Memory: ${mem.title}\n`);

    // Identity
    lines.push("## Overview\n");
    lines.push(`- **id**: \`${mem.id}\``);
    lines.push(`- **type**: ${mem.type}`);
    lines.push(`- **status**: ${formatStatus(mem.status)}`);
    lines.push(`- **source**: ${mem.source}`);

    // Full text
    lines.push(`\n## Content\n`);
    lines.push(`${mem.text}`);

    // Evolution metrics — the core data agents need
    lines.push(`\n## Evolution\n`);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Corroborations | ${mem.corroboration_count} |`);
    lines.push(`| Contradictions | ${mem.contradiction_count} |`);
    lines.push(`| Superseded by | ${mem.superseded_count} |`);
    lines.push(`| Times retrieved | ${mem.times_retrieved} |`);
    lines.push(`| Version | ${mem.version_count} |`);
    lines.push(`| Version hash | \`${mem.version_hash}\` |`);
    if (mem.restore_count > 0) {
        lines.push(`| Restore count | ${mem.restore_count} |`);
    }

    // Timeline
    lines.push(`\n## Timeline\n`);
    lines.push(`- **created**: ${formatDate(mem.created_at)}`);
    lines.push(`- **updated**: ${formatDate(mem.updated_at)}`);
    if (mem.archived_at) {
        lines.push(`- **archived**: ${formatDate(mem.archived_at)}`);
    }

    // Linkage
    if (mem.responding_to_query) {
        lines.push(`\n## Linkage\n`);
        lines.push(`- **responding_to_query**: \`${mem.responding_to_query}\``);
    }

    return lines.join("\n");
}

function formatStatus(status: string): string {
    const labels: Record<string, string> = {
        active: "🟢 active",
        archived: "archived",
        disputed: "⚠️ disputed",
        superseded: "superseded",
    };
    return labels[status] ?? status;
}

function formatDate(iso: string): string {
    try {
        return new Date(iso).toISOString();
    } catch {
        return iso;
    }
}
