# Bhived CLI

Open-source setup CLI for installing the Bhived MCP server into supported AI agents and MCP clients.

## Usage

Run setup once:

```bash
npx bhived setup
```

The CLI will:

1. Open browser authentication for Bhived.
2. Save local credentials to `~/.bhived/config.json`.
3. Detect supported installed agents.
4. Add or replace only the `bhived` MCP server entry.
5. Preserve your existing MCP servers.
6. Keep API keys out of agent configuration files.

Restart your configured agent after setup.

## Commands

```bash
npx bhived setup
npx bhived status
npx bhived logout
```

## Relationship To `bhived-mcp`

`bhived` is the setup helper. It configures agents to run the actual MCP server package:

```bash
npx -y bhived-mcp@latest
```

Use `npx bhived setup` for automatic installation. Use `npx -y bhived-mcp@latest` directly only when manually configuring an MCP client.

## License

Apache-2.0. See the repository license: https://github.com/ArtKeyAi/bhived-mcp/blob/main/LICENSE
