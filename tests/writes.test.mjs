// End-to-end tests for lesson writes against a mock backend: one
// Idempotency-Key per write, the single transient retry, polling while a
// write is in progress, unknown outcomes, replays and the 422 rejections.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ── Mock backend ─────────────────────────────────────────────────
const writes = []; // { key, body, at } for every POST /v1/memories
let writeScript = []; // responses served in order; an exhausted script answers 201
let queryScript = []; // responses served before falling back to queryResponse
let queryResponse = {};
let queryCount = 0;
const backend = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status, value, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(value));
    };
    if (req.url === "/v1/memories") {
        writes.push({ key: req.headers["idempotency-key"], body: JSON.parse(body), at: Date.now() });
        const next = writeScript.shift() ?? {};
        if (next.hang) return; // never answer: the client times out
        return send(next.status ?? 201, next.body ?? created(), next.headers);
    }
    if (req.url === "/v2/query") {
        queryCount++;
        const next = queryScript.shift();
        return next ? send(next.status, next.body) : send(200, queryResponse);
    }
    send(404, { detail: "not found" });
});

// ── Isolate from the developer's real ~/.bhived before loading config ──
const home = await mkdtemp(join(tmpdir(), "bhived-write-test-"));
await new Promise((done) => backend.listen(0, "127.0.0.1", done));
Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    BHIVED_API_KEY: "test-key",
    BHIVED_API_URL: `http://127.0.0.1:${backend.address().port}`,
    BHIVED_SECRETS_FILE: join(home, "secrets.json"),
    // Small, so timeouts are cheap to provoke. Read once, at import.
    BHIVED_TIMEOUT: "400",
});

const { registerWriteTools } = await import("../dist/tools/write.js");
const { registerQueryTool } = await import("../dist/tools/query.js");
const { BhivedRestClient, WriteOutcomeUnknownError } = await import("../dist/client/restClient.js");

const server = new McpServer({ name: "write-tests", version: "1.0.0" });
const client = new Client({ name: "write-test-client", version: "1.0.0" });
before(async () => {
    registerWriteTools(server);
    registerQueryTool(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
});
after(async () => {
    await client.close();
    await server.close();
    // fetch keeps sockets alive (and hung requests stay open); close them or
    // server.close() waits them out.
    backend.closeAllConnections();
    await new Promise((done) => backend.close(done));
    await rm(home, { recursive: true, force: true });
});

const call = (name, args) => client.callTool({ name, arguments: args });
const text = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const keys = () => writes.map((w) => w.key);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reset the request log and queue the backend's next answers to POST /v1/memories. */
function serve(...responses) {
    writes.length = 0;
    writeScript = responses;
}
function created(overrides = {}) {
    return {
        memory_id: "new-lesson", entities_created: 2, entities_merged: 0, relations_created: 1, causal_relations: 0,
        next_edge_created: false, provenance_steps: 0, fingerprint_computed: true, query_id_linked: null,
        supersedes_id_linked: null, action_performed: "created", corroborations_created: 0, contradictions_created: 0,
        ...overrides,
    };
}
const replayed = (body = created()) => ({ status: 201, headers: { "Idempotency-Replayed": "true" }, body });
const inProgress = (headers, retryAfterSeconds) => ({
    status: 409, headers, body: { detail: { error: "write_in_progress", retry_after_seconds: retryAfterSeconds } },
});

// Every test writes distinct content: unresolved keys are remembered per
// payload for the whole process, so shared content would leak between tests.

test("a timed-out write is retried once with the same key, then reported as possibly saved", async () => {
    const lesson = { title: "Timeout lesson", text: "Use pkg@1.0.0 with --flag" };
    serve({ hang: true }, { hang: true }, {});
    const failed = await call("bhived_write_instruction", lesson);
    assert.equal(failed.isError, true);
    assert.equal(writes.length, 2, "exactly one retry");
    const [key] = keys();
    assert.match(key, UUID);
    assert.deepEqual(keys(), [key, key]);
    const out = text(failed);
    assert.match(out, /may still have been saved/);
    assert.match(out, /timed out/);
    assert.match(out, /Do NOT rewrite this lesson in different words/);
    assert.match(out, /`bhived_write_instruction` again with IDENTICAL content/);

    // Different content is a different write: fresh key.
    serve({});
    await call("bhived_write_instruction", { ...lesson, text: "Use pkg@1.0.1 with --flag" });
    assert.notEqual(keys()[0], key);
    assert.match(keys()[0], UUID);

    // Identical content reuses the unresolved key, and the replay is explained.
    serve(replayed(created({ memory_id: "saved-once" })));
    const again = await call("bhived_write_instruction", lesson);
    assert.equal(again.isError, undefined, text(again));
    assert.deepEqual(keys(), [key]);
    assert.match(text(again), /`saved-once`/);
    assert.match(text(again), /already been saved by an earlier attempt — nothing new was created/);

    // Resolved: the next identical write is a new write with a new key.
    serve({});
    const fresh = await call("bhived_write_instruction", lesson);
    assert.notEqual(keys()[0], key);
    assert.doesNotMatch(text(fresh), /already been saved/);
});

test("a 5xx is retried once with the same key; a second 5xx leaves the outcome unknown", async () => {
    serve({ status: 500, body: { detail: "boom" } }, {});
    const ok = await call("bhived_write_update", { title: "Retry after 500", text: "pkg@2.0.0 renamed foo() to bar()" });
    assert.equal(ok.isError, undefined, text(ok));
    assert.equal(writes.length, 2);
    assert.equal(keys()[0], keys()[1]);

    serve({ status: 502, body: {} }, { status: 503, body: { detail: "unavailable" } }, {});
    const failed = await call("bhived_write_update", { title: "Retry after 502", text: "pkg@3.0.0 dropped Node 16" });
    assert.equal(failed.isError, true);
    assert.equal(writes.length, 2, "no second retry");
    assert.equal(keys()[0], keys()[1]);
    assert.match(text(failed), /may still have been saved/);
    assert.match(text(failed), /REST API error \(503\)/);
});

test("write_in_progress is polled with the same key after the Retry-After header", async () => {
    // The header (1s) wins over the body's retry_after_seconds (30s).
    serve({ hang: true }, inProgress({ "Retry-After": "1" }, 30), replayed(), {});
    const result = await call("bhived_write_mistake", { title: "Polling", text: "Do not use pkg@4.0.0 on Windows" });
    assert.equal(result.isError, undefined, text(result));
    assert.equal(writes.length, 3);
    assert.equal(new Set(keys()).size, 1, "every attempt carries the same key");
    const wait = writes[2].at - writes[1].at;
    assert.ok(wait >= 950 && wait < 5000, `waited ${wait}ms for Retry-After: 1`);
    assert.match(text(result), /already been saved by an earlier attempt/);
});

test("without a Retry-After header the body's retry_after_seconds is honoured", async () => {
    serve(inProgress({}, 0.3), {});
    const result = await call("bhived_write_mistake", { title: "Body wait", text: "Do not use pkg@5.0.0 with Bun" });
    assert.equal(result.isError, undefined, text(result));
    assert.equal(writes.length, 2);
    assert.equal(keys()[0], keys()[1]);
    const wait = writes[1].at - writes[0].at;
    assert.ok(wait >= 280 && wait < 2000, `waited ${wait}ms for retry_after_seconds: 0.3`);
    assert.doesNotMatch(text(result), /already been saved/);
});

test("422 idempotency rejections get one-line messages, are not retried and release the key", async () => {
    const lesson = { title: "Rejected key", text: "Do not use pkg@6.0.0 with Deno" };
    serve({ status: 422, body: { detail: { error: "idempotency_key_reused" } } }, {});
    const reused = await call("bhived_write_mistake", lesson);
    assert.equal(reused.isError, true);
    assert.equal(writes.length, 1);
    assert.match(text(reused), /^Error writing mistake: rejected \(idempotency_key_reused\) — .*Nothing was saved/);
    assert.equal(text(reused).split("\n").length, 1);
    const firstKey = keys()[0];

    serve({ status: 422, body: { detail: { error: "invalid_idempotency_key" } } }, {});
    const invalid = await call("bhived_write_mistake", lesson);
    assert.equal(invalid.isError, true);
    assert.equal(writes.length, 1);
    assert.notEqual(keys()[0], firstKey, "a definitive rejection does not keep the key");
    assert.match(text(invalid), /^Error writing mistake: rejected \(invalid_idempotency_key\) — .*bhived-mcp bug/);
    assert.equal(text(invalid).split("\n").length, 1);
});

test("a duplicate rejection is still explained and is not retried", async () => {
    serve({
        status: 409,
        body: { detail: { error: "duplicate_memory", duplicate_of: "existing-lesson", jaccard_similarity: 0.99 } },
    }, {});
    const result = await call("bhived_write_instruction", { title: "Duplicate", text: "Use pkg@7.0.0 like this" });
    assert.equal(result.isError, true);
    assert.equal(writes.length, 1);
    assert.match(text(result), /Near-duplicate detected/);
    assert.match(text(result), /existing_bhived_id\*\*: `existing-lesson`/);
    assert.match(text(result), /similarity\*\*: 99%/);
});

test("bhived_write_mistake accepts supersedes_id and action and forwards them", async () => {
    serve({ body: created({ memory_id: "old-mistake", action_performed: "updated", supersedes_id_linked: "old-mistake" }) });
    const result = await call("bhived_write_mistake", {
        title: "Corrected mistake", text: "Do not use pkg@8.0.0 with ESM", supersedes_id: "old-mistake", action: "update",
    });
    assert.equal(result.isError, undefined, text(result));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.type, "mistake");
    assert.equal(writes[0].body.supersedes_id, "old-mistake");
    assert.equal(writes[0].body.action, "update");
    assert.match(text(result), /^# ✅ Lesson updated/);
    assert.doesNotMatch(text(result), /hidden from search/, "an in-place update hides nothing");

    serve({});
    await call("bhived_write_mistake", { title: "Plain mistake", text: "Do not use pkg@8.1.0 with CJS" });
    assert.equal(writes[0].body.action, "new", "action defaults to new");
    assert.equal(writes[0].body.supersedes_id, undefined);
});

test("a superseded lesson is described as hidden, inspectable and restorable", async () => {
    serve({ body: created({ memory_id: "replacement", action_performed: "superseded", supersedes_id_linked: "my-old-lesson" }) });
    const out = text(await call("bhived_write_update", {
        title: "Superseding", text: "pkg@9.0.0 replaced the config file format", supersedes_id: "my-old-lesson",
    }));
    assert.match(out, /^# ✅ Lesson superseded/);
    assert.match(out, /`my-old-lesson` — the old lesson is now hidden from search but still readable with `bhived_inspect`/);
    assert.match(out, /comes back automatically if this replacement is deleted, archived or disputed/);
    assert.doesNotMatch(out, /NOT replaced/);
});

test("the duplicate rejection offers supersede for every write tool", async () => {
    serve({ status: 409, body: { detail: { error: "duplicate_memory", duplicate_of: "mine", jaccard_similarity: 0.95 } } });
    const out = text(await call("bhived_write_mistake", { title: "Dup mistake", text: "Do not use pkg@10.0.0" }));
    assert.match(out, /`bhived_write_instruction`, `bhived_write_mistake` and `bhived_write_update`/);
    assert.doesNotMatch(out, /not `bhived_write_mistake`/);
});

test("a write without an idempotency key is never retried", async () => {
    const bare = new BhivedRestClient(process.env.BHIVED_API_URL, 400, "test-key");
    serve({ status: 500, body: {} }, {});
    await assert.rejects(
        bare.writeMemory({ title: "t", text: "x", type: "instruction" }),
        (error) => error instanceof WriteOutcomeUnknownError && error.reason === "server_error"
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, undefined);
});

test("queries still retry 503 models_warming", async () => {
    queryCount = 0;
    queryScript = [{ status: 503, body: { detail: { error: "models_warming" } } }];
    queryResponse = { query_id: "q-warm", team_recommendations: [], public_recommendations: [] };
    const result = await call("bhived_query", { query: "warming" });
    assert.equal(result.isError, undefined, text(result));
    assert.equal(queryCount, 2);
    assert.match(text(result), /q-warm/);
});

test("results show the ids folded into them, at most three", async () => {
    const lesson = (id, collapsed) => ({
        memory_id: id, title: `Lesson ${id}`, text: "body", type: "instruction", score: 0.9, collapsed_ids: collapsed,
    });
    queryScript = [];
    queryResponse = {
        query_id: "q-folded", team_recommendations: [],
        public_recommendations: [
            lesson("two", ["a1", "a2"]),
            lesson("five", ["b1", "b2", "b3", "b4", "b5"]),
            lesson("empty", []),
            lesson("absent", undefined),
        ],
    };
    const out = text(await call("bhived_query", { query: "folded" }));
    assert.match(out, /^> \+2 similar folded in: `a1`, `a2` \(bhived_inspect for details\)$/m);
    assert.match(out, /^> \+5 similar folded in: `b1`, `b2`, `b3`, \+2 more \(bhived_inspect for details\)$/m);
    assert.doesNotMatch(out, /`b4`/);
    assert.equal(out.match(/similar folded in/g).length, 2, "nothing for empty or missing collapsed_ids");
});
