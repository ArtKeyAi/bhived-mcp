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

// ─── Subscription ───────────────────────────────────────────────────

/**
 * GET /v1/subscription — the authoritative scope signal for the caller's API
 * key (read from the X-API-Key header): `{"plan": "free" | "pro" | "team"}`.
 * Typed loosely because callers must validate before trusting.
 */
export interface SubscriptionStatus {
    plan?: string;
}

// ─── Query ──────────────────────────────────────────────────────────

/**
 * Read scope for /v1/query and /v2/query.
 * - `team_plus_global` (default): the caller's team hive(s) + the global public hive.
 * - `team_only`: only the caller's team hive(s). An empty team hive returns no
 *    results — there is NO fallback to public.
 * - `global_only`: only the global public hive.
 *
 * Tenancy is derived server-side from the API key; `scope` only narrows which of
 * the key's readable hives are searched. It cannot grant access to another tenant.
 */
export type ReadScope = "team_plus_global" | "team_only" | "global_only";

export interface QueryParams {
    query: string;
    top_k?: number;
    include_episodes?: boolean;
    include_warnings?: boolean;
    include_disputed?: boolean;
    context?: string;
    /** Optional read scope. Defaults server-side to `team_plus_global`. */
    scope?: ReadScope;
}

export interface QueryMemory {
    /** Some pipelines return `memory_id` instead of `id`; readers must handle both. */
    id?: string;
    memory_id?: string;
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
    /** Backend may report this instead of `usage_count`. */
    activation_count?: number;
    success_rate?: number;
}

/** Metadata about an MCP capability included in query results. */
export interface McpCapabilityMeta {
    name: string;
    description?: string;
    tools_hint?: string[];
    usage_count?: number;
    /** Backend may report this instead of `usage_count`. */
    activation_count?: number;
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

/**
 * A contradicting memory pair. The live API returns a FLAT shape
 * (`memory_a_id` / `memory_a_text` / `memory_b_id` / `memory_b_text` / `confidence`);
 * older docs described a nested `{memory_a, memory_b, dispute_type}` shape. Readers
 * must tolerate both — every field is optional.
 */
export interface DisputedPair {
    // Flat shape (live API)
    confidence?: number;
    memory_a_id?: string;
    memory_a_text?: string;
    memory_b_id?: string;
    memory_b_text?: string;
    // Legacy nested shape
    dispute_type?: string;
    memory_a?: QueryMemory;
    memory_b?: QueryMemory;
}

/** A "what was already tried and abandoned" note returned by the read pipeline. */
export interface FailedApproach {
    id?: string;
    memory_id?: string;
    text?: string;
    title?: string;
    type?: string;
    reason?: string;
    [key: string]: unknown;
}

/** `ScoredMemory` is the wire name for the ranked-memory shape; identical to QueryMemory. */
export type ScoredMemory = QueryMemory;

/**
 * `ReadResultV2` envelope from POST /v2/query — the only query path this
 * client uses. Team-hive and public-hive results are returned as SEPARATE
 * sections rather than one merged list. Each section receives the request's
 * full `top_k`.
 *
 * Behavior:
 * - Non-team caller → `team_*` lists are empty.
 * - `scope=team_only`   → `public_*` empty.
 * - `scope=global_only` → `team_*` empty.
 * - `query_id` is returned and is the value to pass back on a subsequent write
 *   (it is equivalent to the v1 `query_id` for F1 linking).
 */
export interface ReadResultV2 {
    query?: string;
    query_id: string;

    team_recommendations: ScoredMemory[];
    public_recommendations: ScoredMemory[];

    team_warnings?: QueryWarning[];
    public_warnings?: QueryWarning[];

    team_episodes?: QueryEpisode[];
    public_episodes?: QueryEpisode[];

    team_disputed?: DisputedPair[];
    public_disputed?: DisputedPair[];

    team_failed_approaches?: FailedApproach[];
    public_failed_approaches?: FailedApproach[];

    metadata?: Record<string, unknown>;
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
    action_performed: "created" | "updated" | "superseded" | "corroborated" | "contradicted";
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
