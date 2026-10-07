// Minimal stdio MCP server for tests: reports which test variables it received.
// With ECHO_PID_LOG set, appends its PID there so tests can count launches.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

if (process.env.ECHO_PID_LOG) appendFileSync(process.env.ECHO_PID_LOG, `${process.pid}\n`);

const server = new McpServer({ name: "env-echo", version: "1.0.0" });
server.registerTool("read_env", { description: "Return the test variables visible to this process." }, async () => ({
    content: [{
        type: "text",
        text: JSON.stringify({
            required: process.env.TEST_REQUIRED_KEY ?? null,
            fromFile: process.env.TEST_FILE_KEY ?? null,
            defaulted: process.env.TEST_DEFAULTED ?? null,
            unrelated: process.env.TEST_UNRELATED_SECRET ?? null,
            hasPath: Boolean(process.env.PATH ?? process.env.Path),
        }),
    }],
}));
await server.connect(new StdioServerTransport());
