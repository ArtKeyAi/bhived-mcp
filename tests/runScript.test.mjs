import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRunScriptTool } from "../dist/tools/runScript.js";
import { materializeSkillBundle } from "../dist/tools/skillBundle.js";
import { skillRegistry } from "../dist/registries/skillRegistry.js";

const server = new McpServer({ name: "runner-regression", version: "1.0.0" });
const client = new Client({ name: "runner-test", version: "1.0.0" });
before(async () => {
    registerRunScriptTool(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
});
after(async () => { await client.close(); await server.close(); });

function skill(scripts, extra = {}) {
    return {
        memory_id: "test-only", name: "runner-test", skill_md: "# Test skill\n",
        scripts, references: {}, assets: {}, mcp_names: [],
        activated_at: new Date(), status: "active", ...extra,
    };
}
async function run(entry, script = Object.keys(entry.scripts)[0], options = {}) {
    skillRegistry.add(entry);
    try {
        return await client.callTool({ name: "bhived_run_script", arguments: {
            skill: entry.name, script, ...options,
        } });
    } finally { skillRegistry.remove(entry.name); }
}
const text = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const output = (result) => JSON.parse(text(result).match(/RESULT:(.*):END/)[1]);
const emit = (value) => `console.log('RESULT:' + JSON.stringify(${value}) + ':END');`;
async function tempRuns() {
    return (await readdir(tmpdir())).filter((p) => p.startsWith("bhived-script-")).sort();
}

test("real MCP call preserves ESM siblings, nested imports, resources and caller cwd", async () => {
    const entry = skill({
        "tasks/main.mjs": `
            import { readFileSync } from 'node:fs';
            import { value } from '../lib/value.mjs';
            import other from '../other/value.mjs';
            const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
            ${emit("{value, other, ref: read('../../references/nested/info.txt'), asset: read('../../assets/data.txt'), md: read('../../SKILL.md'), root: process.env.BHIVED_SKILL_ROOT, cwd: process.cwd(), args: process.argv.slice(2), input: readFileSync(0, 'utf8')}")}
        `,
        "lib/value.mjs": "export const value = 41;",
        "other/value.mjs": "export default 42;",
    }, { references: { "nested/info.txt": "reference" }, assets: { "data.txt": "asset" } });
    const unchanged = JSON.stringify(entry);
    const result = await run(entry, "tasks/main.mjs", { args: "--flag value", input_data: "stdin data" });
    assert.equal(result.isError, false, text(result));
    const data = output(result);
    assert.deepEqual({ ...data, root: undefined }, {
        value: 41, other: 42, ref: "reference", asset: "asset", md: entry.skill_md,
        cwd: process.cwd(), args: ["--flag", "value"], input: "stdin data", root: undefined,
    });
    assert.equal(existsSync(data.root), false, "complete workspace is cleaned before response");
    assert.equal(JSON.stringify(entry), unchanged, "registry payload must remain unchanged");
});

test("Windows-style nested keys retain layout without stripping another group prefix", async () => {
    const entry = skill({
        "scripts\\main.cjs": "const value = require('./helper.cjs'); " + emit("value"),
        "scripts/helper.cjs": "module.exports = 'nested scripts folder';",
    });
    const result = await run(entry, "scripts\\main.cjs");
    assert.equal(result.isError, false, text(result));
    assert.equal(output(result), "nested scripts folder");
});

const python = process.platform === "win32" ? "python" : "python3";
test("Python sibling imports work through MCP", {
    skip: spawnSync(python, ["--version"], { windowsHide: true }).status !== 0,
}, async () => {
    const result = await run(skill({
        "nested/main.py": "from helper import VALUE\nprint(VALUE)\n",
        "nested/helper.py": "VALUE = 'python sibling works'\n",
    }));
    assert.equal(result.isError, false, text(result));
    assert.match(text(result), /python sibling works/);
});

test("missing and inherited script names are rejected", async () => {
    const absent = await client.callTool({ name: "bhived_run_script", arguments: {
        skill: "not-active", script: "main.js",
    } });
    assert.equal(absent.isError, true);
    assert.match(text(absent), /not active/);
    for (const name of ["missing.mjs", "toString", "__proto__"]) {
        const result = await run(skill({ "main.mjs": "" }), name);
        assert.equal(result.isError, true);
        assert.match(text(result), /not found/);
    }
});

test("unsafe paths in every resource group are refused before execution", async (t) => {
    const beforeDirs = await tempRuns();
    const unsafe = ["../outside", "a/../../outside", "a\\..\\outside", "/absolute", "C:\\absolute",
        "C:relative", "\\\\host\\share", "a:stream", "CON", "aux.txt", "LPT1.log", "COM¹",
        "NUL.txt", "trailing.", "trailing ", "a//b", "./a", "a\u0000b"];
    for (const group of ["scripts", "references", "assets"]) {
        for (const key of unsafe) {
            await t.test(`${group}: ${JSON.stringify(key)}`, async () => {
                const entry = skill({ "main.mjs": "throw new Error('SHOULD_NOT_EXECUTE');" });
                entry[group][key] = "bad resource";
                const result = await run(entry, "main.mjs");
                assert.equal(result.isError, true);
                assert.match(text(result), /Unsafe skill resource path/);
                assert.doesNotMatch(text(result), /SHOULD_NOT_EXECUTE/);
            });
        }
    }
    assert.deepEqual(await tempRuns(), beforeDirs);
});

test("reject case aliases, normalized collisions, file-directory conflicts and non-text files", async () => {
    for (const [resources, error] of [
        [{ "a.txt": "a", "A.txt": "b" }, /Conflicting/],
        [{ "a/b.txt": "a", "a\\b.txt": "b" }, /Conflicting/],
        [{ "a": "a", "a/b.txt": "b" }, /File\/directory conflict/],
        [{ "bad.txt": null }, /Non-text/],
    ]) {
        const result = await run(skill({ "main.mjs": "" }, { references: resources }));
        assert.equal(result.isError, true);
        assert.match(text(result), error);
    }
});

test("nonzero exit and timeout retain stderr and clean generated files", async () => {
    for (const end of ["console.error('expected failure'); process.exit(7);", "setInterval(() => {}, 1000);"]) {
        const result = await run(skill({ "main.mjs": `
            import { writeFileSync } from 'node:fs';
            writeFileSync(process.env.BHIVED_SKILL_ROOT + '/generated.txt', 'generated');
            ${emit("{root: process.env.BHIVED_SKILL_ROOT}")}
            ${end}
        ` }), "main.mjs", { timeout: 1000 });
        assert.equal(result.isError, true, text(result));
        assert.equal(existsSync(output(result).root), false);
        if (end.includes("failure")) {
            assert.match(text(result), /Exit code\*\*: 7/);
            assert.match(text(result), /expected failure/);
        }
    }
});

test("output limit and spawn failure clean the temporary workspace", async () => {
    const beforeDirs = await tempRuns();
    const noisy = await run(skill({ "main.mjs": "console.log('x'.repeat(100000)); setInterval(() => {}, 1000);" }));
    assert.match(text(noisy), /output truncated at 50KB/);
    const previousPath = process.env.PATH;
    try {
        process.env.PATH = "";
        const failed = await run(skill({ "main.mjs": "" }));
        assert.equal(failed.isError, true);
        assert.match(text(failed), /Failed to execute node/);
    } finally { process.env.PATH = previousPath; }
    assert.deepEqual(await tempRuns(), beforeDirs);
});

test("parallel calls get independent workspaces", async () => {
    const make = (name) => skill({ "main.mjs": emit("{root: process.env.BHIVED_SKILL_ROOT}") }, { name });
    const results = await Promise.all([run(make("parallel-one")), run(make("parallel-two"))]);
    results.forEach((result) => assert.equal(result.isError, false, text(result)));
    const roots = results.map((result) => output(result).root);
    assert.notEqual(roots[0], roots[1]);
    roots.forEach((root) => assert.equal(existsSync(root), false));
});

test("cleanup never follows a child or replacement root junction into another directory", async () => {
    const parent = await realpath(tmpdir());
    const outside = await mkdtemp(join(parent, "bhived-runner-test-"));
    assert.equal(dirname(resolve(outside)), parent);
    try {
        await writeFile(join(outside, "keep.txt"), "keep");
        for (const replaceRoot of [false, true]) {
            const bundle = await materializeSkillBundle(skill({ "main.mjs": "" }), "main.mjs");
            try {
                if (replaceRoot) await bundle.cleanup();
                await symlink(outside, replaceRoot ? bundle.root : join(bundle.root, "outside"),
                    process.platform === "win32" ? "junction" : "dir");
                await bundle.cleanup();
                assert.equal(existsSync(bundle.root), false);
                assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
            } finally { await bundle.cleanup(); }
        }
    } finally {
        assert.equal(dirname(await realpath(outside)), parent);
        await rm(outside, { recursive: true, force: true });
    }
});

// ── Script environment (Hermes catalog review, 2026-11-05) ─────────────────
// Skill scripts are third-party code: they must never see the server's own
// environment (BHIVED_API_KEY, or any secret in this server's env block).
async function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { return await fn(); } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}
const noSecretsFile = join(tmpdir(), "bhived-test-no-secrets.json");

test("scripts get a minimal env: no BHIVED_* and no other server secrets", async () => {
    await withEnv({
        BHIVED_API_KEY: "bhv-test-key-must-not-leak",
        SOME_SERVER_SECRET: "server-secret-must-not-leak",
        BHIVED_SECRETS_FILE: noSecretsFile,
    }, async () => {
        const result = await run(skill({
            "env.mjs": emit("{keys: Object.keys(process.env), root: process.env.BHIVED_SKILL_ROOT, path: Boolean(process.env.PATH || process.env.Path)}"),
        }));
        assert.equal(result.isError, false, text(result));
        const out = output(result);
        assert.deepEqual(out.keys.filter((k) => /^BHIVED_/i.test(k)), ["BHIVED_SKILL_ROOT"]);
        assert.ok(!out.keys.includes("SOME_SERVER_SECRET"));
        assert.ok(out.root, "BHIVED_SKILL_ROOT is set");
        assert.ok(out.path, "PATH is passed");
        assert.ok(!text(result).includes("must-not-leak"));
    });
});

test("declared variables are passed and redacted in output; declared BHIVED_* is dropped", async () => {
    await withEnv({
        SKILL_DECLARED_TOKEN: "declared-token-value-1234",
        BHIVED_API_KEY: "bhv-test-key-must-not-leak",
        BHIVED_SECRETS_FILE: noSecretsFile,
    }, async () => {
        const result = await run(skill(
            { "tok.mjs": emit("{tok: process.env.SKILL_DECLARED_TOKEN ?? null, key: process.env.BHIVED_API_KEY ?? null}") },
            { env_requirements: [
                { name: "SKILL_DECLARED_TOKEN", required: true, secret: true },
                { name: "BHIVED_API_KEY", required: true },
            ] },
        ));
        assert.equal(result.isError, false, text(result));
        const out = output(result);
        assert.equal(out.tok, "[REDACTED SKILL_DECLARED_TOKEN]", "passed to the script, redacted in its output");
        assert.equal(out.key, null);
        assert.ok(!text(result).includes("declared-token-value-1234"));
    });
});

test("a missing required declared variable blocks the run before anything executes", async () => {
    await withEnv({ SKILL_MISSING_VAR: undefined, BHIVED_SECRETS_FILE: noSecretsFile }, async () => {
        const before = await tempRuns();
        const result = await run(skill(
            { "never.mjs": emit("{ran: true}") },
            { env_requirements: [{ name: "SKILL_MISSING_VAR", required: true, description: "Token for the service" }] },
        ));
        assert.equal(result.isError, true);
        assert.match(text(result), /Missing SKILL_MISSING_VAR: Token for the service/);
        assert.doesNotMatch(text(result), /RESULT:/);
        assert.deepEqual(await tempRuns(), before);
    });
});
