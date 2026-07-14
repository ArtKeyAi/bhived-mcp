/**
 * Publish-order guard (runs from root `prepublishOnly`).
 *
 * bhived-mcp depends on the workspace `bhived` package. Publishing bhived-mcp
 * BEFORE the matching bhived version exists on the registry would leave every
 * fresh `npx bhived-mcp` install broken with
 * "notarget No matching version found for bhived@^x.y.z".
 * This script fails the publish until `npm publish --workspace bhived` has run.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cliPkg = JSON.parse(readFileSync(join(root, "packages", "bhived", "package.json"), "utf8"));
const range = rootPkg.dependencies?.bhived;

if (!range) {
    console.log("[check-publish-order] no bhived dependency — nothing to check.");
    process.exit(0);
}

let published = [];
try {
    const raw = execFileSync("npm", ["view", "bhived", "versions", "--json"], {
        encoding: "utf8",
        shell: process.platform === "win32",
    });
    const parsed = JSON.parse(raw);
    published = Array.isArray(parsed) ? parsed : [parsed];
} catch (error) {
    console.error("[check-publish-order] could not query the npm registry:", error?.message ?? error);
    console.error("Refusing to publish without confirming bhived@" + range + " is resolvable.");
    process.exit(1);
}

if (!published.includes(cliPkg.version)) {
    console.error(
        `[check-publish-order] bhived-mcp depends on "bhived": "${range}" (workspace version ${cliPkg.version}), ` +
        `but the registry only has: ${published.join(", ")}.\n` +
        "Publish the CLI first: npm publish --workspace bhived"
    );
    process.exit(1);
}

console.log(`[check-publish-order] ok — bhived@${cliPkg.version} is on the registry.`);
