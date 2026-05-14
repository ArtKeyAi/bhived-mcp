import { constants } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { parseDocument, type ParsedNode } from "yaml";
import { SERVER_NAME, stdioCommand, type AgentId, type TargetPlatform } from "./agentConfigs.js";

export interface InstallResult {
  agentId: AgentId;
  label: string;
  status: "installed" | "skipped";
  path?: string;
  message: string;
}

export interface AgentDetectionResult {
  agentId: AgentId;
  label: string;
  installed: boolean;
  reason: string;
}

const JSON_FORMAT_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
};

export async function installAgentConfig(agentId: AgentId, platform: TargetPlatform): Promise<InstallResult> {
  switch (agentId) {
    case "claude-code":
      return installJsonServer(agentId, "Claude Code", claudeCodePath(), ["mcpServers", SERVER_NAME], stdioConfig());
    case "claude-desktop":
      if (platform === "linux") {
        return skipped(agentId, "Claude Desktop", "local MCP config is officially documented for macOS and Windows.");
      }
      return installJsonServer(agentId, "Claude Desktop", claudeDesktopPath(platform), ["mcpServers", SERVER_NAME], stdioConfig());
    case "cursor":
      return installJsonServer(agentId, "Cursor", join(homedir(), ".cursor", "mcp.json"), ["mcpServers", SERVER_NAME], stdioConfig());
    case "vscode":
      return installJsonServer(agentId, "VS Code / GitHub Copilot", vscodeUserMcpPath(platform), ["servers", SERVER_NAME], {
        type: "stdio",
        ...stdioConfig(),
      });
    case "windsurf":
      return installJsonServer(agentId, "Windsurf", join(homedir(), ".codeium", "windsurf", "mcp_config.json"), ["mcpServers", SERVER_NAME], stdioConfig());
    case "cline":
      return installJsonServer(agentId, "Cline", clinePath(platform), ["mcpServers", SERVER_NAME], {
        ...stdioConfig(),
        disabled: false,
        alwaysAllow: [],
      });
    case "gemini":
      return installJsonServer(agentId, "Gemini CLI", join(homedir(), ".gemini", "settings.json"), ["mcpServers", SERVER_NAME], stdioConfig());
    case "opencode":
      return installJsonServer(agentId, "OpenCode", opencodeGlobalPath(platform), ["mcp", SERVER_NAME], {
        type: "local",
        command: [stdioCommand().command, ...stdioCommand().args],
        enabled: true,
      });
    case "codex":
      return installCodex(platform);
    case "antigravity":
      return installJsonServer(agentId, "Google Antigravity", join(homedir(), ".gemini", "antigravity", "mcp_config.json"), ["mcpServers", SERVER_NAME], stdioConfig());
    case "openclaw":
      return installJsonServer(agentId, "OpenClaw", join(homedir(), ".openclaw", "openclaw.json"), ["mcp", "servers", SERVER_NAME], stdioConfig());
    case "roo-code":
      return installJsonServer(agentId, "Roo Code", rooCodePath(platform), ["mcpServers", SERVER_NAME], {
        ...stdioConfig(),
        disabled: false,
        alwaysAllow: [],
      });
    case "continue":
      return installContinue();
    case "zed":
      return installJsonServer(agentId, "Zed", zedSettingsPath(platform), ["context_servers", SERVER_NAME], {
        ...stdioConfig(),
        env: {},
      });
  }
}

export async function detectAgentInstall(agentId: AgentId, platform: TargetPlatform): Promise<AgentDetectionResult> {
  const { label, paths } = detectionCandidates(agentId, platform);

  for (const path of paths) {
    if (await pathExists(path)) {
      return { agentId, label, installed: true, reason: path };
    }
  }

  return { agentId, label, installed: false, reason: paths.join(", ") };
}

async function installJsonServer(
  agentId: AgentId,
  label: string,
  path: string,
  jsonPath: Array<string>,
  value: Record<string, unknown>
): Promise<InstallResult> {
  const original = await readTextIfExists(path);
  const source = original.trim() ? original : "{}\n";
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false });

  if (errors.length > 0 || !isPlainObject(parsed)) {
    return skipped(agentId, label, `existing config is not valid JSON/JSONC: ${path}`);
  }

  const edits = modify(source, jsonPath, value, {
    formattingOptions: JSON_FORMAT_OPTIONS,
  });
  const next = ensureTrailingNewline(applyEdits(source, edits));

  await writeText(path, next);
  return { agentId, label, status: "installed", path, message: path };
}

async function installCodex(platform: TargetPlatform): Promise<InstallResult> {
  const path = join(homedir(), ".codex", "config.toml");
  const original = await readTextIfExists(path);
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "${stdioCommand().command}"`,
    `args = ["${stdioCommand().args.join('", "')}"]`,
    "startup_timeout_sec = 40",
  ].join("\n");
  const pattern = new RegExp(`(^|\\n)\\[mcp_servers\\.${escapeRegExp(SERVER_NAME)}\\][\\s\\S]*?(?=\\n\\[[^\\n]+\\]|$)`);
  const next = pattern.test(original)
    ? original.replace(pattern, `${original.startsWith(`[mcp_servers.${SERVER_NAME}]`) ? "" : "\n"}${block}`)
    : `${original.trimEnd()}${original.trim() ? "\n\n" : ""}${block}\n`;

  await writeText(path, ensureTrailingNewline(next));
  return {
    agentId: "codex",
    label: "OpenAI Codex CLI",
    status: "installed",
    path,
    message: path,
  };
}

async function installContinue(): Promise<InstallResult> {
  const path = join(homedir(), ".continue", "config.yaml");
  const original = await readTextIfExists(path);
  const source = original.trim()
    ? original
    : "name: Bhived Continue Config\nversion: 1.0.0\nschema: v1\n";
  const document = parseDocument(source);

  if (document.errors.length > 0) {
    return skipped("continue", "Continue", `existing config is not valid YAML: ${path}`);
  }

  const config = document.toJS() as Record<string, unknown> | null;
  if (!isPlainObject(config)) {
    return skipped("continue", "Continue", `existing config must be a YAML object: ${path}`);
  }

  const existingServers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
  config.mcpServers = [
    ...existingServers.filter((server) => !isPlainObject(server) || server.name !== SERVER_NAME),
    {
      name: SERVER_NAME,
      type: "stdio",
      ...stdioConfig(),
    },
  ];

  document.contents = document.createNode(config) as ParsedNode;
  await writeText(path, ensureTrailingNewline(document.toString({ lineWidth: 0 })));
  return { agentId: "continue", label: "Continue", status: "installed", path, message: path };
}

function stdioConfig(): Record<string, unknown> {
  return { ...stdioCommand() };
}

function claudeCodePath(): string {
  return join(homedir(), ".claude.json");
}

function claudeDesktopPath(platform: TargetPlatform): string {
  if (platform === "windows") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

function clinePath(platform: TargetPlatform): string {
  if (platform === "windows") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
  }

  if (platform === "macos") {
    return join(homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
  }

  return join(homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
}

function vscodeUserMcpPath(platform: TargetPlatform): string {
  if (platform === "windows") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User", "mcp.json");
  if (platform === "macos") return join(homedir(), "Library", "Application Support", "Code", "User", "mcp.json");
  return join(homedir(), ".config", "Code", "User", "mcp.json");
}

function opencodeGlobalPath(platform: TargetPlatform): string {
  if (platform === "windows") return join(homedir(), ".config", "opencode", "opencode.json");
  return join(homedir(), ".config", "opencode", "opencode.json");
}

function rooCodePath(platform: TargetPlatform): string {
  if (platform === "windows") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json");
  }

  if (platform === "macos") {
    return join(homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json");
  }

  return join(homedir(), ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json");
}

function zedSettingsPath(platform: TargetPlatform): string {
  if (platform === "windows") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Zed", "settings.json");
  return join(homedir(), ".config", "zed", "settings.json");
}

function detectionCandidates(agentId: AgentId, platform: TargetPlatform): { label: string; paths: string[] } {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const macApps = join(homedir(), "Applications");

  switch (agentId) {
    case "claude-code":
      return { label: "Claude Code", paths: [claudeCodePath(), executablePath(platform, "claude")] };
    case "claude-desktop":
      return {
        label: "Claude Desktop",
        paths: platform === "windows"
          ? [join(appData, "Claude"), join(localAppData, "AnthropicClaude")]
          : [join(homedir(), "Library", "Application Support", "Claude"), "/Applications/Claude.app", join(macApps, "Claude.app")],
      };
    case "cursor":
      return {
        label: "Cursor",
        paths: platform === "windows"
          ? [join(homedir(), ".cursor"), join(localAppData, "Programs", "cursor"), join(localAppData, "Cursor")]
          : [join(homedir(), ".cursor"), "/Applications/Cursor.app", join(macApps, "Cursor.app")],
      };
    case "vscode":
      return {
        label: "VS Code / GitHub Copilot",
        paths: platform === "windows"
          ? [join(appData, "Code", "User"), join(localAppData, "Programs", "Microsoft VS Code")]
          : [join(homedir(), "Library", "Application Support", "Code", "User"), join(homedir(), ".config", "Code", "User"), "/Applications/Visual Studio Code.app", join(macApps, "Visual Studio Code.app")],
      };
    case "windsurf":
      return {
        label: "Windsurf",
        paths: platform === "windows"
          ? [join(homedir(), ".codeium", "windsurf"), join(localAppData, "Programs", "Windsurf")]
          : [join(homedir(), ".codeium", "windsurf"), "/Applications/Windsurf.app", join(macApps, "Windsurf.app")],
      };
    case "cline":
      return { label: "Cline", paths: [clinePath(platform), join(vscodeGlobalStoragePath(platform), "saoudrizwan.claude-dev")] };
    case "gemini":
      return { label: "Gemini CLI", paths: [join(homedir(), ".gemini"), executablePath(platform, "gemini")] };
    case "opencode":
      return { label: "OpenCode", paths: [opencodeGlobalPath(platform), join(homedir(), ".config", "opencode"), executablePath(platform, "opencode")] };
    case "codex":
      return { label: "OpenAI Codex CLI", paths: [join(homedir(), ".codex"), executablePath(platform, "codex")] };
    case "antigravity":
      return {
        label: "Google Antigravity",
        paths: platform === "windows"
          ? [join(homedir(), ".gemini", "antigravity"), join(localAppData, "Programs", "Antigravity")]
          : [join(homedir(), ".gemini", "antigravity"), "/Applications/Antigravity.app", join(macApps, "Antigravity.app")],
      };
    case "openclaw":
      return { label: "OpenClaw", paths: [join(homedir(), ".openclaw"), executablePath(platform, "openclaw")] };
    case "roo-code":
      return { label: "Roo Code", paths: [rooCodePath(platform), join(vscodeGlobalStoragePath(platform), "rooveterinaryinc.roo-cline")] };
    case "continue":
      return { label: "Continue", paths: [join(homedir(), ".continue"), join(vscodeGlobalStoragePath(platform), "continue.continue")] };
    case "zed":
      return {
        label: "Zed",
        paths: platform === "windows"
          ? [join(appData, "Zed"), join(localAppData, "Zed")]
          : [join(homedir(), ".config", "zed"), "/Applications/Zed.app", join(macApps, "Zed.app")],
      };
  }
}

function vscodeGlobalStoragePath(platform: TargetPlatform): string {
  if (platform === "windows") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User", "globalStorage");
  if (platform === "macos") return join(homedir(), "Library", "Application Support", "Code", "User", "globalStorage");
  return join(homedir(), ".config", "Code", "User", "globalStorage");
}

function executablePath(platform: TargetPlatform, name: string): string {
  const suffix = platform === "windows" ? ".cmd" : "";
  return join(homedir(), ".npm-global", "bin", `${name}${suffix}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf-8", mode: constants.S_IRUSR | constants.S_IWUSR });
}

function skipped(agentId: AgentId, label: string, message: string): InstallResult {
  return { agentId, label, status: "skipped", message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
