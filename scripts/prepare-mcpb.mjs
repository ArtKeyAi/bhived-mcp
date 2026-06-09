import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const buildDir = join(root, "mcpb-build");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const includeSmitheryScoreMetadata = process.env.SMITHERY_SCORE_METADATA === "1";

if (!existsSync(join(root, "dist", "index.js"))) {
    throw new Error("dist/index.js not found. Run `npm run build` before preparing the MCPB bundle.");
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

cpSync(join(root, "dist"), join(buildDir, "dist"), { recursive: true });
cpSync(join(root, "README.md"), join(buildDir, "README.md"));
cpSync(join(root, "LICENSE"), join(buildDir, "LICENSE"));

const runtimePackage = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    type: pkg.type,
    main: pkg.main,
    dependencies: pkg.dependencies,
    engines: pkg.engines,
    license: pkg.license,
};

writeJson(join(buildDir, "package.json"), runtimePackage);

const manifest = {
    manifest_version: "0.3",
    name: pkg.name,
    display_name: "Bhived MCP",
    version: pkg.version,
    description: "Shared AI memory with reusable skills and MCP server discovery for agents.",
    long_description:
        "Bhived MCP connects AI agents to Bhived shared memory so they can search proven solutions, avoid known mistakes, activate reusable skills, discover and spawn MCP servers, call child MCP tools, and write back verified learning.",
    author: {
        name: pkg.author,
    },
    repository: pkg.repository,
    homepage: pkg.homepage,
    support: pkg.bugs?.url,
    license: pkg.license,
    server: {
        type: "node",
        entry_point: "dist/index.js",
        mcp_config: {
            command: "node",
            args: ["${__dirname}/dist/index.js"],
            env: {
                BHIVED_API_KEY: "${user_config.bhived_api_key}",
                BHIVED_API_URL: "${user_config.bhived_api_url}",
            },
        },
    },
    user_config: {
        bhived_api_key: {
            type: "string",
            title: "Bhived API Key (or local auth)",
            description: "Required to use Bhived unless you already authenticated locally with `npx bhived auth` and have ~/.bhived/config.json.",
            sensitive: true,
            required: false,
        },
        bhived_api_url: {
            type: "string",
            title: "Bhived API URL",
            description: "Bhived API base URL.",
            default: "https://mcp.bhived.ai",
            required: false,
        },
    },
    tools_generated: true,
    prompts_generated: true,
    keywords: pkg.keywords,
    compatibility: {
        platforms: ["darwin", "win32", "linux"],
        runtimes: {
            node: ">=18.0.0",
        },
    },
    _meta: {
        "ai.smithery": {
            static_responses: buildStaticResponses(),
        },
    },
};

if (includeSmitheryScoreMetadata) {
    manifest.tools = buildToolMetadata({ dotNames: true });
    manifest.prompts = [
        {
            name: "memory.learn_and_share",
            title: "Learn and Share",
            description: "Use bhived before a non-trivial task, then close the loop if you learn something reusable.",
            arguments: [
                { name: "task", description: "The task to complete using bhived shared memory.", required: true },
                { name: "context", description: "Tech stack, constraints, or other relevant context.", required: false },
            ],
        },
        {
            name: "memory.review",
            title: "Review Memory",
            description: "Inspect a bhived memory and decide if verified correction or supersession is needed.",
            arguments: [
                { name: "memory_id", description: "The memory to review.", required: true },
            ],
        },
    ];
}

writeJson(join(buildDir, "manifest.json"), manifest);
execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts"], {
    cwd: buildDir,
    stdio: "inherit",
    shell: process.platform === "win32",
});

console.log(`Prepared MCPB staging directory: ${buildDir}`);

function writeJson(path, value) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildStaticResponses() {
    return {
        initialize: {
            protocolVersion: "2025-06-18",
            capabilities: {
                tools: {},
                prompts: {},
                resources: {},
            },
            serverInfo: {
                name: pkg.name,
                title: "Bhived MCP",
                version: pkg.version,
            },
        },
        "tools/list": {
            tools: buildToolMetadata(),
        },
        "prompts/list": {
            prompts: [
                {
                    name: "learn_and_share",
                    title: "Learn and Share",
                    description: "Use bhived before a non-trivial task, then close the loop if you learn something reusable.",
                    arguments: [
                        { name: "task", description: "The task to complete using bhived shared memory.", required: true },
                        { name: "context", description: "Tech stack, constraints, or other relevant context.", required: false },
                    ],
                },
                {
                    name: "review_memory",
                    title: "Review Memory",
                    description: "Inspect a bhived memory and decide if verified correction or supersession is needed.",
                    arguments: [
                        { name: "memory_id", description: "The memory to review.", required: true },
                    ],
                },
            ],
        },
    };
}

function buildToolMetadata({ dotNames = false } = {}) {
    const name = (flatName, dottedName) => dotNames ? dottedName : flatName;

    return [
        tool(name("bhived_query", "memory.query"), "Search the Hive", "Search bhived shared memory for proven instructions, known pitfalls, warnings, skills, and MCPs before non-trivial work.", objectSchema({
            query: stringParam("Describe what you need help with, including errors and what was tried."),
            context: stringParam("Optional environment, tech stack, constraints, and failed approaches."),
            top_k: integerParam("Maximum number of results to return.", { minimum: 1, maximum: 100, default: 10 }),
            include_episodes: booleanParam("Whether to reconstruct temporal episode chains.", true),
            include_warnings: booleanParam("Whether to include warnings from negative-aware filtering.", true),
            include_disputed: booleanParam("Whether to look up disputed memory pairs.", true),
        }, ["query"]), textOutput(), readOnly()),
        tool(name("bhived_inspect", "memory.inspect"), "Inspect Memory State", "Inspect a memory's full state, status, evolution scores, version history, and graph connections.", objectSchema({
            memory_id: stringParam("The memory ID to inspect."),
        }, ["memory_id"]), objectSchema({
            id: stringParam("Memory ID."),
            text: stringParam("Memory body text."),
            title: stringParam("Memory title."),
            type: stringParam("Memory type."),
            status: stringParam("Memory lifecycle status."),
        }, ["id", "text", "title", "type", "status"]), readOnly()),
        tool(name("bhived_write_instruction", "memory.write.instruction"), "Share What Works", "Write a verified reusable working approach to bhived shared memory.", writeInput("Detailed verified working approach."), writeOutput(), mutating()),
        tool(name("bhived_write_mistake", "memory.write.mistake"), "Warn About Failures", "Write a verified failed approach, error, and root cause so future agents avoid it.", writeInput("Detailed failure, error, conditions, and root cause."), writeOutput(), mutating()),
        tool(name("bhived_write_update", "memory.write.update"), "Share Factual Changes", "Write a factual or version update such as API changes, deprecations, or breaking changes.", writeInput("Detailed factual update and new correct approach."), writeOutput(), mutating()),
        tool(name("bhived_initiate_skill", "skills.activate"), "Initiate Skill", "Activate a reusable skill bundle from bhived, including instructions, resources, scripts, and optionally bundled MCPs.", memoryInput("The bhived skill memory or capability ID to activate."), textOutput(), mutating({ idempotentHint: true })),
        tool(name("bhived_initiate_mcp", "mcps.activate"), "Initiate MCP", "Activate and spawn a discovered MCP server from bhived so its tools can be called through bhived_use_tool.", memoryInput("The bhived MCP memory or capability ID to activate."), textOutput(), mutating({ idempotentHint: true })),
        tool(name("bhived_stop_mcp", "mcps.stop"), "Stop MCP", "Stop a running child MCP server and free local resources.", objectSchema({
            mcp: stringParam("Name of the active MCP server to stop."),
        }, ["mcp"]), textOutput(), { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
        tool(name("bhived_list_active", "capabilities.list"), "List Active Capabilities", "List active skills, child MCPs, registered resources, and available child MCP tools.", objectSchema({
            type: enumParam("Capability type filter.", ["skills", "mcps", "resources", "all"], "all"),
        }), textOutput(), readOnly({ openWorldHint: false })),
        tool(name("bhived_read_resource", "skills.resources.read"), "Read Skill Resource", "Read a reference document, script source, or asset from an activated skill.", objectSchema({
            skill: stringParam("Name of the activated skill."),
            path: stringParam("Resource path such as references/doc.md, scripts/run.py, or assets/template.md."),
        }, ["skill", "path"]), textOutput(), readOnly({ openWorldHint: false })),
        tool(name("bhived_run_script", "skills.scripts.run"), "Run Skill Script", "Execute a curated script from an activated skill as a temporary local subprocess.", objectSchema({
            skill: stringParam("Name of the activated skill."),
            script: stringParam("Script filename to execute."),
            args: stringParam("Optional command-line arguments to pass."),
            input_data: stringParam("Optional data to pipe to stdin."),
            timeout: integerParam("Execution timeout in milliseconds.", { minimum: 1000, maximum: 120000, default: 30000 }),
        }, ["skill", "script"]), textOutput(), mutating()),
        tool(name("bhived_use_tool", "mcps.tools.call"), "Use MCP Tool", "Call a tool exposed by an activated child MCP server.", objectSchema({
            mcp: stringParam("Name of the active child MCP server."),
            tool: stringParam("Name of the child MCP tool to call."),
            params: {
                type: "object",
                description: "Parameters to pass to the child MCP tool as a JSON object.",
                additionalProperties: true,
            },
        }, ["mcp", "tool"]), textOutput(), mutating()),
    ];
}

function tool(name, title, description, inputSchema, outputSchema, annotations) {
    return { name, title, description, inputSchema, outputSchema, annotations };
}

function objectSchema(properties, required = []) {
    return { type: "object", properties, required, additionalProperties: false };
}

function stringParam(description) {
    return { type: "string", description };
}

function integerParam(description, extras = {}) {
    return { type: "integer", description, ...extras };
}

function booleanParam(description, defaultValue) {
    return { type: "boolean", description, default: defaultValue };
}

function enumParam(description, values, defaultValue) {
    return { type: "string", description, enum: values, default: defaultValue };
}

function memoryInput(description) {
    return objectSchema({ memory_id: stringParam(description) }, ["memory_id"]);
}

function writeInput(textDescription) {
    return objectSchema({
        title: stringParam("Short searchable title, 100 characters or fewer."),
        text: stringParam(textDescription),
        query_id: stringParam("Optional query_id returned by bhived_query."),
        model: stringParam("Optional AI model name."),
        supersedes_id: stringParam("Optional memory ID this write supersedes."),
    }, ["title", "text"]);
}

function textOutput() {
    return objectSchema({ text: stringParam("Human-readable result text returned by the tool.") }, ["text"]);
}

function writeOutput() {
    return objectSchema({
        memory_id: stringParam("ID of the created or updated memory."),
        action_performed: enumParam("Write action performed.", ["created", "updated", "superseded"], "created"),
    }, ["memory_id", "action_performed"]);
}

function readOnly(overrides = {}) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, ...overrides };
}

function mutating(overrides = {}) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, ...overrides };
}
