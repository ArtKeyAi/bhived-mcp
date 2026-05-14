export type TargetPlatform = "windows" | "macos" | "linux";

export interface AgentConfigInfo {
  id: string;
  label: string;
  docs: string;
  notes: string[];
  configPaths: Record<TargetPlatform, string[]>;
  content: string;
}

export interface StdioServerConfig {
  command: string;
  args: string[];
}

export const SERVER_NAME = "bhived";
const MCP_PACKAGE = "bhived-mcp@latest";

export const AGENT_IDS = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "vscode",
  "windsurf",
  "cline",
  "gemini",
  "opencode",
  "codex",
  "antigravity",
  "openclaw",
  "roo-code",
  "continue",
  "zed",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export function detectPlatform(): TargetPlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export function getAgentConfig(agentId: AgentId, platform: TargetPlatform): AgentConfigInfo {
  switch (agentId) {
    case "claude-code":
      return claudeCode(platform);
    case "claude-desktop":
      return claudeDesktop(platform);
    case "cursor":
      return cursor(platform);
    case "vscode":
      return vscode(platform);
    case "windsurf":
      return windsurf(platform);
    case "cline":
      return cline(platform);
    case "gemini":
      return gemini(platform);
    case "opencode":
      return opencode(platform);
    case "codex":
      return codex(platform);
    case "antigravity":
      return antigravity(platform);
    case "openclaw":
      return openclaw(platform);
    case "roo-code":
      return rooCode(platform);
    case "continue":
      return continueDev(platform);
    case "zed":
      return zed(platform);
  }
}

export function getSelectedAgentIds(flags: Set<string>): AgentId[] {
  const selected = AGENT_IDS.filter((id) => flags.has(id));
  return flags.has("all") || selected.length === 0 ? [...AGENT_IDS] : selected;
}

export function parsePlatform(flags: Map<string, string | boolean>): TargetPlatform {
  const value = flags.get("platform");
  if (value === "windows" || value === "macos" || value === "linux") return value;
  if (value && value !== true) {
    throw new Error("--platform must be one of: windows, macos, linux");
  }
  return detectPlatform();
}

export function parseFlags(args: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;

    const raw = arg.slice(2);
    const eqIndex = raw.indexOf("=");
    if (eqIndex !== -1) {
      flags.set(raw.slice(0, eqIndex), raw.slice(eqIndex + 1));
      continue;
    }

    const next = args[i + 1];
    if (raw === "platform" && next && !next.startsWith("--")) {
      flags.set(raw, next);
      i++;
      continue;
    }

    flags.set(raw, true);
  }

  return flags;
}

export function stdioCommand(): StdioServerConfig {
  return { command: "npx", args: ["-y", MCP_PACKAGE] };
}

function opencodeCommand(): string[] {
  const command = stdioCommand();
  return [command.command, ...command.args];
}

function genericMcpServersJson(): string {
  const command = stdioCommand();
  return json({
    mcpServers: {
      [SERVER_NAME]: {
        command: command.command,
        args: command.args,
      },
    },
  });
}

function claudeCode(_platform: TargetPlatform): AgentConfigInfo {
  return {
    id: "claude-code",
    label: "Claude Code",
    docs: "https://docs.anthropic.com/en/docs/claude-code/mcp",
    notes: [
      "Current docs use `claude mcp add [options] <name> -- <command> [args...]` for local stdio servers.",
      "Use `--scope user` to make Bhived available across all projects.",
    ],
    configPaths: {
      windows: ["%USERPROFILE%\\.claude.json"],
      macos: ["~/.claude.json"],
      linux: ["~/.claude.json"],
    },
    content: "claude mcp add --transport stdio --scope user bhived -- npx -y bhived-mcp@latest",
  };
}

function claudeDesktop(_platform: TargetPlatform): AgentConfigInfo {
  return {
    id: "claude-desktop",
    label: "Claude Desktop",
    docs: "https://modelcontextprotocol.io/quickstart/user",
    notes: [
      "Claude Desktop uses `mcpServers` with `command` and `args` for local stdio servers.",
      "Restart Claude Desktop after editing the config.",
    ],
    configPaths: {
      windows: ["%APPDATA%\\Claude\\claude_desktop_config.json"],
      macos: ["~/Library/Application Support/Claude/claude_desktop_config.json"],
      linux: ["Claude Desktop local MCP support is primarily documented for macOS and Windows."],
    },
    content: genericMcpServersJson(),
  };
}

function cursor(_platform: TargetPlatform): AgentConfigInfo {
  return {
    id: "cursor",
    label: "Cursor",
    docs: "https://docs.cursor.com/context/model-context-protocol",
    notes: [
      "Cursor uses `mcpServers` with `command` and `args` for local stdio servers.",
      "Use global config for all projects, or project config for one repository.",
    ],
    configPaths: {
      windows: ["%USERPROFILE%\\.cursor\\mcp.json", ".cursor\\mcp.json"],
      macos: ["~/.cursor/mcp.json", ".cursor/mcp.json"],
      linux: ["~/.cursor/mcp.json", ".cursor/mcp.json"],
    },
    content: genericMcpServersJson(),
  };
}

function vscode(_platform: TargetPlatform): AgentConfigInfo {
  const command = stdioCommand();
  return {
    id: "vscode",
    label: "VS Code / GitHub Copilot",
    docs: "https://code.visualstudio.com/docs/copilot/chat/mcp-servers",
    notes: [
      "Current VS Code docs use a top-level `servers` object, not `mcpServers`.",
      "Bhived installs to the user-profile MCP config so it is available across workspaces.",
    ],
    configPaths: {
      windows: ["%APPDATA%\\Code\\User\\mcp.json"],
      macos: ["~/Library/Application Support/Code/User/mcp.json"],
      linux: ["~/.config/Code/User/mcp.json"],
    },
    content: json({
      servers: {
        [SERVER_NAME]: {
          type: "stdio",
          command: command.command,
          args: command.args,
        },
      },
    }),
  };
}

function windsurf(_platform: TargetPlatform): AgentConfigInfo {
  return {
    id: "windsurf",
    label: "Windsurf",
    docs: "https://docs.windsurf.com/windsurf/cascade/mcp",
    notes: [
      "Windsurf uses `mcpServers` in `mcp_config.json` for local stdio servers.",
      "Windsurf supports `command`, `args`, `env`, `serverUrl`, `url`, and `headers` interpolation.",
    ],
    configPaths: {
      windows: ["%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json"],
      macos: ["~/.codeium/windsurf/mcp_config.json"],
      linux: ["~/.codeium/windsurf/mcp_config.json"],
    },
    content: genericMcpServersJson(),
  };
}

function cline(_platform: TargetPlatform): AgentConfigInfo {
  const command = stdioCommand();
  return {
    id: "cline",
    label: "Cline",
    docs: "https://docs.cline.bot/mcp/configuring-mcp-servers",
    notes: [
      "Cline uses `cline_mcp_settings.json` with `mcpServers` for local stdio servers.",
      "The docs include optional `alwaysAllow` and `disabled` fields.",
    ],
    configPaths: {
      windows: ["%APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json"],
      macos: ["~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"],
      linux: ["~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"],
    },
    content: json({
      mcpServers: {
        [SERVER_NAME]: {
          command: command.command,
          args: command.args,
          disabled: false,
          alwaysAllow: [],
        },
      },
    }),
  };
}

function gemini(_platform: TargetPlatform): AgentConfigInfo {
  const command = stdioCommand();

  return {
    id: "gemini",
    label: "Gemini CLI",
    docs: "https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md",
    notes: [
      "Gemini CLI uses `mcpServers` in `~/.gemini/settings.json` for manual setup.",
      "Current docs also support `gemini mcp add [options] <name> <command> [args...]`.",
      "Avoid underscores in MCP server names for Gemini CLI; `bhived` is safe.",
    ],
    configPaths: {
      windows: ["%USERPROFILE%\\.gemini\\settings.json", ".gemini\\settings.json"],
      macos: ["~/.gemini/settings.json", ".gemini/settings.json"],
      linux: ["~/.gemini/settings.json", ".gemini/settings.json"],
    },
    content: `gemini mcp add --scope user bhived npx -y bhived-mcp@latest\n\nManual config:\n${json({
      mcpServers: {
        [SERVER_NAME]: {
          command: command.command,
          args: command.args,
        },
      },
    })}`,
  };
}

function opencode(_platform: TargetPlatform): AgentConfigInfo {
  return {
    id: "opencode",
    label: "OpenCode",
    docs: "https://opencode.ai/docs/mcp-servers",
    notes: [
      "OpenCode uses a top-level `mcp` object.",
      "Local MCP servers require `type: local` and `command` as an array.",
      "Bhived installs to OpenCode's global config so it is available across projects.",
    ],
    configPaths: {
      windows: ["%USERPROFILE%\\.config\\opencode\\opencode.json"],
      macos: ["~/.config/opencode/opencode.json"],
      linux: ["~/.config/opencode/opencode.json"],
    },
    content: json({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [SERVER_NAME]: {
          type: "local",
          command: opencodeCommand(),
          enabled: true,
        },
      },
    }),
  };
}

function codex(_platform: TargetPlatform): AgentConfigInfo {
  const command = stdioCommand();
  return {
    id: "codex",
    label: "OpenAI Codex CLI",
    docs: "https://context7.com/docs/resources/all-clients#openai-codex",
    notes: [
      "Codex MCP config uses TOML under `[mcp_servers.<name>]`.",
      "Increase `startup_timeout_sec` if first-run npm package download is slow.",
    ],
    configPaths: {
      windows: ["%USERPROFILE%\\.codex\\config.toml", ".codex\\config.toml"],
      macos: ["~/.codex/config.toml", ".codex/config.toml"],
      linux: ["~/.codex/config.toml", ".codex/config.toml"],
    },
    content: [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${tomlString(command.command)}`,
      `args = ${tomlArray(command.args)}`,
      "startup_timeout_sec = 40",
    ].join("\n"),
  };
}

function antigravity(_platform: TargetPlatform): AgentConfigInfo {
  return {
    id: "antigravity",
    label: "Google Antigravity",
    docs: "https://context7.com/docs/resources/all-clients#google-antigravity",
    notes: [
      "Official Antigravity docs use `~/.gemini/antigravity/mcp_config.json` for custom MCP servers.",
      "Antigravity uses `mcpServers` with `command` and `args` for local stdio servers.",
      "Use `serverUrl` for remote Streamable HTTP servers.",
    ],
    configPaths: {
      windows: ["%USERPROFILE%\\.gemini\\antigravity\\mcp_config.json"],
      macos: ["~/.gemini/antigravity/mcp_config.json"],
      linux: ["~/.gemini/antigravity/mcp_config.json"],
    },
    content: genericMcpServersJson(),
  };
}

function openclaw(_platform: TargetPlatform): AgentConfigInfo {
  const command = stdioCommand();
  return {
    id: "openclaw",
    label: "OpenClaw",
    docs: "https://github.com/openclaw/openclaw/blob/main/docs/cli/mcp.md",
    notes: [
      "OpenClaw reads JSON5 config from `$OPENCLAW_CONFIG_PATH`, defaulting to `~/.openclaw/openclaw.json`.",
      "MCP servers are configured under `mcp.servers`.",
      "Owner slash commands can also update server definitions with `/mcp set` when enabled.",
    ],
    configPaths: {
      windows: ["%USERPROFILE%\\.openclaw\\openclaw.json"],
      macos: ["~/.openclaw/openclaw.json"],
      linux: ["~/.openclaw/openclaw.json"],
    },
    content: json({
      mcp: {
        servers: {
          [SERVER_NAME]: {
            command: command.command,
            args: command.args,
          },
        },
      },
    }),
  };
}

function rooCode(_platform: TargetPlatform): AgentConfigInfo {
  const command = stdioCommand();
  return {
    id: "roo-code",
    label: "Roo Code",
    docs: "https://docs.roocode.com/features/mcp/using-mcp-in-roo",
    notes: [
      "Roo Code uses `mcp_settings.json` for global MCP config and `.roo/mcp.json` for project config.",
      "Both files use a top-level `mcpServers` object.",
      "Bhived installs to the VS Code extension global settings directory.",
    ],
    configPaths: {
      windows: ["%APPDATA%\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\settings\\mcp_settings.json"],
      macos: ["~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json"],
      linux: ["~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json"],
    },
    content: json({
      mcpServers: {
        [SERVER_NAME]: {
          command: command.command,
          args: command.args,
          disabled: false,
          alwaysAllow: [],
        },
      },
    }),
  };
}

function continueDev(_platform: TargetPlatform): AgentConfigInfo {
  const command = stdioCommand();
  return {
    id: "continue",
    label: "Continue",
    docs: "https://docs.continue.dev/customize/deep-dives/mcp",
    notes: [
      "Continue's current local config uses YAML and supports an `mcpServers` array.",
      "Bhived installs to the global Continue config at `~/.continue/config.yaml`.",
      "Existing MCP server entries are preserved; only the entry named `bhived` is replaced.",
    ],
    configPaths: {
      windows: ["%USERPROFILE%\\.continue\\config.yaml"],
      macos: ["~/.continue/config.yaml"],
      linux: ["~/.continue/config.yaml"],
    },
    content: [
      "mcpServers:",
      `  - name: ${SERVER_NAME}`,
      "    type: stdio",
      `    command: ${command.command}`,
      "    args:",
      ...command.args.map((arg) => `      - ${JSON.stringify(arg)}`),
    ].join("\n"),
  };
}

function zed(_platform: TargetPlatform): AgentConfigInfo {
  const command = stdioCommand();
  return {
    id: "zed",
    label: "Zed",
    docs: "https://zed.dev/docs/ai/mcp",
    notes: [
      "Zed configures custom MCP servers in user `settings.json` under `context_servers`.",
      "Zed settings use JSONC, so comments and trailing commas are preserved where possible.",
    ],
    configPaths: {
      windows: ["%APPDATA%\\Zed\\settings.json"],
      macos: ["~/.config/zed/settings.json"],
      linux: ["~/.config/zed/settings.json"],
    },
    content: json({
      context_servers: {
        [SERVER_NAME]: {
          command: command.command,
          args: command.args,
          env: {},
        },
      },
    }),
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}
