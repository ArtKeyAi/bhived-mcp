// Stdio "MCP" that answers initialize with an unsupported protocol version, so
// the client's connect() fails promptly. (A child that just exits mid-handshake
// also fails, but SDK 1.27.1 leaves the 60s request timer running after close.)
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.method === "initialize") {
            process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { protocolVersion: "1900-01-01", capabilities: {}, serverInfo: { name: "bad", version: "0" } },
            }) + "\n");
        }
    }
});
