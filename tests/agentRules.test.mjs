// The "don't store hardware limits" rule must reach agents through every
// channel: the installed global rule block, server instructions, write tool
// descriptions, the guide, and the learn_and_share prompt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bhivedInstructionsBlock } from "../packages/bhived/dist/globalInstructions.js";
import { registerWriteTools } from "../dist/tools/write.js";
import { registerLearnAndSharePrompt } from "../dist/prompts/learnAndShare.js";
import { AGENT_GUIDE } from "../dist/resources/guide.js";

const HARDWARE_RULE = /hardware limits[^\n]*(RAM|VRAM)/i;

test("global rule block forbids hardware-limit lessons for every scope", () => {
    for (const scope of ["team", "personal", "unknown"]) {
        assert.match(bhivedInstructionsBlock("9.9.9", scope), HARDWARE_RULE);
    }
});

test("guide, write tools and learn_and_share prompt carry the rule", async () => {
    assert.match(AGENT_GUIDE, /Your own hardware limits/);

    const server = new McpServer({ name: "rules", version: "1.0.0" });
    registerWriteTools(server);
    registerLearnAndSharePrompt(server);
    const client = new Client({ name: "rules-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        const { tools } = await client.listTools();
        assert.equal(tools.length, 3);
        for (const tool of tools) assert.match(tool.description, /hardware limits/, tool.name);

        const prompt = await client.getPrompt({ name: "learn_and_share", arguments: { task: "x" } });
        assert.match(prompt.messages[0].content.text, HARDWARE_RULE);
    } finally {
        await client.close();
        await server.close();
    }
});
