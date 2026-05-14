/**
 * Registries — barrel export
 *
 * Re-exports singletons and types from all three registries.
 */

export { SkillRegistry, skillRegistry } from "./skillRegistry.js";
export type { SkillEntry } from "./skillRegistry.js";

export { ChildMcpRegistry, childMcpRegistry } from "./childMcpRegistry.js";
export type { ChildMcpEntry, ChildMcpTool } from "./childMcpRegistry.js";

export { ResourceRegistry, resourceRegistry } from "./resourceRegistry.js";
export type { ResourceEntry } from "./resourceRegistry.js";
