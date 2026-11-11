# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately instead: open the **Security** tab of this repository and click **Report a vulnerability**. Only the maintainers can see the report.

Useful things to include:

- what you found and where (file, tool name, or command)
- steps to reproduce it
- the `bhived-mcp` version you used (it's in your MCP config, or run `npm view bhived-mcp version` for the latest)

We'll confirm we got the report, keep you posted while we work on a fix, and credit you in the release notes if you'd like.

## Supported versions

Fixes go into the latest release of [`bhived-mcp` on npm](https://www.npmjs.com/package/bhived-mcp). If you can, check that the problem still happens on the latest version before reporting it.

## Scope

This covers the code in this repository: the `bhived-mcp` server and the plugin bundles under `plugins/`. Problems with the hosted service behind it can be reported the same way.

Please don't put API keys, other secrets or private code in a report. If you need to show one, use a placeholder.
