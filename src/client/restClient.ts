/**
 * Bhived REST Client
 *
 * Thin fetch-based client for the Bhived FastAPI core.
 * Uses native fetch (Node 18+) with AbortController timeouts
 * and single-retry for transient failures.
 */

import { config } from "../config.js";
import type {
    QueryParams,
    ReadResultV2,
    WriteParams,
    WriteResult,
    MemoryDetail,
    HealthStatus,
    MemoryListParams,
    MemoryListResult,
    ActivationResponse,
    CapabilityReportParams,
    AdminCapabilityReadResponse,
} from "./types.js";

export class BhivedRestClient {
    private readonly baseUrl: string;
    private readonly timeout: number;
    private readonly apiKey: string | undefined;

    constructor(baseUrl?: string, timeout?: number, apiKey?: string) {
        this.baseUrl = (baseUrl ?? config.apiUrl).replace(/\/+$/, "");
        this.timeout = timeout ?? config.timeout;
        this.apiKey = apiKey ?? config.apiKey;
    }

    // ── Public API ──────────────────────────────────────────────────

    /**
     * POST /v2/query — the only query path this client uses. Returns team-hive
     * and public-hive results in SEPARATE sections and honors the
     * `503 models_warming` retry-with-backoff.
     */
    async queryV2(params: QueryParams): Promise<ReadResultV2> {
        return this.post<ReadResultV2>("/v2/query", params);
    }

    async writeMemory(params: WriteParams): Promise<WriteResult> {
        return this.post<WriteResult>("/v1/memories", params);
    }

    async getMemory(memoryId: string): Promise<MemoryDetail> {
        return this.get<MemoryDetail>(`/v1/memories/${encodeURIComponent(memoryId)}`);
    }

    async getHealth(): Promise<HealthStatus> {
        return this.get<HealthStatus>("/health");
    }

    async listMemories(params?: MemoryListParams): Promise<MemoryListResult> {
        const query = new URLSearchParams();
        if (params?.status_filter) query.set("status_filter", params.status_filter);
        if (params?.type_filter) query.set("type_filter", params.type_filter);
        if (params?.limit !== undefined) query.set("limit", String(params.limit));

        const qs = query.toString();
        return this.get<MemoryListResult>(`/v1/memories${qs ? `?${qs}` : ""}`);
    }

    // ── Capability API (Skills & MCPs) ──────────────────────────────

    async activateCapability(memoryId: string): Promise<ActivationResponse> {
        return this.post<ActivationResponse>(
            `/v1/capabilities/${this.encodePathSegments(memoryId)}/activate`
        );
    }

    async reportCapability(
        memoryId: string,
        params: CapabilityReportParams
    ): Promise<{ ok: boolean }> {
        return this.post<{ ok: boolean }>(
            `/v1/capabilities/${this.encodePathSegments(memoryId)}/report`,
            params
        );
    }

    async getSkill(memoryId: string): Promise<AdminCapabilityReadResponse> {
        return this.get<AdminCapabilityReadResponse>(
            `/v1/admin/skills/${this.encodePathSegments(memoryId)}`
        );
    }

    async getMcp(memoryId: string): Promise<AdminCapabilityReadResponse> {
        return this.get<AdminCapabilityReadResponse>(
            `/v1/admin/mcps/${this.encodePathSegments(memoryId)}`
        );
    }

    // ── Path encoding for capability IDs ───────────────────────────
    // Capability IDs may contain slashes (e.g. "org/repo/skill-name").
    // We encode each segment individually while preserving slashes so
    // FastAPI's {memory_id:path} or multi-segment routing works correctly.

    private encodePathSegments(id: string): string {
        return id.split("/").map(encodeURIComponent).join("/");
    }

    // ── Shared headers ──────────────────────────────────────────────

    private buildHeaders(contentType?: string): Record<string, string> {
        const headers: Record<string, string> = {};
        if (contentType) {
            headers["Content-Type"] = contentType;
        }
        if (this.apiKey) {
            headers["X-API-Key"] = this.apiKey;
        }
        return headers;
    }

    // ── HTTP helpers with retry ─────────────────────────────────────

    private async post<T>(path: string, body?: unknown): Promise<T> {
        this.assertAuthenticated();
        return this.requestWithRetry<T>(async (signal) => {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method: "POST",
                headers: this.buildHeaders(body === undefined ? undefined : "application/json"),
                body: body === undefined ? undefined : JSON.stringify(body),
                signal,
            });
            return this.handleResponse<T>(response);
        });
    }

    private async get<T>(path: string): Promise<T> {
        this.assertAuthenticated();
        return this.requestWithRetry<T>(async (signal) => {
            const response = await fetch(`${this.baseUrl}${path}`, {
                headers: this.buildHeaders(),
                signal,
            });
            return this.handleResponse<T>(response);
        });
    }

    private assertAuthenticated(): void {
        if (this.apiKey) return;

        throw new Error(
            "Bhived is not authenticated. Run `npx bhived setup`, " +
            "set BHIVED_API_KEY, or pass `--key YOUR_API_KEY`."
        );
    }

    private async handleResponse<T>(response: Response): Promise<T> {
        if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            const message = errorBody || response.statusText;
            const err = new Error(`REST API error (${response.status}): ${message}`) as Error & {
                statusCode: number;
                body: string;
            };
            err.statusCode = response.status;
            err.body = errorBody;
            throw err;
        }
        return (await response.json()) as T;
    }

    private async requestWithRetry<T>(
        fn: (signal: AbortSignal) => Promise<T>,
        retries = 1
    ): Promise<T> {
        // Two independent retry budgets:
        //  - transient (timeouts, network blips, generic 5xx): short backoff
        //  - models_warming (503 during model warmup): more attempts, longer backoff
        let transientAttempts = 0;
        let warmingAttempts = 0;
        const maxWarmingRetries = config.modelWarmupRetries;

        for (;;) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            try {
                return await fn(controller.signal);
            } catch (error: unknown) {
                const warming = this.isModelsWarming(error);
                const retryable = warming || this.isRetryableError(error);
                const exhausted = warming
                    ? warmingAttempts >= maxWarmingRetries
                    : transientAttempts >= retries;

                if (!retryable || exhausted) {
                    throw this.normalizeError(error);
                }

                let delay: number;
                if (warming) {
                    // Models warming up — back off longer: 1s, 2s, 4s, 8s … capped at 10s.
                    delay = Math.min(1000 * Math.pow(2, warmingAttempts), 10000);
                    warmingAttempts++;
                } else {
                    // Generic transient — short backoff: 500ms, 1000ms, …
                    delay = 500 * Math.pow(2, transientAttempts);
                    transientAttempts++;
                }
                await new Promise((resolve) => setTimeout(resolve, delay));
            } finally {
                clearTimeout(timeoutId);
            }
        }
    }

    private isRetryableError(error: unknown): boolean {
        if (error instanceof DOMException && error.name === "AbortError") return true;
        if (error instanceof TypeError && error.message.includes("fetch")) return true;
        const statusCode = (error as { statusCode?: number }).statusCode;
        return statusCode !== undefined && statusCode >= 500;
    }

    /**
     * Detect the `503 {"error":"models_warming"}` signal the backend returns on
     * /v1/query and /v2/query while embedding/reranker models warm up. This is
     * transient, not fatal — callers should retry with backoff rather than surface
     * it as an error.
     */
    private isModelsWarming(error: unknown): boolean {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode !== 503) return false;

        const body = (error as { body?: string }).body ?? "";
        if (body.includes("models_warming")) return true;
        try {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            const detail = parsed.detail as Record<string, unknown> | string | undefined;
            return (
                parsed.error === "models_warming" ||
                detail === "models_warming" ||
                (typeof detail === "object" && detail?.error === "models_warming")
            );
        } catch {
            return false;
        }
    }

    private normalizeError(error: unknown): Error {
        if (error instanceof DOMException && error.name === "AbortError") {
            return new Error(
                `Request timed out after ${this.timeout}ms. Is Bhived API running at ${this.baseUrl}?`
            );
        }
        if (error instanceof TypeError && error.message.includes("fetch")) {
            return new Error(
                `Cannot connect to Bhived API at ${this.baseUrl}. Is the server running?`
            );
        }
        if (error instanceof Error) return error;
        return new Error(String(error));
    }
}

/** Singleton REST client instance */
export const restClient = new BhivedRestClient();
