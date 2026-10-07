/** Materialize the resource layout exposed by skill activation for one script run. */
import { lstat, mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import type { SkillEntry } from "../registries/skillRegistry.js";

const TEMP_PREFIX = "bhived-script-";

export interface ScriptBundle {
    root: string;
    scriptPath: string;
    cleanup: () => Promise<void>;
}

function resourcePath(key: string): string {
    const path = key.replace(/\\/g, "/");
    const parts = path.split("/");
    // Validate Windows paths even on Unix. This also prevents ADS/device aliases
    // when a catalog assembled on Unix is later used by a Windows client.
    if (!path || isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path)
        || parts.some((part) => !part || part === "." || part === ".."
            || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
            || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
        throw new Error(`Unsafe skill resource path: ${JSON.stringify(key)}`);
    }
    return parts.join("/");
}

function containedPath(root: string, path: string): string {
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        || isAbsolute(rel)) {
        throw new Error(`Skill resource escapes its temporary directory: ${path}`);
    }
    return target;
}

export async function materializeSkillBundle(skill: SkillEntry, script: string): Promise<ScriptBundle> {
    if (!Object.prototype.hasOwnProperty.call(skill.scripts, script)) {
        throw new Error(`Script not registered: ${script}`);
    }
    const selected = `scripts/${resourcePath(script)}`;
    const files: Array<[string, string]> = [["SKILL.md", skill.skill_md]];
    for (const [group, mapping] of Object.entries({
        scripts: skill.scripts, references: skill.references, assets: skill.assets,
    })) {
        for (const [key, content] of Object.entries(mapping)) {
            files.push([`${group}/${resourcePath(key)}`, content]);
        }
    }

    // Validate the whole bundle before creating files or executing anything.
    // Case aliases are rejected on every OS so bundles behave consistently.
    const paths = new Set<string>();
    for (const [path, content] of files) {
        const canonical = path.toLowerCase();
        if (typeof content !== "string") throw new Error(`Non-text skill resource: ${path}`);
        if (paths.has(canonical)) throw new Error(`Conflicting skill resource path: ${path}`);
        paths.add(canonical);
    }
    for (const path of paths) {
        const parts = path.split("/");
        while (parts.length > 1) {
            parts.pop();
            if (paths.has(parts.join("/"))) throw new Error(`File/directory conflict: ${path}`);
        }
    }

    const parent = await realpath(tmpdir());
    const root = await mkdtemp(join(parent, TEMP_PREFIX));
    const cleanup = async () => {
        // Delete only the exact directory we created. If a script replaces it
        // with a symlink/junction, unlink that link, never its target.
        if (dirname(root) !== parent || !basename(root).startsWith(TEMP_PREFIX)) {
            throw new Error("Refusing to clean an unowned skill directory");
        }
        let stat;
        try {
            stat = await lstat(root);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        if (stat.isSymbolicLink()) {
            await unlink(root);
        } else {
            if (await realpath(root) !== root) throw new Error("Skill directory location changed");
            await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    };
    try {
        for (const [path, content] of files) {
            const target = containedPath(root, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, content, { encoding: "utf8", flag: "wx" });
        }
        return { root, scriptPath: containedPath(root, selected), cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
