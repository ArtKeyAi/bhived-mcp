/**
 * Child MCP Registry
 *
 * In-memory registry tracking spawned child MCP processes,
 * their client connections, discovered tools, and lifecycle status.
 * Session-scoped — cleaned up when the MCP server exits.
 */

import type { ChildProcess } from "node:child_process";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpConfig } from "../client/types.js";
import { config } from "../config.js";

export interface ChildMcpTool {
    /** Tool name as discovered from the child MCP */
    name: string;
    /** Tool description */
    description: string;
    /** JSON Schema for the tool's input */
    inputSchema: Record<string, unknown>;
}

export interface ChildMcpEntry {
    /** The spawned child process */
    process: ChildProcess;
    /** MCP SDK client connected to the child */
    client: Client;
    /** Tools discovered via client.listTools() */
    tools: ChildMcpTool[];
    /** The config used to spawn this child */
    config: McpConfig;
    /** Where this child came from */
    source: `skill:${string}` | "standalone";
    /** The memory_id from the backend (if applicable) */
    memory_id: string;
    /** Current process status */
    status: "active" | "crashed";
    /** When the child was spawned */
    spawned_at: Date;
}

export class ChildMcpRegistry {
    private readonly children = new Map<string, ChildMcpEntry>();

    /**
     * Register a new child MCP entry.
     * @throws if standalone or total limits are exceeded.
     */
    add(name: string, entry: ChildMcpEntry): void {
        // Enforce standalone limit
        if (entry.source === "standalone") {
            const standaloneCount = this.countBySource("standalone");
            if (standaloneCount >= config.maxStandaloneMcps && !this.children.has(name)) {
                throw new Error(
                    `Maximum standalone MCP limit reached (${config.maxStandaloneMcps}). ` +
                    `Stop an MCP with bhived_stop_mcp before spawning another.`
                );
            }
        }

        // Enforce total child process limit
        if (this.children.size >= config.maxChildProcesses && !this.children.has(name)) {
            throw new Error(
                `Maximum total child process limit reached (${config.maxChildProcesses}). ` +
                `Stop an MCP to free resources.`
            );
        }

        this.children.set(name, entry);
    }

    /** Get a child MCP entry by name. */
    get(name: string): ChildMcpEntry | undefined {
        return this.children.get(name);
    }

    /** Remove a child MCP by name. Returns true if it existed. */
    remove(name: string): boolean {
        return this.children.delete(name);
    }

    /** List all child MCP entries. */
    list(): ChildMcpEntry[] {
        return Array.from(this.children.values());
    }

    /** Check if a child MCP is registered. */
    has(name: string): boolean {
        return this.children.has(name);
    }

    /** Current number of child MCPs. */
    count(): number {
        return this.children.size;
    }

    /** List child MCPs filtered by source. */
    listBySource(source: "standalone" | string): ChildMcpEntry[] {
        return Array.from(this.children.values()).filter((entry) =>
            source === "standalone"
                ? entry.source === "standalone"
                : entry.source === source
        );
    }

    /** Count child MCPs by source type. */
    countBySource(sourceType: "standalone" | "skill"): number {
        return Array.from(this.children.values()).filter((entry) =>
            sourceType === "standalone"
                ? entry.source === "standalone"
                : entry.source.startsWith("skill:")
        ).length;
    }

    /** Get all entries whose source matches a specific skill name. */
    listBySkill(skillName: string): ChildMcpEntry[] {
        return this.listBySource(`skill:${skillName}`);
    }

    /** Get all registered child MCP names. */
    names(): string[] {
        return Array.from(this.children.keys());
    }
}

/** Singleton child MCP registry instance */
export const childMcpRegistry = new ChildMcpRegistry();
