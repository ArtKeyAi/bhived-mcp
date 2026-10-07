/**
 * Bhived REST Client
 *
 * Thin fetch-based client for the Bhived FastAPI core.
 * Uses native fetch (Node 18+) with AbortController timeouts
 * and single-retry for transient failures. Writes carry an
 * Idempotency-Key and follow their own retry policy (writeMemory).
 */

import { config } from "../config.js";
import type {
    QueryParams,
    ReadResultV2,
    WriteParams,
    WriteResult,
    WriteOutcome,
    MemoryDetail,
    HealthStatus,
    SubscriptionStatus,
    MemoryListParams,
    MemoryListResult,
    ActivationResponse,
    CapabilityReportParams,
    AdminCapabilityReadResponse,
} from "./types.js";

// ── Write retry policy ──────────────────────────────────────────────
// Overall budget for one write, polling included (the server's own write
// timeout is 110s).
const WRITE_DEADLINE_MS = 150_000;
// Never start an attempt with less than this left of the deadline.
const MIN_WRITE_ATTEMPT_MS = 1_000;
// 409 write_in_progress without a usable Retry-After.
const DEFAULT_POLL_WAIT_MS = 5_000;
const MAX_POLL_WAIT_MS = 30_000;
// Guards against a `Retry-After: 0` turning polling into a tight loop.
const MIN_POLL_WAIT_MS = 250;

/**
 * A write whose outcome the client cannot know: it timed out, lost the
 * connection, got a 5xx after its one retry, or was still running on the
 * server when the write deadline passed. The lesson may have been saved.
 * Deliberately carries no `statusCode`, so it is never mistaken for a
 * definitive HTTP answer such as the 409 duplicate rejection.
 */
export class WriteOutcomeUnknownError extends Error {
    constructor(
        message: string,
        readonly reason: "timeout" | "network" | "server_error" | "in_progress"
    ) {
        super(message);
        this.name = "WriteOutcomeUnknownError";
    }
}

/**
 * The `error` code of a REST error body: `{"detail": {"error": code}}`
 * (FastAPI), `{"error": code}` or `{"detail": "code"}`. Undefined when the
 * error carries no parseable body.
 */
export function apiErrorCode(error: unknown): string | undefined {
    const body = (error as { body?: string }).body;
    if (!body) return undefined;
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const detail = parsed.detail;
        if (typeof detail === "string") return detail;
        if (detail && typeof detail === "object") {
            const code = (detail as Record<string, unknown>).error;
            if (typeof code === "string") return code;
        }
        return typeof parsed.error === "string" ? parsed.error : undefined;
    } catch {
        return undefined;
    }
}

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

    /**
     * POST /v1/memories. Send the SAME `idempotencyKey` for every attempt of
     * one logical write: the server then never writes it twice, replays the
     * finished result (`Idempotency-Replayed: true` → `replayed`), and answers
     * 409 `write_in_progress` while the first attempt still runs. Without a
     * key the write is never retried — a backend that ignores the header
     * would save a second copy.
     */
    async writeMemory(params: WriteParams, idempotencyKey?: string): Promise<WriteOutcome> {
        this.assertAuthenticated();
        const headers = this.buildHeaders("application/json");
        if (idempotencyKey) {
            headers["Idempotency-Key"] = idempotencyKey;
        }
        const body = JSON.stringify(params);

        return this.writeWithRetry(async (signal) => {
            const response = await fetch(`${this.baseUrl}/v1/memories`, {
                method: "POST",
                headers,
                body,
                signal,
            });
            const result = await this.handleResponse<WriteResult>(response);
            const replayed = response.headers.get("idempotency-replayed")?.trim().toLowerCase() === "true";
            return { result, replayed };
        }, Boolean(idempotencyKey));
    }

    async getMemory(memoryId: string): Promise<MemoryDetail> {
        return this.get<MemoryDetail>(`/v1/memories/${encodeURIComponent(memoryId)}`);
    }

    async getHealth(): Promise<HealthStatus> {
        return this.get<HealthStatus>("/health");
    }

    /**
     * GET /v1/subscription — the caller's live plan, derived server-side from
     * the X-API-Key header. The authoritative signal for team vs personal
     * scope; callers must validate `plan` before trusting it.
     */
    async getSubscription(): Promise<SubscriptionStatus> {
        return this.get<SubscriptionStatus>("/v1/subscription");
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
                retryAfter: string | null;
            };
            err.statusCode = response.status;
            err.body = errorBody;
            err.retryAfter = response.headers.get("retry-after");
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

    /**
     * Retry policy for POST /v1/memories:
     *  - timeout, network error or 5xx: ONE retry, and only with an
     *    Idempotency-Key. A backend that predates idempotency ignores the
     *    header, so every further retry could save another copy.
     *  - 409 write_in_progress (an earlier attempt with this key still runs):
     *    wait for Retry-After and poll with the same key until the overall
     *    write deadline.
     * Ending on a timeout, network error, 5xx or a still-running write throws
     * WriteOutcomeUnknownError; every other error is a definitive answer.
     */
    private async writeWithRetry<T>(
        fn: (signal: AbortSignal) => Promise<T>,
        keyed: boolean
    ): Promise<T> {
        const deadline = Date.now() + WRITE_DEADLINE_MS;
        let transientRetried = false;

        for (;;) {
            const remaining = deadline - Date.now();
            const controller = new AbortController();
            const timeoutId = setTimeout(
                () => controller.abort(),
                Math.min(this.timeout, Math.max(remaining, MIN_WRITE_ATTEMPT_MS))
            );

            let delay: number;
            try {
                return await fn(controller.signal);
            } catch (error: unknown) {
                if (keyed && this.isWriteInProgress(error)) {
                    delay = this.retryAfterMs(error);
                } else if (keyed && !transientRetried && this.isRetryableError(error)) {
                    transientRetried = true;
                    delay = 500;
                } else {
                    throw this.isRetryableError(error) || this.isWriteInProgress(error)
                        ? this.writeOutcomeUnknown(error)
                        : this.normalizeError(error);
                }

                if (Date.now() + delay + MIN_WRITE_ATTEMPT_MS > deadline) {
                    throw this.writeOutcomeUnknown(error);
                }
            } finally {
                clearTimeout(timeoutId);
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    /** 409 `write_in_progress`: an earlier attempt with this Idempotency-Key is still running. */
    private isWriteInProgress(error: unknown): boolean {
        const statusCode = (error as { statusCode?: number }).statusCode;
        return statusCode === 409 && apiErrorCode(error) === "write_in_progress";
    }

    /**
     * How long to wait before polling a write in progress: the Retry-After
     * header (seconds or an HTTP date), else the body's `retry_after_seconds`,
     * else 5s. Each wait is capped at 30s.
     */
    private retryAfterMs(error: unknown): number {
        let seconds: number | undefined;

        const header = (error as { retryAfter?: string | null }).retryAfter?.trim();
        if (header) {
            if (/^\d+(\.\d+)?$/.test(header)) {
                seconds = Number(header);
            } else if (Number.isFinite(Date.parse(header))) {
                seconds = (Date.parse(header) - Date.now()) / 1000;
            }
        }

        if (seconds === undefined) {
            try {
                const parsed = JSON.parse((error as { body?: string }).body ?? "") as Record<string, unknown>;
                const detail = parsed.detail as Record<string, unknown> | undefined;
                const fromBody = detail?.retry_after_seconds ?? parsed.retry_after_seconds;
                if (typeof fromBody === "number" && Number.isFinite(fromBody)) seconds = fromBody;
            } catch {
                // no usable body — fall back to the default below
            }
        }

        const ms = seconds === undefined ? DEFAULT_POLL_WAIT_MS : seconds * 1000;
        return Math.min(Math.max(ms, MIN_POLL_WAIT_MS), MAX_POLL_WAIT_MS);
    }

    private writeOutcomeUnknown(error: unknown): WriteOutcomeUnknownError {
        if (this.isWriteInProgress(error)) {
            return new WriteOutcomeUnknownError(
                `The server was still processing this write after ${WRITE_DEADLINE_MS / 1000}s.`,
                "in_progress"
            );
        }
        const message = this.normalizeError(error).message;
        if (error instanceof DOMException && error.name === "AbortError") {
            return new WriteOutcomeUnknownError(message, "timeout");
        }
        const statusCode = (error as { statusCode?: number }).statusCode;
        return new WriteOutcomeUnknownError(
            message,
            statusCode !== undefined ? "server_error" : "network"
        );
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
