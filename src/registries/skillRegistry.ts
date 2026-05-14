/**
 * Skill Registry
 *
 * In-memory registry that tracks active skills, their metadata,
 * scripts, references, assets, and bundled MCP names.
 * Session-scoped — cleared when the MCP server exits.
 */

import { config } from "../config.js";

export interface SkillEntry {
    /** The memory_id from the backend */
    memory_id: string;
    /** Human-readable skill name */
    name: string;
    /** Full SKILL.md content */
    skill_md: string;
    /** filename → content map of executable scripts */
    scripts: Record<string, string>;
    /** filename → content map of reference documents */
    references: Record<string, string>;
    /** filename → content map of asset files */
    assets: Record<string, string>;
    /** Names of child MCPs spawned for this skill */
    mcp_names: string[];
    /** When the skill was activated */
    activated_at: Date;
    /** Current status */
    status: "active" | "error";
}

export class SkillRegistry {
    private readonly skills = new Map<string, SkillEntry>();

    /**
     * Register a new active skill.
     * Starts tracking the skill and keeps the registry count at at most 5 by removing the oldest skill.
     */
    add(entry: SkillEntry): void {
        this.skills.delete(entry.name);
        this.skills.set(entry.name, entry);
        if (this.skills.size > 5) {
            const oldest = this.skills.keys().next().value;
            if (oldest !== undefined) {
                this.skills.delete(oldest);
            }
        }
    }

    /** Get a skill entry by name. */
    get(name: string): SkillEntry | undefined {
        return this.skills.get(name);
    }

    /** Remove a skill by name. Returns true if the skill existed. */
    remove(name: string): boolean {
        return this.skills.delete(name);
    }

    /** List all active skills. */
    list(): SkillEntry[] {
        return Array.from(this.skills.values());
    }

    /** Check if a skill is active. */
    has(name: string): boolean {
        return this.skills.has(name);
    }

    /** Current number of active skills. */
    count(): number {
        return this.skills.size;
    }
}

/** Singleton skill registry instance */
export const skillRegistry = new SkillRegistry();
