/**
 * Resource Registry
 *
 * In-memory registry mapping `bhived://` URIs to content.
 * Resources are registered when skills are activated and removed
 * when skills are deactivated.
 *
 * URI format: bhived://skill/{name}/{type}/{filename}
 *   where type = scripts | references | assets
 */

export interface ResourceEntry {
    /** The raw content of the resource */
    content: string;
    /** MIME type of the resource (e.g., text/plain, application/javascript) */
    mimeType: string;
    /** The skill this resource belongs to */
    source_skill: string;
}

export class ResourceRegistry {
    private readonly resources = new Map<string, ResourceEntry>();

    /** Build a standard bhived:// URI for a skill resource. */
    static buildUri(skillName: string, type: string, filename: string): string {
        return `bhived://skill/${skillName}/${type}/${filename}`;
    }

    /** Infer MIME type from filename extension. */
    static inferMimeType(filename: string): string {
        const ext = filename.split(".").pop()?.toLowerCase();
        switch (ext) {
            case "py":
                return "text/x-python";
            case "js":
                return "application/javascript";
            case "ts":
                return "application/typescript";
            case "sh":
                return "application/x-sh";
            case "md":
                return "text/markdown";
            case "json":
                return "application/json";
            case "yaml":
            case "yml":
                return "text/yaml";
            case "txt":
                return "text/plain";
            case "html":
                return "text/html";
            case "css":
                return "text/css";
            default:
                return "text/plain";
        }
    }

    /** Register a resource under its URI. */
    add(uri: string, entry: ResourceEntry): void {
        this.resources.set(uri, entry);
    }

    /** Get a resource entry by URI. */
    get(uri: string): ResourceEntry | undefined {
        return this.resources.get(uri);
    }

    /** Remove a resource by URI. Returns true if it existed. */
    remove(uri: string): boolean {
        return this.resources.delete(uri);
    }

    /** Remove all resources belonging to a specific skill. */
    removeBySkill(skillName: string): number {
        let removed = 0;
        for (const [uri, entry] of this.resources.entries()) {
            if (entry.source_skill === skillName) {
                this.resources.delete(uri);
                removed++;
            }
        }
        return removed;
    }

    /** List all resource entries. */
    list(): Array<{ uri: string } & ResourceEntry> {
        return Array.from(this.resources.entries()).map(([uri, entry]) => ({
            uri,
            ...entry,
        }));
    }

    /** List resources belonging to a specific skill. */
    listBySkill(skillName: string): Array<{ uri: string } & ResourceEntry> {
        return this.list().filter((r) => r.source_skill === skillName);
    }

    /** Check if a resource URI exists. */
    has(uri: string): boolean {
        return this.resources.has(uri);
    }

    /** Current number of registered resources. */
    count(): number {
        return this.resources.size;
    }
}

/** Singleton resource registry instance */
export const resourceRegistry = new ResourceRegistry();
