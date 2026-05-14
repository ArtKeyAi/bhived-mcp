/**
 * bhived_run_script Tool
 *
 * Executes a script from an activated skill in a sandboxed subprocess.
 * Scripts are admin-curated — agents never upload their own scripts.
 *
 * Runtime detection:
 *   .py  → python3 (or python on Windows)
 *   .js  → node
 *   .ts  → npx tsx
 *   .sh  → bash (Git Bash on Windows, /bin/bash on Unix)
 *
 * Cross-platform: Windows (Git Bash / WSL), Linux, macOS
 */

import { existsSync } from "node:fs";
import { z } from "zod/v4";
import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { skillRegistry } from "../registries/skillRegistry.js";
import { config } from "../config.js";

const RunScriptInputSchema = z.object({
    skill: z
        .string()
        .min(1)
        .describe("Name of the activated skill."),
    script: z
        .string()
        .min(1)
        .describe('Script filename (e.g., "analyze.py").'),
    args: z
        .string()
        .optional()
        .describe("Command-line arguments to pass."),
    input_data: z
        .string()
        .optional()
        .describe("Data to pipe to stdin."),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .default(30000)
        .describe("Execution timeout in milliseconds (default: 30000, max: 120000)."),
}).strict();

type RunScriptInput = z.infer<typeof RunScriptInputSchema>;

const RUN_SCRIPT_DESCRIPTION = `Execute a script from an activated skill. The script runs as
a temporary local subprocess and returns its output. Scripts are
admin-curated, but they can execute code on this machine.

Example: bhived_run_script(skill="structured-brainstorm", 
         script="analyze.py", args="--input ideas.json")`;

// ── Cross-platform bash detection ───────────────────────────────

type BashType = "git" | "native";

/** Cached result for Git Bash detection on Windows */
let _gitBashPath: string | null | undefined;

/**
 * Find Git Bash on Windows. Checks common install locations.
 * Returns the full path to bash.exe or null if not found.
 * Result is cached after first call.
 */
function findGitBash(): string | null {
    if (_gitBashPath !== undefined) return _gitBashPath;

    const candidates = [
        `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`,
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`,
    ].filter(Boolean) as string[];

    for (const p of candidates) {
        try {
            if (existsSync(p)) {
                console.error(`[RunScript] Found Git Bash at: ${p}`);
                _gitBashPath = p;
                return _gitBashPath;
            }
        } catch {
            // Continue checking
        }
    }

    _gitBashPath = null;
    return null;
}

interface RuntimeInfo {
    command: string;
    args: string[];
    bashType?: BashType;
    /** If set, runtime detection failed — return this error to the user */
    error?: string;
}

/**
 * Detect the appropriate runtime command from the script file extension.
 * Cross-platform: Windows (PowerShell for .ps1, cmd for .bat, Git Bash for .sh),
 * Linux and macOS (native bash for .sh).
 */
function detectRuntime(filename: string): RuntimeInfo {
    const ext = filename.split(".").pop()?.toLowerCase();
    switch (ext) {
        case "py":
            return {
                command: process.platform === "win32" ? "python" : "python3",
                args: [],
            };
        case "js":
            return { command: "node", args: [] };
        case "ts":
            return { command: "npx", args: ["tsx"] };
        case "ps1":
            // PowerShell — native on Windows, available on Linux/macOS via pwsh
            return {
                command: process.platform === "win32" ? "powershell" : "pwsh",
                args: ["-ExecutionPolicy", "Bypass", "-File"],
            };
        case "bat":
        case "cmd":
            // Windows batch scripts
            if (process.platform !== "win32") {
                return {
                    command: "",
                    args: [],
                    error: `.bat/.cmd scripts can only run on Windows.`,
                };
            }
            return { command: "cmd.exe", args: ["/c"] };
        case "sh": {
            if (process.platform === "win32") {
                // Try Git Bash — most Windows devs have Git installed
                const gitBash = findGitBash();
                if (gitBash) {
                    return { command: gitBash, args: [], bashType: "git" };
                }
                // No bash available — clear error
                return {
                    command: "",
                    args: [],
                    error: `.sh scripts require Git for Windows (Git Bash). ` +
                        `Install from https://git-scm.com/download/win — ` +
                        `or ask the skill author to provide a .ps1 or .bat alternative.`,
                };
            }
            // Linux / macOS — native bash
            return { command: "/bin/bash", args: [], bashType: "native" };
        }
        default:
            return { command: "node", args: [] };
    }
}

/**
 * Convert a Windows file path for use with Git Bash.
 * Git Bash: C:\Users\... → C:/Users/... (just forward slashes)
 * Native (Linux/macOS): no conversion needed
 */
function convertPathForBash(filePath: string, bashType: BashType): string {
    if (bashType === "native") return filePath;
    // Git Bash handles C:/Users/... with forward slashes
    return filePath.replace(/\\/g, "/");
}

// ── Tool registration ───────────────────────────────────────────

export function registerRunScriptTool(server: McpServer): void {
    server.registerTool(
        "bhived_run_script",
        {
            title: "Run Skill Script",
            description: RUN_SCRIPT_DESCRIPTION,
            inputSchema: RunScriptInputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async (params: RunScriptInput) => {
            let tempDir: string | undefined;
            let tempFile: string | undefined;

            try {
                // 1. Look up skill
                const skill = skillRegistry.get(params.skill);
                if (!skill) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ Skill '${params.skill}' is not active. Call bhived_initiate_skill first.`,
                            },
                        ],
                        isError: true,
                    };
                }

                // 2. Look up script
                const scriptContent = skill.scripts[params.script];
                if (scriptContent === undefined) {
                    const available = Object.keys(skill.scripts);
                    const availableList = available.length > 0
                        ? "\n\nAvailable scripts:\n" + available.map((s) => `  • ${s}`).join("\n")
                        : "\n\nNo scripts registered for this skill.";

                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ Script '${params.script}' not found in skill '${params.skill}'.${availableList}`,
                            },
                        ],
                        isError: true,
                    };
                }

                // 3. Write script to temp file
                tempDir = await mkdtemp(join(tmpdir(), "bhived-script-"));
                // Script name may include subdirectory (e.g. "math/index.js")
                // Extract just the base filename for the temp file
                const scriptBasename = params.script.split("/").pop() ?? params.script;
                tempFile = join(tempDir, scriptBasename);
                await writeFile(tempFile, scriptContent, "utf-8");

                // 4. Detect runtime and build command
                const runtime = detectRuntime(params.script);

                // If runtime detection failed (e.g. .sh on Windows without Git Bash)
                if (runtime.error) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ Cannot run '${params.script}': ${runtime.error}`,
                            },
                        ],
                        isError: true,
                    };
                }

                // Convert path for Git Bash on Windows (forward slashes)
                let scriptPath = tempFile;
                if (runtime.bashType && process.platform === "win32") {
                    scriptPath = convertPathForBash(tempFile, runtime.bashType);
                }

                const execArgs = [
                    ...runtime.args,
                    scriptPath,
                    ...(params.args ? params.args.split(" ") : []),
                ];

                // 5. Execute with timeout
                const timeout = Math.min(params.timeout ?? config.scriptTimeout, 120000);
                const result = await executeScript(
                    runtime.command,
                    execArgs,
                    params.input_data,
                    timeout
                );

                // 6. Format and return output
                const header = `## ⚡ Script Output: ${params.script}\n**Skill**: ${params.skill} · **Exit code**: ${result.exitCode} · **Duration**: ${result.durationMs}ms\n\n---\n\n`;
                const output = result.stdout
                    ? `### stdout\n\`\`\`\n${result.stdout}\n\`\`\`\n`
                    : "";
                const stderr = result.stderr
                    ? `\n### stderr\n\`\`\`\n${result.stderr}\n\`\`\`\n`
                    : "";

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: header + output + stderr,
                        },
                    ],
                    isError: result.exitCode !== 0,
                };
            } catch (error: unknown) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error running script: ${error instanceof Error ? error.message : String(error)}`,
                        },
                    ],
                    isError: true,
                };
            } finally {
                // Cleanup temp file
                if (tempFile) {
                    try {
                        await unlink(tempFile);
                    } catch {
                        // Best effort cleanup
                    }
                }
            }
        }
    );
}

// ── Script execution ────────────────────────────────────────────

interface ScriptResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
}

function executeScript(
    command: string,
    args: string[],
    inputData?: string,
    timeout = 30000
): Promise<ScriptResult> {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const child = spawn(command, args, {
            timeout,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data: Buffer) => {
            stdout += data.toString();
            // Cap output at 50KB to prevent memory issues
            if (stdout.length > 50 * 1024) {
                stdout = stdout.slice(0, 50 * 1024) + "\n...[output truncated at 50KB]";
                child.kill("SIGTERM");
            }
        });

        child.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
            if (stderr.length > 50 * 1024) {
                stderr = stderr.slice(0, 50 * 1024) + "\n...[output truncated at 50KB]";
            }
        });

        child.on("error", (err) => {
            reject(new Error(`Failed to execute ${command}: ${err.message}`));
        });

        child.on("close", (code) => {
            resolve({
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                exitCode: code ?? 1,
                durationMs: Date.now() - startTime,
            });
        });

        // Write stdin data if provided
        if (inputData) {
            child.stdin.write(inputData);
            child.stdin.end();
        } else {
            child.stdin.end();
        }
    });
}
