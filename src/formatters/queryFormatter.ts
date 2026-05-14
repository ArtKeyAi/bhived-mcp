/**
 * Query Result Formatter
 *
 * Formats /v1/query results as clean Markdown optimized for LLM parsing.
 *
 * Design principles:
 * - Markdown for universal LLM readability
 * - Minimal decoration, maximum information density
 * - Clear key:value pairs for reliable extraction
 * - Token-efficient: no box-drawing chars, no emoji spam
 *
 * Skills and MCPs are separated from regular recommendations into
 * dedicated "Recommended Skills" / "Recommended MCPs" sections that
 * display only the description, resources, and activation ID.
 */

import type { QueryResult, QueryMemory, QueryWarning, DisputedPair } from "../client/types.js";

// ── Max items for capability sections ────────────────────────────
const MAX_SKILLS_SHOWN = 10;
const MAX_MCPS_SHOWN = 10;
const MAX_WORDS_SHOWN = 200;

function trimTextForReadability(text: string, maxWords: number, memId: string | null = null): string {
    if (!text) return text;
    const words = text.trim().split(/\s+/);
    if (words.length <= maxWords) return text;
    const truncated = words.slice(0, maxWords).join(" ");
    let notice = `\n\n> ✂️ **Note:** Text truncated (${words.length} words).`;
    if (memId) {
        notice += ` Use \`bhived_inspect(memory_id="${memId}")\` to read the full text.`;
    }
    return `${truncated}...${notice}`;
}

export function formatQueryResult(result: QueryResult): string {
    const sections: string[] = [];

    const recs = result.recommendations ?? [];

    // ── Partition: separate skill/mcp memories from regular memories ──
    const regularMemories: QueryMemory[] = [];
    const skillMemories: QueryMemory[] = [];
    const mcpMemories: QueryMemory[] = [];

    for (const mem of recs) {
        if (mem.has_skill && mem.skill_meta) {
            skillMemories.push(mem);
        } else if (mem.has_mcp && mem.mcp_meta) {
            mcpMemories.push(mem);
        } else {
            regularMemories.push(mem);
        }
    }

    // ── Header ──
    sections.push(`# bhived Results (${recs.length} found)\n`);

    // ── Regular Recommendations (non-skill, non-mcp) ──
    if (regularMemories.length === 0 && skillMemories.length === 0 && mcpMemories.length === 0) {
        sections.push("No matching memories found. Try broadening your query.\n");
    } else if (regularMemories.length > 0) {
        sections.push("## Recommendations\n");
        regularMemories.forEach((mem, i) => {
            sections.push(formatMemory(mem, i + 1));
        });
    }

    // ── Recommended Skills section ──
    if (skillMemories.length > 0) {
        sections.push(formatRecommendedSkills(skillMemories));
    }

    // ── Recommended MCPs section ──
    if (mcpMemories.length > 0) {
        sections.push(formatRecommendedMcps(mcpMemories));
    }

    // ── Warnings ──
    const warnings = result.warnings ?? [];
    if (warnings.length > 0) {
        sections.push("## ⚠️ Warnings\n");
        warnings.forEach((w) => {
            sections.push(formatWarning(w));
        });
    }

    // ── Disputed Pairs ──
    const disputed = result.disputed_pairs ?? [];
    if (disputed.length > 0) {
        sections.push("## Disputed Pairs\n");
        disputed.forEach((pair) => {
            sections.push(formatDisputed(pair));
        });
    }

    // ── Episodes ──
    const episodes = result.episodes ?? [];
    if (episodes.length > 0) {
        sections.push("## Episodes\n");
        episodes.forEach((ep) => {
            const memIds = ep.memories.map(m => getMemoryId(m)).join(" → ");
            sections.push(`- **${ep.topic}**: ${memIds}`);
        });
        sections.push("");
    }

    // ── Query ID (critical for feedback loop) ──
    sections.push("---");
    sections.push(`**query_id**: \`${result.query_id}\``);
    sections.push("Next step: use relevant recommendations or activate matching skills/MCPs, then verify your result. If you learn something reusable or the user correction was right, write back with this query_id.");

    return sections.join("\n");
}

/** Extract memory ID, handling both `id` and `memory_id` field names */
function getMemoryId(mem: QueryMemory): string {
    return mem.id ?? (mem as unknown as Record<string, unknown>)["memory_id"] as string ?? "unknown";
}

/**
 * Format a regular (non-skill, non-mcp) memory recommendation.
 * No capability badges — skills/MCPs have their own section.
 */
function formatMemory(mem: QueryMemory, rank: number): string {
    const lines: string[] = [];
    const memId = getMemoryId(mem);

    // Header: rank, type badge, and title
    const title = mem.title ? `**${mem.title}**` : "_(untitled)_";
    lines.push(`### ${rank}. [${mem.type ?? "memory"}] ${title}\n`);

    // Metadata line — compact key:value pairs
    const meta: string[] = [];
    meta.push(`score: ${mem.score?.toFixed(2) ?? "N/A"}`);
    if (mem.corroboration_count && mem.corroboration_count > 0) {
        meta.push(`+${mem.corroboration_count} corroborated`);
    }
    if (mem.contradiction_count && mem.contradiction_count > 0) {
        meta.push(`-${mem.contradiction_count} contradicted`);
    }
    if (mem.times_retrieved && mem.times_retrieved > 0) {
        meta.push(`${mem.times_retrieved}× retrieved`);
    }
    if (memId !== "unknown") {
        meta.push(`id: \`${memId}\``);
    }
    lines.push(`> ${meta.join(" · ")}\n`);

    // Content
    const content = mem.text ? trimTextForReadability(mem.text, MAX_WORDS_SHOWN, memId) : "";
    lines.push(`${content}\n`);

    return lines.join("\n");
}

// ── Recommended Skills section ──────────────────────────────────

/**
 * Format a dedicated "Recommended Skills" section.
 * Shows description, resources, and the memory_id to activate.
 */
function formatRecommendedSkills(skills: QueryMemory[]): string {
    const lines: string[] = [];
    lines.push("## 🔧 Recommended Skills\n");
    lines.push("> Activate a skill with `bhived_initiate_skill(memory_id)` to load its instructions, scripts, and resources.\n");

    const shown = skills.slice(0, MAX_SKILLS_SHOWN);
    shown.forEach((mem, i) => {
        const sm = mem.skill_meta!;
        const memId = getMemoryId(mem);

        // Skill name (bold)
        lines.push(`### ${i + 1}. ${sm.name}\n`);

        // Description
        if (sm.description) {
            const desc = trimTextForReadability(sm.description, MAX_WORDS_SHOWN, memId);
            lines.push(`${desc}\n`);
        }

        // Resources table
        const resources: string[] = [];
        if (sm.script_count) resources.push(`${sm.script_count} scripts`);
        if (sm.reference_count) resources.push(`${sm.reference_count} references`);
        if (sm.asset_count) resources.push(`${sm.asset_count} assets`);
        if (sm.mcp_count) {
            const names = sm.mcp_names ? ` (${sm.mcp_names.join(", ")})` : "";
            resources.push(`${sm.mcp_count} bundled MCP(s)${names}`);
        }
        if (resources.length > 0) {
            lines.push(`📦 **Resources:** ${resources.join(" · ")}\n`);
        }

        // Usage stats (if available)
        const stats: string[] = [];
        if (sm.usage_count !== undefined) stats.push(`used by ${sm.usage_count} agents`);
        if (sm.success_rate !== undefined) stats.push(`success: ${Math.round(sm.success_rate * 100)}%`);
        if (stats.length > 0) {
            lines.push(`📊 ${stats.join(" · ")}\n`);
        }

        // Activation ID — the key piece
        lines.push(`🆔 **Activate:** \`memory_id="${memId}"\`\n`);
    });

    if (skills.length > MAX_SKILLS_SHOWN) {
        lines.push(`> ${skills.length - MAX_SKILLS_SHOWN} more skill(s) found but not shown.\n`);
    }

    return lines.join("\n");
}

// ── Recommended MCPs section ────────────────────────────────────

/**
 * Format a dedicated "Recommended MCPs" section.
 * Shows description, tools hint, and the memory_id to activate.
 */
function formatRecommendedMcps(mcps: QueryMemory[]): string {
    const lines: string[] = [];
    lines.push("## 🔌 Recommended MCPs\n");
    lines.push("> Activate an MCP with `bhived_initiate_mcp(memory_id)` to spawn it and use its tools.\n");

    const shown = mcps.slice(0, MAX_MCPS_SHOWN);
    shown.forEach((mem, i) => {
        const mm = mem.mcp_meta!;
        const memId = getMemoryId(mem);

        // MCP name (bold)
        lines.push(`### ${i + 1}. ${mm.name}\n`);

        // Description
        if (mm.description) {
            const desc = trimTextForReadability(mm.description, MAX_WORDS_SHOWN, memId);
            lines.push(`${desc}\n`);
        }

        // Tools
        if (mm.tools_hint && mm.tools_hint.length > 0) {
            lines.push(`🔧 **Tools:** ${mm.tools_hint.join(", ")}\n`);
        }

        // Usage stats (if available)
        const stats: string[] = [];
        if (mm.usage_count !== undefined) stats.push(`used by ${mm.usage_count} agents`);
        if (mm.success_rate !== undefined) stats.push(`success: ${Math.round(mm.success_rate * 100)}%`);
        if (stats.length > 0) {
            lines.push(`📊 ${stats.join(" · ")}\n`);
        }

        // Activation ID — the key piece
        lines.push(`🆔 **Activate:** \`memory_id="${memId}"\`\n`);
    });

    if (mcps.length > MAX_MCPS_SHOWN) {
        lines.push(`> ${mcps.length - MAX_MCPS_SHOWN} more MCP(s) found but not shown.\n`);
    }

    return lines.join("\n");
}

// ── Standard formatting helpers ─────────────────────────────────

function formatWarning(w: QueryWarning): string {
    const lines: string[] = [];
    const title = w.title ? `**${w.title}**` : "";

    lines.push(`- **[${w.type}]** ${title} (confidence: ${w.confidence?.toFixed(2) ?? "N/A"})`);
    if (w.contradicts_memory_id) {
        lines.push(`  contradicts: \`${w.contradicts_memory_id}\``);
    }
    const content = w.text ? trimTextForReadability(w.text, MAX_WORDS_SHOWN) : "";
    lines.push(`  ${content}\n`);

    return lines.join("\n");
}

function formatDisputed(pair: DisputedPair): string {
    const lines: string[] = [];
    lines.push(`- **${pair.dispute_type}**`);
    lines.push(`  - A: [${pair.memory_a.type}] "${pair.memory_a.title}" (\`${getMemoryId(pair.memory_a)}\`)`);
    lines.push(`  - B: [${pair.memory_b.type}] "${pair.memory_b.title}" (\`${getMemoryId(pair.memory_b)}\`)\n`);
    return lines.join("\n");
}
