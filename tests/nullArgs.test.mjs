// null on an optional tool argument means "not given". Some MCP clients send
// every optional argument they were not given as null (crewai-tools'
// MCPServerAdapter sends "scope": null). Optional fields must accept that and
// use their defaults; required fields must still reject null; tools/list must
// not change (no null types, same required lists).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ── Mock backend: records every request ──────────────────────────
const requests = [];
let writeCount = 0;
const backend = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
    const send = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
    };
    if (req.url === "/v1/subscription") return send(200, { plan: "free" });
    if (req.url === "/v2/query") return send(200, {});
    if (req.method === "POST" && req.url === "/v1/memories") {
        writeCount++;
        return send(201, {
            memory_id: `00000000-0000-4000-8000-${String(writeCount).padStart(12, "0")}`,
            action_performed: "created",
        });
    }
    send(404, { detail: "not found" });
});

// ── Isolate from the developer's real ~/.bhived before loading config ──
const home = await mkdtemp(join(tmpdir(), "bhived-null-args-test-"));
await new Promise((done) => backend.listen(0, "127.0.0.1", done));
Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    BHIVED_API_KEY: "test-key",
    BHIVED_API_URL: `http://127.0.0.1:${backend.address().port}`,
    BHIVED_SECRETS_FILE: join(home, "secrets.json"),
    BHIVED_TIMEOUT: "2000",
});

const tools = await Promise.all([
    import("../dist/tools/query.js").then((m) => m.registerQueryTool),
    import("../dist/tools/write.js").then((m) => m.registerWriteTools),
    import("../dist/tools/inspect.js").then((m) => m.registerInspectTool),
    import("../dist/tools/readResource.js").then((m) => m.registerReadResourceTool),
    import("../dist/tools/runScript.js").then((m) => m.registerRunScriptTool),
    import("../dist/tools/listActive.js").then((m) => m.registerListActiveTool),
    import("../dist/tools/useTool.js").then((m) => m.registerUseToolTool),
    import("../dist/tools/initiateSkill.js").then((m) => m.registerInitiateSkillTool),
    import("../dist/tools/initiateMcp.js").then((m) => m.registerInitiateMcpTool),
    import("../dist/tools/stopMcp.js").then((m) => m.registerStopMcpTool),
    import("../dist/tools/reportOutcome.js").then((m) => m.registerReportOutcomeTool),
]);

const server = new McpServer({ name: "null-args-tests", version: "1.0.0" });
const client = new Client({ name: "null-args-test-client", version: "1.0.0" });
before(async () => {
    for (const register of tools) register(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
});
after(async () => {
    await client.close();
    await server.close();
    backend.closeAllConnections();
    await new Promise((done) => backend.close(done));
    await rm(home, { recursive: true, force: true });
});

const VALIDATION_ERROR = /Input validation error/;
const text = (result) => (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const call = async (name, args) => {
    try {
        return text(await client.callTool({ name, arguments: args }));
    } catch (err) {
        return String(err?.message ?? err);
    }
};

let seq = 0;
const lesson = (label) => `Null-argument probe ${label} ${++seq}: pg 8.13 pool.connect ECONNREFUSED on Node 22.16.`;

/** Valid arguments for each tool with no optional field set. */
const baseArgs = (name) =>
    ({
        bhived_query: { query: "null optional argument probe" },
        bhived_write_instruction: { title: "null probe instruction", text: lesson("instruction") },
        bhived_write_mistake: { title: "null probe mistake", text: lesson("mistake") },
        bhived_write_update: { title: "null probe update", text: lesson("update") },
        bhived_inspect: { bhived_id: "6f1c2a9e-7b4d-4c1e-9a2f-5d6e7f809a1b" },
        bhived_read_resource: { skill: "csv-profiler", path: "scripts/profile_csv.py" },
        bhived_run_script: { skill: "csv-profiler", script: "profile_csv.py" },
        bhived_list_active: {},
        bhived_use_tool: { mcp: "github-issues", tool: "list_issues" },
        bhived_initiate_skill: { bhived_id: "acme/skills/csv-profiler" },
        bhived_initiate_mcp: { bhived_id: "acme/mcps/github-issues" },
        bhived_stop_mcp: { mcp: "github-issues" },
        bhived_report_outcome: { bhived_id: "acme/mcps/github-issues", success: true },
    })[name];

/** What tools/list advertised before this change, per tool. */
const EXPECTED_REQUIRED = {
    bhived_query: ["query"],
    bhived_write_instruction: ["text", "title"],
    bhived_write_mistake: ["text", "title"],
    bhived_write_update: ["text", "title"],
    bhived_inspect: ["bhived_id"],
    bhived_read_resource: ["path", "skill"],
    bhived_run_script: ["script", "skill"],
    bhived_list_active: [],
    bhived_use_tool: ["mcp", "tool"],
    bhived_initiate_skill: ["bhived_id"],
    bhived_initiate_mcp: ["bhived_id"],
    bhived_stop_mcp: ["mcp"],
    bhived_report_outcome: ["bhived_id", "success"],
};

test("tools/list is unchanged: same required fields, no null types", async () => {
    const { tools: listed } = await client.listTools();
    assert.deepEqual(listed.map((t) => t.name).sort(), Object.keys(EXPECTED_REQUIRED).sort());
    for (const { name, inputSchema } of listed) {
        assert.deepEqual([...(inputSchema.required ?? [])].sort(), EXPECTED_REQUIRED[name], `${name}: required fields`);
        assert.doesNotMatch(JSON.stringify(inputSchema), /"null"/, `${name}: must not advertise null`);
    }
});

test("every optional argument accepts null; every required one still rejects it", async () => {
    const { tools: listed } = await client.listTools();
    let optionalChecked = 0;
    let requiredChecked = 0;
    for (const { name, inputSchema } of listed) {
        const required = inputSchema.required ?? [];
        const optional = Object.keys(inputSchema.properties ?? {}).filter((p) => !required.includes(p));
        for (const prop of optional) {
            const out = await call(name, { ...baseArgs(name), [prop]: null });
            assert.doesNotMatch(out, VALIDATION_ERROR, `${name}: ${prop}=null must count as not given`);
            optionalChecked++;
        }
        if (optional.length > 0) {
            const allNull = Object.fromEntries(optional.map((p) => [p, null]));
            const out = await call(name, { ...baseArgs(name), ...allNull });
            assert.doesNotMatch(out, VALIDATION_ERROR, `${name}: all optional fields null at once`);
        }
        for (const prop of required) {
            const out = await call(name, { ...baseArgs(name), [prop]: null });
            assert.match(out, VALIDATION_ERROR, `${name}: ${prop}=null must fail validation`);
            assert.match(out, new RegExp(`\\b${prop}\\b`), `${name}: the error names ${prop}`);
            requiredChecked++;
        }
    }
    // Optional: query 6, writes 3 × 4, memory_id on 4 tools, run_script 3, list_active 1, use_tool 1.
    assert.equal(optionalChecked, 6 + 12 + 4 + 3 + 1 + 1);
    // Required: query 1, writes 3 × 2, bhived_id on inspect/initiate_skill/initiate_mcp 3,
    // read_resource 2, run_script 2, use_tool 2, stop_mcp 1, report_outcome 2.
    assert.equal(requiredChecked, 1 + 6 + 3 + 2 + 2 + 2 + 1 + 2);

    // The deprecated alias still works when the new field is null.
    assert.doesNotMatch(await call("bhived_inspect", { bhived_id: null, memory_id: "6f1c2a9e" }), VALIDATION_ERROR);
    assert.match(await call("bhived_inspect", { bhived_id: null, memory_id: null }), /bhived_id is required/);
});

test("a null reaches the backend exactly like an omitted field", async () => {
    requests.length = 0;
    await call("bhived_query", { query: "null probe A" });
    await call("bhived_query", {
        query: "null probe A",
        context: null,
        top_k: null,
        include_episodes: null,
        include_warnings: null,
        include_disputed: null,
        scope: null,
    });
    const [omitted, nulled] = requests.filter((r) => r.url === "/v2/query").map((r) => r.body);
    assert.deepEqual(nulled, omitted);
    assert.equal(nulled.top_k, 10);
    assert.equal(nulled.include_warnings, true);
    assert.ok(!("scope" in nulled) && !("context" in nulled), JSON.stringify(nulled));

    requests.length = 0;
    const omittedText = lesson("write omitted");
    await call("bhived_write_instruction", { title: "null probe", text: omittedText });
    await call("bhived_write_instruction", {
        title: "null probe",
        text: lesson("write null"),
        query_id: null,
        model: null,
        supersedes_id: null,
        action: null,
    });
    const [omittedBody, nullBody] = requests.filter((r) => r.method === "POST" && r.url === "/v1/memories").map((r) => r.body);
    assert.deepEqual({ ...nullBody, text: omittedText }, omittedBody);
    assert.equal(nullBody.action, "new");

    assert.equal(await call("bhived_list_active", { type: null }), await call("bhived_list_active", {}));
});
