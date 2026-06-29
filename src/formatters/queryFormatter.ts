/**
 * Query Result Formatter
 *
 * Formats /v1/query and /v2/query results as clean Markdown optimized for LLM
 * parsing.
 *
 * Design principles:
 * - Markdown for universal LLM readability
 * - Minimal decoration, maximum information density
 * - Clear key:value pairs for reliable extraction
 * - Token-efficient: no box-drawing chars, no emoji spam
 *
 * Skills and MCPs are separated from regular recommendations into dedicated
 * "Recommended Skills" / "Recommended MCPs" sections that display only the
 * description, resources, and activation ID.
 *
 * /v2/query additionally splits results into two tiers — "Your Team's Memory"
 * (team-private) and "Shared Public Brain" (public) — so agents can tell
 * proprietary team knowledge from public knowledge.
 */

import type {
    QueryResult,
    ReadResultV2,
    ReadScope,
    QueryMemory,
    QueryWarning,
    DisputedPair,
    QueryEpisode,
    FailedApproach,
} from "../client/types.js";
import { tenancyBanner, getTenancy } from "../tenancy.js";

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

// ── v1 (merged) ──────────────────────────────────────────────────

export function formatQueryResult(result: QueryResult, scope?: ReadScope): string {
    const sections: string[] = [];

    const recs = result.recommendations ?? [];

    // ── Header + tenancy banner ──
    sections.push(`# bhived Results (${recs.length} found)\n`);
    sections.push(`${tenancyBanner("read")}\n`);

    // ── Recommendations / Skills / MCPs ──
    sections.push(...renderRecommendationSet(recs, scope));

    // ── Warnings / Disputed / Episodes / Failed approaches ──
    sections.push(...renderWarnings(result.warnings ?? []));
    sections.push(...renderDisputed(result.disputed ?? result.disputed_pairs ?? []));
    sections.push(...renderEpisodes(result.episodes ?? []));
    sections.push(...renderFailedApproaches(result.failed_approaches ?? []));

    // ── Query ID (critical for feedback loop) ──
    sections.push(...renderQueryFooter(result.query_id));

    return sections.join("\n");
}

// ── v2 (team vs public separated) ────────────────────────────────

export function formatQueryResultV2(result: ReadResultV2): string {
    const sections: string[] = [];

    const teamRecs = result.team_recommendations ?? [];
    const publicRecs = result.public_recommendations ?? [];

    sections.push("# bhived Results — Team + Public (separated)\n");
    sections.push(`${tenancyBanner("read")}\n`);

    // The "not provisioned as a team key" caveat only makes sense when tenancy is
    // unverified; a confirmed team key would contradict its own banner above.
    const teamEmptyMsg =
        getTenancy().state === "team"
            ? "*No team-private memories matched this query.* Your team hive has nothing on this topic yet — " +
              "this is not a global fallback (public results are shown separately below)."
            : "*No team-private memories matched this query.* If you expected team results, either your team hive " +
              "has nothing on this topic yet, or your key is not provisioned as a team key (it would silently read " +
              "public-only). This is not a global fallback — team and public are shown separately below.";

    // ── 🏠 Team tier ──
    sections.push(`## 🏠 Your Team's Memory (${teamRecs.length} found)\n`);
    sections.push(
        ...renderTier(
            teamRecs,
            result.team_warnings ?? [],
            result.team_disputed ?? [],
            result.team_episodes ?? [],
            result.team_failed_approaches ?? [],
            teamEmptyMsg
        )
    );

    // ── 🌍 Public tier ──
    sections.push(`## 🌍 Shared Public Brain (${publicRecs.length} found)\n`);
    sections.push(
        ...renderTier(
            publicRecs,
            result.public_warnings ?? [],
            result.public_disputed ?? [],
            result.public_episodes ?? [],
            result.public_failed_approaches ?? [],
            "*No public memories matched this query.*"
        )
    );

    sections.push(...renderQueryFooter(result.query_id));

    return sections.join("\n");
}

/**
 * Render one tier (team or public): recommendations + every secondary section,
 * each independent. Warnings/disputed/episodes/failed-approaches are ALWAYS
 * rendered when present — they must never be gated behind the recommendation
 * count, or safety-relevant signals (warnings, contradictions) would be lost
 * when a tier has those but no positively-ranked recommendations.
 */
function renderTier(
    recs: QueryMemory[],
    warnings: QueryWarning[],
    disputed: DisputedPair[],
    episodes: QueryEpisode[],
    failed: FailedApproach[],
    emptyMessage: string
): string[] {
    const out: string[] = [];

    const fullyEmpty =
        recs.length === 0 &&
        warnings.length === 0 &&
        disputed.length === 0 &&
        episodes.length === 0 &&
        failed.length === 0;

    if (fullyEmpty) {
        out.push(`${emptyMessage}\n`);
        return out;
    }

    // Only render the recommendations block when there are recommendations — an
    // empty-rec note here would be noise alongside the warnings/disputed below.
    if (recs.length > 0) {
        out.push(...renderRecommendationSet(recs));
    }
    out.push(...renderWarnings(warnings));
    out.push(...renderDisputed(disputed));
    out.push(...renderEpisodes(episodes));
    out.push(...renderFailedApproaches(failed));

    return out;
}

// ── Shared section renderers ─────────────────────────────────────

/** Partition recommendations into regular / skill / mcp and render each block. */
function renderRecommendationSet(recs: QueryMemory[], scope?: ReadScope): string[] {
    const sections: string[] = [];

    const regularMemories: QueryMemory[] = [];
    const skillMemories: QueryMemory[] = [];
    const mcpMemories: QueryMemory[] = [];

    for (const mem of recs.filter(Boolean)) {
        if (mem.has_skill && mem.skill_meta) {
            skillMemories.push(mem);
        } else if (mem.has_mcp && mem.mcp_meta) {
            mcpMemories.push(mem);
        } else {
            regularMemories.push(mem);
        }
    }

    if (regularMemories.length === 0 && skillMemories.length === 0 && mcpMemories.length === 0) {
        // Under team_only there is NO fallback to public — say so honestly rather
        // than implying a wider search would help (plan §2).
        sections.push(
            scope === "team_only"
                ? "No team-private memories matched. This did NOT fall back to public — your team hive has nothing on this topic yet.\n"
                : "No matching memories found. Try broadening your query.\n"
        );
        return sections;
    }

    if (regularMemories.length > 0) {
        sections.push("## Recommendations\n");
        regularMemories.forEach((mem, i) => {
            sections.push(formatMemory(mem, i + 1));
        });
    }

    if (skillMemories.length > 0) {
        sections.push(formatRecommendedSkills(skillMemories));
    }

    if (mcpMemories.length > 0) {
        sections.push(formatRecommendedMcps(mcpMemories));
    }

    return sections;
}

function renderWarnings(warnings: QueryWarning[]): string[] {
    if (warnings.length === 0) return [];
    const sections = ["## ⚠️ Warnings\n"];
    warnings.forEach((w) => sections.push(formatWarning(w)));
    return sections;
}

function renderDisputed(disputed: DisputedPair[]): string[] {
    if (disputed.length === 0) return [];
    const sections = ["## Disputed Pairs\n"];
    disputed.forEach((pair) => sections.push(formatDisputed(pair)));
    return sections;
}

function renderEpisodes(episodes: QueryEpisode[]): string[] {
    if (episodes.length === 0) return [];
    const sections = ["## Episodes\n"];
    episodes.forEach((ep) => {
        const memIds = (ep.memories ?? []).map((m) => getMemoryId(m)).join(" → ");
        sections.push(`- **${ep.topic}**: ${memIds}`);
    });
    sections.push("");
    return sections;
}

function renderFailedApproaches(failed: FailedApproach[]): string[] {
    if (failed.length === 0) return [];
    const sections = ["## 🚫 Failed Approaches (already tried — don't repeat)\n"];
    failed.forEach((fa) => {
        const title = fa.title ? `**${fa.title}**` : "**(untitled)**";
        const body = fa.reason ?? fa.text ?? "";
        const trimmed = body ? trimTextForReadability(body, MAX_WORDS_SHOWN, getMemoryIdOpt(fa)) : "";
        sections.push(`- ${title}${trimmed ? ` — ${trimmed}` : ""}`);
    });
    sections.push("");
    return sections;
}

function renderQueryFooter(queryId: string): string[] {
    return [
        "---",
        `**query_id**: \`${queryId}\``,
        "Next step: use relevant recommendations or activate matching skills/MCPs, then verify your result. If you learn something reusable or the user correction was right, write back with this query_id (using the SAME key).",
    ];
}

/** Extract memory ID, handling both `id` and `memory_id` field names */
function getMemoryId(mem: QueryMemory): string {
    return mem.id ?? mem.memory_id ?? "unknown";
}

function getMemoryIdOpt(fa: FailedApproach): string | null {
    return fa.id ?? fa.memory_id ?? null;
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
        const usage = sm.usage_count ?? sm.activation_count;
        if (usage !== undefined) stats.push(`used by ${usage} agents`);
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
        const usage = mm.usage_count ?? mm.activation_count;
        if (usage !== undefined) stats.push(`used by ${usage} agents`);
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
    // Tolerate both the flat live shape (memory_a_id/_text) and the legacy nested
    // shape ({memory_a, memory_b} objects). Never assume a nested object exists.
    const disputeType = pair.dispute_type ?? "contradiction";
    const aId = pair.memory_a_id ?? (pair.memory_a ? getMemoryId(pair.memory_a) : "unknown");
    const bId = pair.memory_b_id ?? (pair.memory_b ? getMemoryId(pair.memory_b) : "unknown");
    const aText = pair.memory_a_text ?? pair.memory_a?.title ?? "";
    const bText = pair.memory_b_text ?? pair.memory_b?.title ?? "";
    const conf =
        typeof pair.confidence === "number" ? ` (confidence: ${pair.confidence.toFixed(2)})` : "";

    const snippet = (s: string) => trimTextForReadability(s, 40);

    const lines: string[] = [];
    lines.push(`- **${disputeType}**${conf}`);
    lines.push(`  - A: "${snippet(aText)}" (\`${aId}\`)`);
    lines.push(`  - B: "${snippet(bText)}" (\`${bId}\`)\n`);
    return lines.join("\n");
}
