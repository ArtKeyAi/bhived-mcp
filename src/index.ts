#!/usr/bin/env node
/**
 * Bhived MCP Server — Entry Point
 *
 * Creates the MCP server, registers all tools/resources/prompts,
 * and starts the appropriate transport (stdio or streamable-http).
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";

// Tools — Core
import { registerQueryTool } from "./tools/query.js";
import { registerWriteTools } from "./tools/write.js";
import { registerInspectTool } from "./tools/inspect.js";

// Tools — Phase 2 (registry-based, no child process management)
import { registerReadResourceTool } from "./tools/readResource.js";
import { registerRunScriptTool } from "./tools/runScript.js";
import { registerListActiveTool } from "./tools/listActive.js";
import { registerUseToolTool } from "./tools/useTool.js";

// Tools — Phase 4 (initiation & deactivation)
import { registerInitiateSkillTool } from "./tools/initiateSkill.js";
import { registerInitiateMcpTool } from "./tools/initiateMcp.js";
import { registerStopMcpTool } from "./tools/stopMcp.js";

// Child MCP lifecycle
import { childMcpManager } from "./childMcp/manager.js";

// Registries (for Phase 7 — resource protocol)
import { resourceRegistry } from "./registries/resourceRegistry.js";
import { skillRegistry } from "./registries/skillRegistry.js";
import { childMcpRegistry } from "./registries/childMcpRegistry.js";

// Resources
import { getStatusContent } from "./resources/status.js";
import { AGENT_GUIDE } from "./resources/guide.js";

// Prompts
import { registerLearnAndSharePrompt } from "./prompts/learnAndShare.js";

// AGENTS.md bootstrapper
import { setupAgentsMdBootstrap } from "./agentsMd.js";
import { registerReviewMemoryPrompt } from "./prompts/reviewMemory.js";

// ── Server factory ───────────────────────────────────────────────
// Creates a fully-configured McpServer instance.
// Used once for stdio, or per-request for stateless HTTP.

function createServer(): McpServer {
    const server = new McpServer({
        name: "bhived-mcp",
        version: "2.0.0",
    });

    // ── Register tools — Core ────────────────────────────────────
    registerQueryTool(server);
    registerWriteTools(server);
    registerInspectTool(server);

    // ── Register tools — Phase 2 (Skills & MCPs) ────────────────
    registerReadResourceTool(server);
    registerRunScriptTool(server);
    registerListActiveTool(server);
    registerUseToolTool(server);

    // ── Register tools — Phase 4 (Initiation & Deactivation) ────
    registerInitiateSkillTool(server);
    registerInitiateMcpTool(server);
    registerStopMcpTool(server);

    // ── Register resources — Static ──────────────────────────────
    server.registerResource(
        "status",
        "bhived://status",
        {
            title: "Bhived Status",
            description:
                "Current Bhived system status — graph size, memory counts, health metrics, active capabilities.",
            mimeType: "text/plain",
        },
        async (uri) => ({
            contents: [
                {
                    uri: uri.href,
                    text: await getStatusContent(),
                },
            ],
        })
    );

    server.registerResource(
        "guide",
        "bhived://guide",
        {
            title: "Agent Guide",
            description: "How to use Bhived effectively as an AI agent.",
            mimeType: "text/markdown",
        },
        async (uri) => ({
            contents: [
                {
                    uri: uri.href,
                    text: AGENT_GUIDE,
                },
            ],
        })
    );

    // ── Register resources — Dynamic skill resources (Phase 7) ──
    // Provides MCP protocol-level access to activated skill resources
    // via bhived://skill/{skillName}/{type}/{filename} URIs.
    server.registerResource(
        "skill-resource",
        new ResourceTemplate("bhived://skill/{skillName}/{type}/{filename}", {
            list: async () => ({
                resources: resourceRegistry.list().map((r) => ({
                    uri: r.uri,
                    name: `${r.source_skill}/${r.uri.split("/").slice(-2).join("/")}`,
                    description: `${r.mimeType} resource from skill '${r.source_skill}'`,
                    mimeType: r.mimeType,
                })),
            }),
        }),
        {
            title: "Skill Resource",
            description:
                "Read resources (scripts, references, assets) from activated skills. " +
                "URI format: bhived://skill/{skillName}/{type}/{filename}",
            mimeType: "text/plain",
        },
        async (uri, { skillName, type, filename }) => {
            const resourceUri = `bhived://skill/${skillName}/${type}/${filename}`;
            const entry = resourceRegistry.get(resourceUri);

            if (!entry) {
                return {
                    contents: [
                        {
                            uri: uri.href,
                            text: `Resource not found: ${resourceUri}. Is the skill '${skillName}' activated?`,
                        },
                    ],
                };
            }

            return {
                contents: [
                    {
                        uri: uri.href,
                        text: entry.content,
                        mimeType: entry.mimeType,
                    },
                ],
            };
        }
    );

    // ── Register resources — Active capabilities overview ────────
    server.registerResource(
        "capabilities",
        "bhived://capabilities",
        {
            title: "Active Capabilities",
            description:
                "Overview of currently active skills, child MCPs, and registered resources.",
            mimeType: "text/markdown",
        },
        async (uri) => ({
            contents: [
                {
                    uri: uri.href,
                    text: buildCapabilitiesOverview(),
                },
            ],
        })
    );

    // ── Register prompts ─────────────────────────────────────────
    registerLearnAndSharePrompt(server);
    registerReviewMemoryPrompt(server);

    // ── Bootstrap AGENTS.md on initialization ────────────────────
    // Hooks into the MCP lifecycle: after the client handshake completes,
    // requests the client's workspace roots and writes AGENTS.md there.
    setupAgentsMdBootstrap(server.server);

    return server;
}

// ── Capabilities overview builder ────────────────────────────────

function buildCapabilitiesOverview(): string {
    const lines: string[] = [];

    lines.push("# Bhived Active Capabilities\n");

    // Skills
    const skills = skillRegistry.list();
    if (skills.length > 0) {
        lines.push(`## 🔧 Active Skills (${skills.length}/${config.maxActiveSkills})\n`);
        for (const skill of skills) {
            const scriptCount = Object.keys(skill.scripts).length;
            const refCount = Object.keys(skill.references).length;
            const assetCount = Object.keys(skill.assets).length;
            lines.push(`- **${skill.name}** (memory: \`${skill.memory_id}\`)`);
            lines.push(`  📦 ${scriptCount} scripts, ${refCount} references, ${assetCount} assets`);
            if (skill.mcp_names.length > 0) {
                lines.push(`  🔌 Bundled MCPs: ${skill.mcp_names.join(", ")}`);
            }
            lines.push(`  ⏱️ Activated: ${skill.activated_at.toISOString()}`);
            lines.push("");
        }
    } else {
        lines.push("## 🔧 Active Skills\n\n*No skills currently active.*\n");
    }

    // Child MCPs
    const mcps = childMcpRegistry.list();
    if (mcps.length > 0) {
        lines.push(`## 🔌 Active MCPs (${mcps.length}/${config.maxChildProcesses})\n`);
        for (const mcp of mcps) {
            const status = mcp.status === "active" ? "🟢" : "🔴";
            lines.push(`- ${status} **${mcp.config.name}** (${mcp.source})`);
            lines.push(`  🔧 ${mcp.tools.length} tools: ${mcp.tools.map((t) => t.name).join(", ") || "none"}`);
            lines.push(`  ⏱️ Spawned: ${mcp.spawned_at.toISOString()}`);
            lines.push("");
        }
    } else {
        lines.push("## 🔌 Active MCPs\n\n*No MCPs currently active.*\n");
    }

    // Resources
    const resourceCount = resourceRegistry.count();
    lines.push(`## 📁 Resources: ${resourceCount} registered\n`);

    return lines.join("\n");
}

// ── Transport ────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Bhived MCP server running on stdio");
    console.error(`REST API: ${config.apiUrl}`);

    // Start child MCP health monitoring (Phase 7.1)
    childMcpManager.startHealthMonitor();

    // Graceful shutdown for stdio (Phase 7.2)
    const shutdown = async () => {
        console.error("Shutting down Bhived MCP server...");
        await childMcpManager.cleanupAll();
        await server.close();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

async function runHttp(): Promise<void> {
    // Dynamic import to avoid loading express when using stdio
    const { default: express } = await import("express");
    const { StreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );

    const app = express();
    app.use(express.json());

    // ── Origin validation middleware (DNS rebinding protection) ──
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map(o => o.trim()) ?? [];
    if (allowedOrigins.length > 0) {
        app.use("/mcp", (req, res, next) => {
            const origin = req.headers.origin;
            if (origin && !allowedOrigins.includes(origin)) {
                res.status(403).json({
                    jsonrpc: "2.0",
                    error: { code: -32000, message: "Origin not allowed" },
                    id: null,
                });
                return;
            }
            next();
        });
    }

    // ── POST /mcp — handle JSON-RPC requests (stateless) ────────
    app.post("/mcp", async (req, res) => {
        // Stateless mode: create a new server + transport per request
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });

        res.on("close", () => {
            transport.close().catch(() => { });
        });

        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });

    // ── GET /mcp — SSE stream for server-to-client messages ─────
    // Spec requires: return text/event-stream OR 405
    app.get("/mcp", (_req, res) => {
        res.status(405).set("Allow", "POST").json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "SSE streaming not supported in stateless mode. Use POST to send requests.",
            },
            id: null,
        });
    });

    // ── DELETE /mcp — session termination ────────────────────────
    // Stateless mode: no sessions to terminate
    app.delete("/mcp", (_req, res) => {
        res.status(405).set("Allow", "POST").json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Session termination not applicable in stateless mode.",
            },
            id: null,
        });
    });

    // ── Well-known MCP discovery routes ─────────────────────────
    // The MCP Inspector probes these routes for OAuth discovery.
    // Since we don't use OAuth, return 404 with proper JSON-RPC.
    app.get("/.well-known/oauth-protected-resource", (_req, res) => {
        res.status(404).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "OAuth is not required for this server.",
            },
            id: null,
        });
    });

    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
        res.status(404).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "OAuth is not required for this server.",
            },
            id: null,
        });
    });

    // ── Client registration (not supported) ─────────────────────
    app.post("/register", (_req, res) => {
        res.status(404).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Dynamic client registration is not supported.",
            },
            id: null,
        });
    });

    // ── Root path handlers ──────────────────────────────────────
    // Redirect root requests to /mcp
    app.post("/", async (req, res) => {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });

        res.on("close", () => {
            transport.close().catch(() => { });
        });

        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });

    app.get("/", (_req, res) => {
        res.status(405).set("Allow", "POST").json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Use POST to send MCP requests. Endpoint: /mcp",
            },
            id: null,
        });
    });

    // ── Health endpoint ──────────────────────────────────────────
    app.get("/health", (_req, res) => {
        res.json({
            status: "ok",
            server: "bhived-mcp",
            version: "2.0.0",
            active_skills: skillRegistry.count(),
            active_mcps: childMcpRegistry.count(),
            active_resources: resourceRegistry.count(),
        });
    });

    // Bind to 127.0.0.1 by default per MCP spec security guidance
    const host = process.env.HOST ?? "127.0.0.1";

    // Start health monitor for HTTP mode too (Phase 7.1)
    childMcpManager.startHealthMonitor();

    app.listen(config.httpPort, host, () => {
        console.error(
            `Bhived MCP server running on http://${host}:${config.httpPort}/mcp`
        );
        console.error(`REST API: ${config.apiUrl}`);
    });

    // Graceful shutdown for HTTP (Phase 7.2)
    const shutdown = async () => {
        console.error("Shutting down Bhived MCP server...");
        await childMcpManager.cleanupAll();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

// ── Process exit safety net (Phase 7.2) ──────────────────────────
// Synchronous handler — last resort to kill orphaned child processes.
// Cannot use async here; process.on('exit') must be synchronous.
process.on("exit", () => {
    childMcpManager.stopHealthMonitor();
    // Force kill any remaining children synchronously
    const names = childMcpRegistry.names();
    for (const name of names) {
        const entry = childMcpRegistry.get(name);
        if (entry?.process && !entry.process.killed) {
            try {
                entry.process.kill("SIGKILL");
            } catch {
                // Already dead
            }
        }
    }
});

// ── Start ────────────────────────────────────────────────────────

if (config.transport === "http") {
    runHttp().catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
} else {
    runStdio().catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}
