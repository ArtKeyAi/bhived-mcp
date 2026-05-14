/**
 * Bhived REST API — TypeScript interfaces
 *
 * These match the response schemas defined in endpoints.md.
 * The MCP server consumes these types; it never defines business logic.
 */

// ─── Health ─────────────────────────────────────────────────────────

export interface HealthStatus {
    status: "ok" | "degraded";
    version: string;
    graph_connected: boolean;
    redis_connected: boolean;
}

// ─── Query ──────────────────────────────────────────────────────────

export interface QueryParams {
    query: string;
    top_k?: number;
    include_episodes?: boolean;
    include_warnings?: boolean;
    include_disputed?: boolean;
    context?: string;
}

export interface QueryMemory {
    id: string;
    text: string;
    title: string;
    type: "instruction" | "mistake" | "update" | "note";
    status: "active" | "archived" | "disputed" | "superseded";
    score: number;
    corroboration_count?: number;
    contradiction_count?: number;
    times_retrieved?: number;

    // Capability enrichment (added by backend when memory is a skill/MCP)
    has_skill?: boolean;
    has_mcp?: boolean;
    skill_meta?: SkillCapabilityMeta;
    mcp_meta?: McpCapabilityMeta;
}

/** Metadata about a skill capability included in query results. */
export interface SkillCapabilityMeta {
    name: string;
    description?: string;
    script_count?: number;
    reference_count?: number;
    asset_count?: number;
    mcp_count?: number;
    mcp_names?: string[];
    usage_count?: number;
    success_rate?: number;
}

/** Metadata about an MCP capability included in query results. */
export interface McpCapabilityMeta {
    name: string;
    description?: string;
    tools_hint?: string[];
    usage_count?: number;
    success_rate?: number;
}

export interface QueryEpisode {
    id: string;
    memories: QueryMemory[];
    topic: string;
}

export interface QueryWarning {
    id: string;
    text: string;
    title: string;
    type: string;
    confidence: number;
    contradicts_memory_id?: string;
}

export interface DisputedPair {
    memory_a: QueryMemory;
    memory_b: QueryMemory;
    dispute_type: string;
}

export interface QueryResult {
    query_id: string;
    recommendations: QueryMemory[];
    episodes?: QueryEpisode[];
    warnings?: QueryWarning[];
    disputed_pairs?: DisputedPair[];
    total_results: number;
}

// ─── Write ──────────────────────────────────────────────────────────

export interface WriteParams {
    text: string;
    title: string;
    type: "instruction" | "mistake" | "update";
    query_id?: string;
    supersedes_id?: string;
    action?: "new" | "update";
    model?: string;
}

export interface WriteResult {
    memory_id: string;
    entities_created: number;
    entities_merged: number;
    relations_created: number;
    causal_relations: number;
    next_edge_created: boolean;
    provenance_steps: number;
    fingerprint_computed: boolean;
    query_id_linked: string | null;
    supersedes_id_linked: string | null;
    action_performed: "created" | "updated" | "superseded";
    corroborations_created: number;
    contradictions_created: number;
}

export interface DuplicateError {
    error: "duplicate_memory";
    duplicate_of: string;
    jaccard_similarity: number;
}

// ─── Memory Detail ──────────────────────────────────────────────────

export interface MemoryDetail {
    id: string;
    text: string;
    title: string;
    type: "instruction" | "mistake" | "update" | "note";
    status: "active" | "archived" | "disputed" | "superseded";
    created_at: string;
    updated_at: string;
    corroboration_count: number;
    contradiction_count: number;
    superseded_count: number;
    times_retrieved: number;
    version_count: number;
    version_history: unknown[];
    version_hash: string;
    responding_to_query: string | null;
    source: string;
    archived_at: string | null;
    restore_count: number;
}

// ─── Memory List ────────────────────────────────────────────────────

export interface MemoryListParams {
    status_filter?: string;
    type_filter?: string;
    limit?: number;
}

export interface MemoryListItem {
    id: string;
    text: string;
    title: string;
    type: string;
    status: string;
    created_at: string;
    updated_at: string;
    corroboration_count: number;
    contradiction_count: number;
    superseded_count: number;
    times_retrieved: number;
    version_count: number;
    source: string;
}

export interface MemoryListResult {
    memories: MemoryListItem[];
    count: number;
    total: number;
}

// ─── Skills & MCPs ──────────────────────────────────────────────────

export interface SkillPayload {
    name: string;
    description: string;
    skill_md: string;
    scripts: Record<string, string>;       // filename → content
    references: Record<string, string>;    // filename → content
    assets: Record<string, string>;        // filename → content
    mcp_configs: McpConfig[];              // bundled MCPs
    compatibility?: Record<string, unknown>;
    license?: string;
    metadata?: Record<string, unknown>;
}

export interface McpConfig {
    name: string;
    description: string;
    command: string;
    args: string[];
    env: Record<string, string>;
}

export interface McpPayload {
    name: string;
    description: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    tools_hint: string[];
    prompts?: McpPromptHint[];
    compatibility?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}

export interface McpPromptHint {
    name: string;
    description: string;
    arguments?: { name: string; required: boolean }[];
}

export interface ActivationResponse {
    ok: boolean;
    capability_type: "skill" | "mcp";
    name: string;
    skill_payload: SkillPayload | null;
    mcp_payload: McpPayload | null;
}

export interface CapabilityReportParams {
    success: boolean;
}

export interface AdminCapabilityReadResponse {
    id: string;
    name: string;
    description: string;
    capability_type: "skill" | "mcp";
    skill_payload: SkillPayload | null;
    mcp_payload: McpPayload | null;
    created_at: string;
    updated_at: string;
}
