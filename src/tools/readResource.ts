/**
 * bhived_read_resource Tool
 *
 * Reads a resource (script, reference doc, or asset) from an active skill.
 * Resources are registered in the ResourceRegistry when a skill is activated.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { skillRegistry } from "../registries/skillRegistry.js";
import { resourceRegistry, ResourceRegistry } from "../registries/resourceRegistry.js";

const ReadResourceInputSchema = z.object({
    skill: z
        .string()
        .min(1)
        .describe("Name of the activated skill."),
    path: z
        .string()
        .min(1)
        .describe(
            'Resource path (e.g., "references/thinking-hats.md", "assets/template.md", "scripts/analyze.py").'
        ),
}).strict();

type ReadResourceInput = z.infer<typeof ReadResourceInputSchema>;

const READ_RESOURCE_DESCRIPTION = `Read a reference document, asset, or script source from an
activated skill. Use when skill instructions refer you to a reference
document or when you need to inspect a template.

Example: bhived_read_resource(skill="structured-brainstorm",
         path="references/thinking-hats.md")`;

export function registerReadResourceTool(server: McpServer): void {
    server.registerTool(
        "bhived_read_resource",
        {
            title: "Read Skill Resource",
            description: READ_RESOURCE_DESCRIPTION,
            inputSchema: ReadResourceInputSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (params: ReadResourceInput) => {
            try {
                // 1. Verify the skill is active
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

                // 2. Parse path into type/filename
                const pathParts = params.path.split("/");
                if (pathParts.length < 2) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ Invalid path format: '${params.path}'. Expected format: type/filename (e.g., "references/doc.md", "scripts/run.py", "assets/template.md").`,
                            },
                        ],
                        isError: true,
                    };
                }

                const resourceType = pathParts[0];
                const filename = pathParts.slice(1).join("/");

                // 3. Build URI and look up in registry
                const uri = ResourceRegistry.buildUri(params.skill, resourceType, filename);
                const resource = resourceRegistry.get(uri);

                if (!resource) {
                    // List available resources for this skill to help the agent
                    const available = resourceRegistry.listBySkill(params.skill);
                    const availableList = available.length > 0
                        ? "\n\nAvailable resources:\n" +
                          available.map((r) => `  • ${r.uri.replace(`bhived://skill/${params.skill}/`, "")}`).join("\n")
                        : "\n\nNo resources registered for this skill.";

                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `❌ Resource not found: '${params.path}' in skill '${params.skill}'.${availableList}`,
                            },
                        ],
                        isError: true,
                    };
                }

                // 4. Return the resource content
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `## 📄 ${params.path}\n**Skill**: ${params.skill} · **Type**: ${resource.mimeType}\n\n---\n\n${resource.content}`,
                        },
                    ],
                };
            } catch (error: unknown) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error reading resource: ${error instanceof Error ? error.message : String(error)}`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );
}
