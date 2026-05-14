/**
 * Child MCP Manager
 *
 * Spawns child MCP processes, connects via stdio transport,
 * discovers their tools, and manages their full lifecycle.
 *
 * This is the core engine for the Evolving Hub — it bridges
 * between the Bhived MCP server and any number of child
 * MCP servers running as subprocesses.
 */

import { spawn as nodeSpawn, execSync, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    childMcpRegistry,
    type ChildMcpEntry,
    type ChildMcpTool,
} from "../registries/childMcpRegistry.js";
import type { McpConfig, McpPayload } from "../client/types.js";
import { config } from "../config.js";

// ── Types ────────────────────────────────────────────────────────

export interface SpawnResult {
    /** Name of the spawned MCP */
    name: string;
    /** Tools discovered from the child */
    tools: ChildMcpTool[];
    /** The MCP Client instance */
    client: Client;
}

export interface SpawnOptions {
    /** Where this child came from: "standalone" or "skill:{name}" */
    source: `skill:${string}` | "standalone";
    /** Memory ID from the backend (for tracking) */
    memory_id: string;
    /** Connection timeout in milliseconds (default: 15000) */
    connectTimeout?: number;
}

// ── Manager ──────────────────────────────────────────────────────

export class ChildMcpManager {
    private healthInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * Spawn a child MCP process, connect to it, and discover its tools.
     *
     * Flow:
     *   1. Create StdioClientTransport (which spawns the child process)
     *   2. Create MCP Client and connect via the transport
     *   3. client.listTools() to discover available tools
     *   4. Register in ChildMcpRegistry
     *   5. Set up crash handler
     *   6. Return discovered tools
     */
    async spawn(
        mcpConfig: McpConfig | McpPayload,
        options: SpawnOptions
    ): Promise<SpawnResult> {
        const name = mcpConfig.name;
        // Package runner commands may need to download packages on first run — use longer timeout
        const needsDownload = ["npx", "uvx", "pipx", "uv"].includes(mcpConfig.command);
        const defaultTimeout = needsDownload ? 120000 : 30000;
        const connectTimeout = options.connectTimeout ?? defaultTimeout;

        // Check if already running
        if (childMcpRegistry.has(name)) {
            const existing = childMcpRegistry.get(name)!;
            if (existing.status === "active") {
                return {
                    name,
                    tools: existing.tools,
                    client: existing.client,
                };
            }
            // If crashed, remove and re-spawn
            childMcpRegistry.remove(name);
        }

        let transport: StdioClientTransport | undefined;
        let client: Client | undefined;

        // Collect stderr output from the child process for diagnostics
        let stderrOutput = "";

        try {
            // 0. Pre-flight: verify the command binary exists on the system
            this.validateCommand(mcpConfig.command);

            // ── Debug: log the exact spawn command ──
            const mcpEnvKeys = Object.keys(mcpConfig.env || {});
            console.error(
                `[ChildMcpManager] Spawning '${name}':\n` +
                `  command: ${mcpConfig.command}\n` +
                `  args: ${JSON.stringify(mcpConfig.args)}\n` +
                `  mcp env keys: ${mcpEnvKeys.join(", ") || "(none)"}\n` +
                `  timeout: ${connectTimeout}ms (${needsDownload ? "extended for package download" : "standard"})`
            );

            // 1. Create the stdio transport with stderr piped for diagnostics
            //    The SDK handles default env inheritance (PATH, APPDATA, etc.)
            //    automatically inside start(). We only pass MCP-specific env vars.
            transport = new StdioClientTransport({
                command: mcpConfig.command,
                args: mcpConfig.args,
                env: mcpConfig.env && Object.keys(mcpConfig.env).length > 0
                    ? mcpConfig.env
                    : undefined,  // Let SDK use its own defaults when no custom env needed
                stderr: "pipe",
            });

            // ── Capture stderr from the child process for diagnostics ──
            // The SDK's PassThrough stream is available immediately when stderr: 'pipe'
            if (transport.stderr) {
                transport.stderr.on("data", (chunk: Buffer) => {
                    stderrOutput += chunk.toString();
                    // Cap at 4KB to avoid memory issues
                    if (stderrOutput.length > 4096) {
                        stderrOutput = stderrOutput.slice(-4096);
                    }
                });
            }

            // 2. Create and connect the MCP client with a timeout
            client = new Client({
                name: `bhived-${name}`,
                version: "1.0.0",
            });

            // Race the connection against a cancellable timeout
            await this.raceWithTimeout(
                client.connect(transport),
                connectTimeout,
                `Connection to '${name}' timed out after ${connectTimeout}ms`
            );

            // 3. Discover tools
            const { tools: rawTools } = await client.listTools();
            const tools: ChildMcpTool[] = rawTools.map((tool) => ({
                name: tool.name,
                description: tool.description ?? "",
                inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
            }));

            // 4. Get a reference to the underlying child process from transport
            //    The SDK stores it as `_process` after start() completes
            const childProcess = this.extractChildProcess(transport, name);

            // 5. Build the registry entry
            const entry: ChildMcpEntry = {
                process: childProcess,
                client,
                tools,
                config: {
                    name: mcpConfig.name,
                    description: mcpConfig.description,
                    command: mcpConfig.command,
                    args: mcpConfig.args,
                    env: mcpConfig.env,
                },
                source: options.source,
                memory_id: options.memory_id,
                status: "active",
                spawned_at: new Date(),
            };

            // 6. Register in the registry (enforces limits)
            childMcpRegistry.add(name, entry);

            // 7. Set up crash handler
            this.setupCrashHandler(name, childProcess);

            console.error(
                `[ChildMcpManager] Spawned '${name}' successfully (${tools.length} tools): ` +
                `${tools.map((t) => t.name).join(", ")}`
            );

            return { name, tools, client };
        } catch (error) {
            // ── Enhanced error with contextual hints ──
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(
                `[ChildMcpManager] SPAWN FAILED for '${name}':\n` +
                `  error: ${errorMsg}\n` +
                `  command: ${mcpConfig.command}\n` +
                `  args: ${JSON.stringify(mcpConfig.args)}\n` +
                `  child stderr: ${stderrOutput || "(empty)"}`
            );

            // Cleanup on failure
            try {
                if (client) await client.close();
            } catch {
                // Best effort
            }
            try {
                if (transport) await transport.close();
            } catch {
                // Best effort
            }

            // Build actionable error with stderr + contextual hints
            const stderrHint = stderrOutput
                ? `\nChild process stderr:\n${stderrOutput.slice(0, 1500)}`
                : "";
            const contextHint = this.buildErrorHints(mcpConfig, stderrOutput, errorMsg);
            throw new Error(
                `Failed to spawn MCP '${name}': ${errorMsg}${stderrHint}${contextHint}`
            );
        }
    }

    /**
     * Stop a child MCP process gracefully.
     *
     * Flow:
     *   1. Close the MCP client (sends SIGTERM via transport)
     *   2. Wait up to 5s for process to exit
     *   3. SIGKILL if still alive
     *   4. Remove from registry
     */
    async stop(mcpName: string): Promise<void> {
        const entry = childMcpRegistry.get(mcpName);
        if (!entry) {
            throw new Error(`No active MCP named '${mcpName}'`);
        }

        console.error(`[ChildMcpManager] Stopping '${mcpName}'...`);

        try {
            // client.close() will close the transport which sends SIGTERM
            await this.raceWithTimeout(
                entry.client.close(),
                5000,
                "Client close timed out"
            );
        } catch {
            // If close fails, force kill
            try {
                entry.process.kill("SIGKILL");
            } catch {
                // Process may already be dead
            }
        }

        // Ensure the process is dead
        if (!entry.process.killed) {
            try {
                entry.process.kill("SIGKILL");
            } catch {
                // Process may already be dead
            }
        }

        childMcpRegistry.remove(mcpName);
        console.error(`[ChildMcpManager] Stopped '${mcpName}'`);
    }

    /**
     * Forward a tool call to a child MCP.
     */
    async callTool(
        mcpName: string,
        toolName: string,
        params: Record<string, unknown> = {}
    ): Promise<unknown> {
        const entry = childMcpRegistry.get(mcpName);
        if (!entry) {
            throw new Error(`No active MCP named '${mcpName}'`);
        }
        if (entry.status === "crashed") {
            throw new Error(`MCP '${mcpName}' has crashed and is not responding`);
        }

        const result = await entry.client.callTool({
            name: toolName,
            arguments: params,
        });

        return result;
    }

    /**
     * Start a periodic health monitor that pings each child MCP.
     * On failure, marks the child as crashed and clears its tools.
     */
    startHealthMonitor(): void {
        if (this.healthInterval) return; // Already running

        const interval = config.childHealthInterval;
        console.error(`[ChildMcpManager] Health monitor started (interval: ${interval}ms)`);

        this.healthInterval = setInterval(async () => {
            const entries = childMcpRegistry.list();
            for (const entry of entries) {
                if (entry.status === "crashed") continue;

                const name = childMcpRegistry.names().find(
                    (n) => childMcpRegistry.get(n) === entry
                );
                if (!name) continue;

                try {
                    // Ping by listing tools — lightweight health check
                    await this.raceWithTimeout(
                        entry.client.listTools(),
                        5000,
                        "Health check timed out"
                    );
                } catch {
                    console.error(`[ChildMcpManager] Health check failed for '${name}' — deactivating automatically`);
                    childMcpRegistry.remove(name);
                }
            }
        }, interval);

        // Don't let the health monitor prevent process exit
        if (this.healthInterval.unref) {
            this.healthInterval.unref();
        }
    }

    /**
     * Stop the health monitor.
     */
    stopHealthMonitor(): void {
        if (this.healthInterval) {
            clearInterval(this.healthInterval);
            this.healthInterval = null;
            console.error("[ChildMcpManager] Health monitor stopped");
        }
    }

    /**
     * Gracefully cleanup all child MCP processes.
     * Called during process exit / SIGINT / SIGTERM.
     */
    async cleanupAll(): Promise<void> {
        this.stopHealthMonitor();

        const names = childMcpRegistry.names();
        if (names.length === 0) return;

        console.error(`[ChildMcpManager] Cleaning up ${names.length} child MCP(s)...`);

        const cleanupPromises = names.map(async (name) => {
            try {
                await this.stop(name);
            } catch (error) {
                console.error(
                    `[ChildMcpManager] Error stopping '${name}': ${error instanceof Error ? error.message : String(error)}`
                );
                // Force kill as last resort
                const entry = childMcpRegistry.get(name);
                if (entry?.process && !entry.process.killed) {
                    try {
                        entry.process.kill("SIGKILL");
                    } catch {
                        // Already dead
                    }
                }
                childMcpRegistry.remove(name);
            }
        });

        // Wait for all cleanups with a global timeout
        await this.raceWithTimeout(
            Promise.allSettled(cleanupPromises),
            10000,
            "Cleanup timeout"
        ).catch(() => {
            // On timeout, force kill everything remaining
            for (const name of childMcpRegistry.names()) {
                const entry = childMcpRegistry.get(name);
                if (entry?.process && !entry.process.killed) {
                    try {
                        entry.process.kill("SIGKILL");
                    } catch {
                        // Already dead
                    }
                }
                childMcpRegistry.remove(name);
            }
        });

        console.error("[ChildMcpManager] All child MCPs cleaned up");
    }

    /**
     * Stop all child MCPs that belong to a specific skill.
     */
    async stopBySkill(skillName: string): Promise<string[]> {
        const entries = childMcpRegistry.listBySkill(skillName);
        const stoppedNames: string[] = [];

        for (const entry of entries) {
            const name = childMcpRegistry.names().find(
                (n) => childMcpRegistry.get(n) === entry
            );
            if (name) {
                try {
                    await this.stop(name);
                    stoppedNames.push(name);
                } catch (error) {
                    console.error(
                        `[ChildMcpManager] Error stopping skill-bundled MCP '${name}': ` +
                        `${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        }

        return stoppedNames;
    }

    // ── Private helpers ──────────────────────────────────────────

    /**
     * Extract the child process from the StdioClientTransport.
     *
     * The SDK stores the child process as `_process` (private). After
     * connection succeeds, the process is alive. On close/crash, the
     * SDK sets `_process = undefined`, so we must extract it while
     * the transport is connected.
     *
     * We also check for the `pid` getter (public API since SDK v1.x)
     * to avoid relying solely on private internals.
     */
    private extractChildProcess(transport: StdioClientTransport, mcpName: string): ChildProcess {
        // Approach 1: Try the internal `_process` property (SDK v1.x stores it here)
        const transportAny = transport as unknown as { _process?: ChildProcess };
        if (transportAny._process) {
            return transportAny._process;
        }

        // Approach 2: If we have a PID from the public getter, we can't get the
        // ChildProcess object from it, but at least we know it's running.
        // Fall back to a sentinel with a warning.
        const pid = transport.pid;
        console.error(
            `[ChildMcpManager] Warning: Could not extract child process object for '${mcpName}'.` +
            (pid ? ` PID is ${pid}.` : " PID unknown.") +
            " Crash detection may not work — process lifecycle managed by SDK."
        );

        // Create a sentinel process so the rest of the code doesn't break.
        // Using a no-op command on Windows (cmd /c exit) or Unix (true)
        const sentinel = process.platform === "win32"
            ? nodeSpawn("cmd", ["/c", "exit"], { stdio: "ignore" })
            : nodeSpawn("true", [], { stdio: "ignore" });
        return sentinel;
    }

    /**
     * Set up a crash handler on the child process.
     * When the process exits unexpectedly, mark it as crashed.
     */
    private setupCrashHandler(name: string, childProc: ChildProcess): void {
        childProc.on("exit", (code, signal) => {
            const entry = childMcpRegistry.get(name);
            if (entry && entry.status === "active") {
                console.error(
                    `[ChildMcpManager] Child '${name}' exited unexpectedly ` +
                    `(code: ${code}, signal: ${signal}) — deactivating automatically`
                );
                childMcpRegistry.remove(name);
            }
        });

        childProc.on("error", (err) => {
            const entry = childMcpRegistry.get(name);
            if (entry) {
                console.error(
                    `[ChildMcpManager] Child '${name}' error: ${err.message} — deactivating automatically`
                );
                childMcpRegistry.remove(name);
            }
        });
    }

    /**
     * Validate that the command binary exists on the system.
     * Throws with an actionable error message if not found.
     */
    private validateCommand(command: string): void {
        // Skip validation for absolute paths (they either exist or spawn will fail clearly)
        if (command.includes("/") || command.includes("\\")) return;

        try {
            const whereCmd = process.platform === "win32" ? "where" : "which";
            execSync(`${whereCmd} ${command}`, { stdio: "ignore" });
        } catch {
            const installHints: Record<string, string> = {
                uvx: "Install uv: https://docs.astral.sh/uv/getting-started/installation/",
                npx: "npx comes with Node.js. Install Node.js: https://nodejs.org/",
                pipx: "Install pipx: https://pipx.pypa.io/stable/installation/",
                docker: "Install Docker: https://docs.docker.com/get-docker/",
            };
            const hint = installHints[command] ?? `Ensure '${command}' is installed and in your PATH.`;
            throw new Error(
                `Command '${command}' not found on this system. ${hint}`
            );
        }
    }

    /**
     * Build contextual error hints based on stderr output and the MCP config.
     * Helps agents understand what went wrong and what to try.
     */
    private buildErrorHints(
        mcpConfig: McpConfig | McpPayload,
        stderr: string,
        errorMsg: string,
    ): string {
        const hints: string[] = [];

        // Detect missing Python extras
        if (stderr.includes("ModuleNotFoundError") || stderr.includes("No module named")) {
            hints.push(
                "The Python package appears to be missing required extras or dependencies. " +
                "For packages installed via uvx/pip, try installing with extras " +
                `(e.g., \`pip install "${mcpConfig.args?.[0] || mcpConfig.name}[all]"\`).`
            );
        }

        // Detect connection closed (process crashed immediately)
        if (errorMsg.includes("Connection closed") || errorMsg.includes("-32000")) {
            hints.push(
                "The child process exited before completing the MCP handshake. " +
                "This usually means the child crashed on startup."
            );
        }

        // Detect npm/node module issues
        if (stderr.includes("Cannot find module") || stderr.includes("MODULE_NOT_FOUND")) {
            hints.push(
                "A Node.js module is missing. This can happen if the package wasn't fully installed. " +
                "Try running the command manually to see the full error."
            );
        }

        // Detect timeout
        if (errorMsg.includes("timed out")) {
            hints.push(
                "The connection timed out. If this is the first run and the command needs to " +
                "download packages (uvx/npx), try again — the download may complete next time."
            );
        }

        if (hints.length === 0) return "";
        return "\n\n💡 Hints:\n" + hints.map((h) => `- ${h}`).join("\n");
    }

    /**
     * Race a promise against a timeout, properly cleaning up the timer.
     * Unlike bare Promise.race with setTimeout, this avoids timer leaks.
     */
    private async raceWithTimeout<T>(
        promise: Promise<T>,
        ms: number,
        message: string
    ): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        });

        try {
            const result = await Promise.race([promise, timeoutPromise]);
            return result;
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }
}

/** Singleton ChildMcpManager instance */
export const childMcpManager = new ChildMcpManager();
