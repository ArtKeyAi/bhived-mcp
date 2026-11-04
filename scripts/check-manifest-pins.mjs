/**
 * Manifest pin guard (runs from root `prepublishOnly`).
 *
 * Plugin catalogs (Hermes, the Claude plugin directory) reject a floating
 * `bhived-mcp@latest` launcher, so the plugin manifests pin the exact version.
 * This fails the publish if any manifest still points at an older version.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expected = `bhived-mcp@${version}`;

const files = [
    "mcp.json",
    ".claude-plugin/plugin.json",
    "gemini-extension.json",
    "plugin.json",
    "plugins/bhived/.claude-plugin/plugin.json",
    "skills/bhived/SKILL.md",
    "plugins/bhived/skills/bhived/SKILL.md",
    "plugins/bhived/README.md",
];
const problems = [];

for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    const pins = text.match(/bhived-mcp@[\w.-]+/g) ?? [];
    for (const pin of pins) {
        if (pin !== expected) problems.push(`${file}: found "${pin}", expected "${expected}"`);
    }
    if (!file.endsWith(".json")) continue;
    const manifestVersion = JSON.parse(text).version;
    if (manifestVersion && manifestVersion !== version) {
        problems.push(`${file}: "version" is ${manifestVersion}, expected ${version}`);
    }
}

// The Claude Code plugin folder carries its own copy of the skill; keep them identical.
const skill = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
if (skill("skills/bhived/SKILL.md") !== skill("plugins/bhived/skills/bhived/SKILL.md")) {
    problems.push("plugins/bhived/skills/bhived/SKILL.md differs from skills/bhived/SKILL.md; copy it over");
}

if (problems.length) {
    console.error("[check-manifest-pins] plugin manifests are out of date:\n  " + problems.join("\n  "));
    process.exit(1);
}

console.log(`[check-manifest-pins] ok — manifests pin ${expected}.`);
