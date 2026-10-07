// End-to-end tests for capability activation against a mock backend:
// env passthrough for child MCPs, real outcome reporting, skill refresh,
// requirement display in query results, and the supersede warning.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const fixture = resolve(fileURLToPath(new URL("./fixtures/env-echo-mcp.mjs", import.meta.url)));
const badHandshake = resolve(fileURLToPath(new URL("./fixtures/bad-handshake-mcp.mjs", import.meta.url)));

// ── Mock backend ─────────────────────────────────────────────────
const activations = new Map(); // bhived_id → ActivationResponse
const reports = []; // { id, success }
const failingReports = new Set(); // bhived_ids whose report endpoint returns 500
let queryResponse = {};
let writeResponse = {};
const backend = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
    };
    const match = req.url.match(/^\/v1\/capabilities\/(.+)\/(activate|report)$/);
    if (match) {
        const id = decodeURIComponent(match[1]);
        if (match[2] === "report") {
            if (failingReports.has(id)) return send(500, { detail: "unavailable" });
            reports.push({ id, success: JSON.parse(body).success });
            return send(200, { ok: true });
        }
        return activations.has(id) ? send(200, activations.get(id)) : send(404, { detail: "not found" });
    }
    if (req.url === "/v2/query") return send(200, queryResponse);
    if (req.url === "/v1/memories") return send(writeResponse.status ?? 200, writeResponse.body ?? writeResponse);
    send(404, { detail: "not found" });
});

// ── Isolate from the developer's real ~/.bhived before loading config ──
const home = await mkdtemp(join(tmpdir(), "bhived-cap-test-"));
const secretsFile = join(home, "secrets.json");
await new Promise((done) => backend.listen(0, "127.0.0.1", done));
Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    BHIVED_API_KEY: "test-key",
    BHIVED_API_URL: `http://127.0.0.1:${backend.address().port}`,
    BHIVED_SECRETS_FILE: secretsFile,
});
delete process.env.TEST_REQUIRED_KEY;
delete process.env.TEST_FILE_KEY;
delete process.env.TEST_DEFAULTED;

const { registerInitiateMcpTool } = await import("../dist/tools/initiateMcp.js");
const { registerInitiateSkillTool } = await import("../dist/tools/initiateSkill.js");
const { registerRunScriptTool } = await import("../dist/tools/runScript.js");
const { registerUseToolTool } = await import("../dist/tools/useTool.js");
const { registerReportOutcomeTool } = await import("../dist/tools/reportOutcome.js");
const { registerQueryTool } = await import("../dist/tools/query.js");
const { registerWriteTools } = await import("../dist/tools/write.js");
const { resolveChildEnv } = await import("../dist/childMcp/env.js");
const { childMcpManager } = await import("../dist/childMcp/manager.js");
const { childMcpRegistry } = await import("../dist/registries/childMcpRegistry.js");

const server = new McpServer({ name: "capability-tests", version: "1.0.0" });
const client = new Client({ name: "capability-test-client", version: "1.0.0" });
before(async () => {
    for (const register of [registerInitiateMcpTool, registerInitiateSkillTool, registerRunScriptTool,
        registerUseToolTool, registerReportOutcomeTool, registerQueryTool, registerWriteTools]) {
        register(server);
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
});
after(async () => {
    await childMcpManager.cleanupAll();
    await client.close();
    await server.close();
    // fetch keeps sockets alive; close them or server.close() waits them out.
    backend.closeAllConnections();
    await new Promise((done) => backend.close(done));
    await rm(home, { recursive: true, force: true });
});

const call = (name, args) => client.callTool({ name, arguments: args });
const text = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const settle = () => new Promise((done) => setTimeout(done, 150));
async function reportsFor(id, expected) {
    for (let i = 0; i < 40 && reports.filter((r) => r.id === id).length < expected; i++) await settle();
    await settle(); // catch any extra, unexpected reports
    return reports.filter((r) => r.id === id);
}

const REQUIREMENTS = [
    { name: "TEST_REQUIRED_KEY", description: "Test service key", required: true, secret: true, default: null },
    { name: "TEST_FILE_KEY", description: "Read from the secrets file", required: false, secret: true, default: null },
    { name: "TEST_DEFAULTED", description: "Has a default", required: false, secret: false, default: "fallback" },
];
function mcpActivation(name, overrides = {}) {
    return {
        ok: true, capability_type: "mcp", name, skill_payload: null,
        mcp_payload: {
            name, description: "Echoes its environment.", command: "node", args: [fixture],
            env: [], env_requirements: REQUIREMENTS,
            header_requirements: [{ name: "X-Remote-Token", required: true, secret: true }],
            tools_hint: ["read_env"], metadata: { stars: 804 }, ...overrides,
        },
    };
}
function skillActivation(name, scripts, extra = {}) {
    return {
        ok: true, capability_type: "skill", name, mcp_payload: null,
        skill_payload: {
            name, description: "Test skill", skill_md: `# ${name}\n`, scripts, references: {}, assets: {},
            mcp_configs: [], metadata: { github_stars: 57491, security_audits: { Socket: "Pass", Snyk: "Warn" } },
            ...extra,
        },
    };
}

test("env resolution: process env, then secrets file, then default; nothing unrelated", async () => {
    await writeFile(secretsFile, JSON.stringify({ TEST_FILE_KEY: "from-file", TEST_REQUIRED_KEY: "file-loses" }));
    process.env.TEST_REQUIRED_KEY = "from-env";
    process.env.TEST_UNRELATED_SECRET = "must-not-leak";
    try {
        const resolved = resolveChildEnv({
            env: { STATIC_VAR: "static", "bad name": "x" },
            env_requirements: [...REQUIREMENTS, { name: "bad name", required: true }, { name: "OPT", required: false }],
        });
        assert.deepEqual(resolved.env, {
            STATIC_VAR: "static", TEST_REQUIRED_KEY: "from-env", TEST_FILE_KEY: "from-file", TEST_DEFAULTED: "fallback",
        });
        assert.deepEqual(resolved.sources, {
            TEST_REQUIRED_KEY: "environment", TEST_FILE_KEY: "secrets file", TEST_DEFAULTED: "default",
        });
        assert.deepEqual(resolved.missing, []);
        assert.deepEqual(resolveChildEnv({ env: [], env_requirements: undefined }).env, {});
    } finally {
        delete process.env.TEST_REQUIRED_KEY;
        delete process.env.TEST_UNRELATED_SECRET;
        await rm(secretsFile, { force: true });
    }
    const missing = resolveChildEnv({ env_requirements: REQUIREMENTS }).missing.map((r) => r.name);
    assert.deepEqual(missing, ["TEST_REQUIRED_KEY"]);
});

test("MCP with a missing required key is not launched and not reported", async () => {
    activations.set("mcp-missing", mcpActivation("env-echo-missing"));
    const result = await call("bhived_initiate_mcp", { bhived_id: "mcp-missing" });
    assert.equal(result.isError, true);
    assert.match(text(result), /Missing TEST_REQUIRED_KEY \(secret\): Test service key/);
    assert.match(text(result), /secrets\.json/);
    assert.equal(childMcpRegistry.has("env-echo-missing"), false);
    assert.deepEqual(await reportsFor("mcp-missing", 0), []);
});

test("MCP receives exactly its declared variables and a real success is reported once", async () => {
    await writeFile(secretsFile, JSON.stringify({ TEST_FILE_KEY: "from-file" }));
    process.env.TEST_REQUIRED_KEY = "from-env";
    process.env.TEST_UNRELATED_SECRET = "must-not-leak";
    try {
        activations.set("mcp-ok", mcpActivation("env-echo-ok"));
        const started = await call("bhived_initiate_mcp", { bhived_id: "mcp-ok" });
        assert.equal(started.isError, undefined, text(started));
        const out = text(started);
        assert.match(out, /MCP Spawned: env-echo-ok/);
        assert.match(out, /`TEST_REQUIRED_KEY` \(secret, set\)/);
        assert.match(out, /`TEST_DEFAULTED` \(optional, default used\)/);
        assert.match(out, /Remote headers \(informational\):.*X-Remote-Token/);
        assert.match(out, /⭐ 804 GitHub stars/);
        assert.doesNotMatch(out, /from-env|from-file|must-not-leak/, "values must never be shown");

        const echoed = await call("bhived_use_tool", { mcp: "env-echo-ok", tool: "read_env", params: {} });
        assert.deepEqual(JSON.parse(text(echoed)), {
            required: "from-env", fromFile: "from-file", defaulted: "fallback", unrelated: null, hasPath: true,
        });

        const again = await call("bhived_initiate_mcp", { bhived_id: "mcp-ok" });
        assert.match(text(again), /Already Running/);
        assert.deepEqual(await reportsFor("mcp-ok", 1), [{ id: "mcp-ok", success: true }]);
    } finally {
        delete process.env.TEST_REQUIRED_KEY;
        delete process.env.TEST_UNRELATED_SECRET;
        await rm(secretsFile, { force: true });
        await childMcpManager.stop("env-echo-ok").catch(() => {});
    }
});

test("a launch failure is reported as failure; a missing local command is not reported", async () => {
    activations.set("mcp-crash", mcpActivation("crashes", { args: [badHandshake], env_requirements: [] }));
    const crashed = await call("bhived_initiate_mcp", { bhived_id: "mcp-crash" });
    assert.equal(crashed.isError, true);
    assert.match(text(crashed), /protocol version is not supported/);
    assert.equal(childMcpRegistry.has("crashes"), false);
    assert.deepEqual(await reportsFor("mcp-crash", 1), [{ id: "mcp-crash", success: false }]);

    activations.set("mcp-nocmd", mcpActivation("no-command", { command: "bhived-test-no-such-binary", env_requirements: [] }));
    const missingCommand = await call("bhived_initiate_mcp", { bhived_id: "mcp-nocmd" });
    assert.equal(missingCommand.isError, true);
    assert.match(text(missingCommand), /not found on this system/);
    assert.deepEqual(await reportsFor("mcp-nocmd", 0), []);
});

test("skills report success only when a script exits 0, once per session", async () => {
    activations.set("skill-runs", skillActivation("runs", {
        "ok.mjs": "console.log('fine')",
        "fails.mjs": "process.exit(2)",
    }));
    const activated = await call("bhived_initiate_skill", { bhived_id: "skill-runs" });
    assert.match(text(activated), /Skill Activated: runs/);
    assert.match(text(activated), /⭐ 57,491 GitHub stars · 🛡️ Audits: Socket: Pass, Snyk: Warn/);
    assert.match(text(activated), /bhived_report_outcome\(bhived_id="skill-runs"/);
    assert.deepEqual(await reportsFor("skill-runs", 0), [], "activation alone must not count as success");

    const failed = await call("bhived_run_script", { skill: "runs", script: "fails.mjs" });
    assert.equal(failed.isError, true);
    assert.deepEqual(await reportsFor("skill-runs", 0), [], "a non-zero exit is not reported");

    for (let i = 0; i < 2; i++) {
        const ok = await call("bhived_run_script", { skill: "runs", script: "ok.mjs" });
        assert.equal(ok.isError, false, text(ok));
    }
    assert.deepEqual(await reportsFor("skill-runs", 1), [{ id: "skill-runs", success: true }]);
});

test("explicit outcome reports only for capabilities activated this session", async () => {
    const unknown = await call("bhived_report_outcome", { bhived_id: "never-activated", success: true });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /not activated in this session/);

    activations.set("skill-docs", skillActivation("docs-only", {}));
    await call("bhived_initiate_skill", { bhived_id: "skill-docs" });
    const first = await call("bhived_report_outcome", { bhived_id: "skill-docs", success: false });
    assert.match(text(first), /Recorded failure/);
    const repeat = await call("bhived_report_outcome", { bhived_id: "skill-docs", success: false });
    assert.match(text(repeat), /already recorded/);
    assert.deepEqual(await reportsFor("never-activated", 0), []);
    assert.deepEqual(await reportsFor("skill-docs", 1), [{ id: "skill-docs", success: false }]);
});

test("re-activating a skill reloads it when the server copy changed", async () => {
    activations.set("skill-v", skillActivation("versioned", { "v.mjs": "console.log('version one')" }));
    assert.match(text(await call("bhived_initiate_skill", { bhived_id: "skill-v" })), /Skill Activated/);
    assert.match(text(await call("bhived_initiate_skill", { bhived_id: "skill-v" })), /Already Active/);

    activations.set("skill-v", skillActivation("versioned", { "v.mjs": "console.log('version two')" }));
    assert.match(text(await call("bhived_initiate_skill", { bhived_id: "skill-v" })), /Skill Updated: versioned/);
    assert.match(text(await call("bhived_run_script", { skill: "versioned", script: "v.mjs" })), /version two/);

    // A different skill that happens to share the name must not be served from the cache.
    activations.set("skill-v-other", skillActivation("versioned", { "v.mjs": "console.log('other publisher')" }));
    const replaced = await call("bhived_initiate_skill", { bhived_id: "skill-v-other" });
    assert.match(text(replaced), /replaces a different skill with the same name \(bhived_id `skill-v`\)/);
    assert.match(text(await call("bhived_run_script", { skill: "versioned", script: "v.mjs" })), /other publisher/);
});

test("query results show requirements, local availability and quality signals", async () => {
    await writeFile(secretsFile, JSON.stringify({ TEST_FILE_KEY: "from-file" }));
    queryResponse = {
        query_id: "q-1", team_recommendations: [],
        public_recommendations: [
            {
                memory_id: "mcp-q", text: "", title: "", type: "instruction", score: 0.9, has_mcp: true,
                mcp_meta: {
                    name: "brave-like", tools_hint: [], env_requirements: REQUIREMENTS,
                    header_requirements: [{ name: "X-Remote-Token", secret: true }], activation_count: 0,
                },
            },
            {
                memory_id: "skill-q", text: "", title: "", type: "instruction", score: 0.8, has_skill: true,
                skill_meta: { name: "starred", github_stars: 1200, security_audits: { Socket: "Pass" }, publisher: { name: "acme", verified: true } },
            },
        ],
    };
    try {
        const out = text(await call("bhived_query", { query: "web search" }));
        assert.match(out, /🔑 \*\*Requires:\*\* `TEST_REQUIRED_KEY` \(secret, \*\*not set\*\*\) · `TEST_FILE_KEY` \(secret, optional, set\) · `TEST_DEFAULTED` \(optional, default used\)/);
        assert.match(out, /Can't run on this machine yet/);
        assert.match(out, /Remote headers \(informational\):.*`X-Remote-Token \(secret\)`/);
        assert.match(out, /⭐ 1,200 GitHub stars · 🛡️ Audits: Socket: Pass · 👤 Publisher: acme \(verified\)/);
    } finally {
        await rm(secretsFile, { force: true });
    }
});

test("a supersede that the backend did not apply is flagged, not shown as a clean success", async () => {
    const base = {
        memory_id: "new-lesson", entities_created: 2, entities_merged: 0, relations_created: 1, causal_relations: 0,
        next_edge_created: false, provenance_steps: 0, fingerprint_computed: true, query_id_linked: null,
        corroborations_created: 0, contradictions_created: 0,
    };
    const write = (supersedes) => call("bhived_write_instruction", {
        title: "t", text: "Use pkg@1.2.3", supersedes_id: supersedes, query_id: "q-1",
    });

    writeResponse = { ...base, action_performed: "created", supersedes_id_linked: null };
    const ignored = text(await write("someone-elses-lesson"));
    assert.match(ignored, /⚠️ Lesson created — the old lesson was NOT replaced/);
    assert.match(ignored, /`someone-elses-lesson` is unchanged and still active/);
    assert.match(ignored, /only supersede lessons written by your own key/);

    writeResponse = { ...base, action_performed: "superseded", supersedes_id_linked: "my-old-lesson" };
    const applied = text(await write("my-old-lesson"));
    assert.match(applied, /^# ✅ Lesson superseded/);
    assert.doesNotMatch(applied, /NOT replaced/);

    writeResponse = { ...base, action_performed: "created", supersedes_id_linked: null };
    assert.doesNotMatch(text(await write(undefined)), /NOT replaced/);
});

test("a duplicate rejection names the existing lesson (live 409 body is wrapped in detail)", async () => {
    writeResponse = {
        status: 409,
        body: { detail: { error: "duplicate_memory", duplicate_of: "existing-lesson", jaccard_similarity: 0.9921875 } },
    };
    try {
        const result = await call("bhived_write_mistake", { title: "t", text: "Do not use pkg@1.0.0" });
        assert.equal(result.isError, true);
        assert.match(text(result), /existing_bhived_id\*\*: `existing-lesson`/);
        assert.match(text(result), /similarity\*\*: 99%/);
    } finally {
        writeResponse = {};
    }
});

// ── Review fixes ─────────────────────────────────────────────────

test("reserved and prototype names never resolve", () => {
    const resolved = resolveChildEnv({
        env: { BHIVED_API_URL: "static" },
        env_requirements: [
            { name: "BHIVED_API_KEY", required: true }, { name: "bhived_api_key", required: true },
            { name: "constructor", required: true }, { name: "toString", required: false },
        ],
    });
    assert.deepEqual(resolved.env, {}, "bhived's own key must never reach a child");
    assert.deepEqual(resolved.missing.map((r) => r.name), ["constructor"]);
});

test("a supplied secret echoed on the child's stderr is redacted", async () => {
    process.env.TEST_REQUIRED_KEY = "super-secret-value";
    try {
        activations.set("mcp-leak", mcpActivation("leaky", { args: [badHandshake], env_requirements: [REQUIREMENTS[0]] }));
        const out = text(await call("bhived_initiate_mcp", { bhived_id: "mcp-leak" }));
        assert.doesNotMatch(out, /super-secret-value/);
        assert.match(out, /Invalid key: \[REDACTED TEST_REQUIRED_KEY\]/);
    } finally {
        delete process.env.TEST_REQUIRED_KEY;
    }
});

const pidLog = join(home, "bundled-pids.log");
const launches = async () => (await readFile(pidLog, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
const bundledEcho = (extraArgs = []) => ({
    name: "bundled-echo", description: "", command: "node", args: [fixture, ...extraArgs], env: [],
    env_requirements: [{ name: "ECHO_PID_LOG", required: false, default: pidLog }],
});

test("overlapping activations start a bundled MCP once; only MCP changes restart it", async () => {
    activations.set("skill-bundled", skillActivation("bundled", { "s.mjs": "" }, { mcp_configs: [bundledEcho()] }));
    const both = await Promise.all([1, 2].map(() => call("bhived_initiate_skill", { bhived_id: "skill-bundled" })));
    both.forEach((r) => assert.equal(r.isError, undefined, text(r)));
    assert.equal(await launches(), 1, "two overlapping activations must not launch two processes");

    activations.set("skill-bundled", skillActivation("bundled", { "s.mjs": "" }, { skill_md: "# edited\n", mcp_configs: [bundledEcho()] }));
    assert.match(text(await call("bhived_initiate_skill", { bhived_id: "skill-bundled" })), /Skill Updated/);
    assert.equal(await launches(), 1, "a text-only update keeps the running MCP");

    activations.set("skill-bundled", skillActivation("bundled", { "s.mjs": "" }, { skill_md: "# edited\n", mcp_configs: [bundledEcho(["--v2"])] }));
    assert.match(text(await call("bhived_initiate_skill", { bhived_id: "skill-bundled" })), /Skill Updated/);
    assert.equal(await launches(), 2, "a changed MCP config restarts it");
    assert.ok(childMcpRegistry.get("bundled-echo").config.args.includes("--v2"));
});

test("a skill pushed out of the registry is fully unloaded", async () => {
    assert.ok(childMcpRegistry.has("bundled-echo"));
    for (let i = 0; i < 5; i++) {
        activations.set(`skill-filler-${i}`, skillActivation(`filler-${i}`, {}));
        await call("bhived_initiate_skill", { bhived_id: `skill-filler-${i}` });
    }
    assert.equal(childMcpRegistry.has("bundled-echo"), false, "evicted skill's bundled MCP must stop");
    assert.match(text(await call("bhived_initiate_skill", { bhived_id: "skill-bundled" })), /✅ Skill Activated: bundled/);
    assert.equal(childMcpRegistry.has("bundled-echo"), true);
});

test("re-activating retries a bundled MCP whose key was missing", async () => {
    const needsKey = { ...bundledEcho(), name: "keyed-echo", env_requirements: [REQUIREMENTS[0]] };
    activations.set("skill-keyed", skillActivation("keyed", {}, { mcp_configs: [needsKey] }));
    assert.match(text(await call("bhived_initiate_skill", { bhived_id: "skill-keyed" })), /not started — Missing TEST_REQUIRED_KEY/);
    assert.equal(childMcpRegistry.has("keyed-echo"), false);

    await writeFile(secretsFile, JSON.stringify({ TEST_REQUIRED_KEY: "now-set" }));
    try {
        const retried = text(await call("bhived_initiate_skill", { bhived_id: "skill-keyed" }));
        assert.match(retried, /Already Active/);
        assert.doesNotMatch(retried, /Missing TEST_REQUIRED_KEY/);
        assert.equal(childMcpRegistry.has("keyed-echo"), true);
    } finally {
        await rm(secretsFile, { force: true });
    }
});

test("key order and type prefixes alone are not treated as an update", async () => {
    activations.set("skill-order", skillActivation("ordered", { "a.mjs": "1", "b.mjs": "2" }));
    await call("bhived_initiate_skill", { bhived_id: "skill-order" });
    activations.set("skill-order", skillActivation("ordered", { "scripts/b.mjs": "2", "scripts/a.mjs": "1" }));
    assert.match(text(await call("bhived_initiate_skill", { bhived_id: "skill-order" })), /Already Active/);
});

test("an explicit report that fails says so and can be retried", async () => {
    activations.set("skill-flaky", skillActivation("flaky-report", {}));
    await call("bhived_initiate_skill", { bhived_id: "skill-flaky" });
    failingReports.add("skill-flaky");
    const failed = await call("bhived_report_outcome", { bhived_id: "skill-flaky", success: true });
    assert.equal(failed.isError, true);
    assert.match(text(failed), /Could not record/);
    failingReports.delete("skill-flaky");
    assert.match(text(await call("bhived_report_outcome", { bhived_id: "skill-flaky", success: true })), /Recorded success/);
});

test("a supersede that corroborated the target explains itself without contradictions", async () => {
    writeResponse = {
        memory_id: "their-lesson", entities_created: 0, entities_merged: 0, relations_created: 0, causal_relations: 0,
        next_edge_created: false, provenance_steps: 0, fingerprint_computed: true, query_id_linked: null,
        supersedes_id_linked: null, action_performed: "corroborated", corroborations_created: 0, contradictions_created: 0,
    };
    try {
        const out = text(await call("bhived_write_instruction", { title: "t", text: "x", supersedes_id: "their-lesson" }));
        assert.match(out, /counted as agreement/);
        assert.doesNotMatch(out, /saved as a separate lesson|Consider superseding/);
    } finally {
        writeResponse = {};
    }
});
