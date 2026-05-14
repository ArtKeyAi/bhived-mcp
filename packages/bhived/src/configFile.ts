import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredBhivedConfig {
  apiUrl: string;
  apiKey: string;
  user?: {
    email?: string;
  };
  createdAt?: string;
}

export function getConfigPath(): string {
  return join(homedir(), ".bhived", "config.json");
}

export async function readStoredConfig(): Promise<StoredBhivedConfig | null> {
  try {
    const raw = await readFile(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoredBhivedConfig>;

    if (!parsed.apiKey || !parsed.apiUrl) return null;

    return {
      apiUrl: parsed.apiUrl,
      apiKey: parsed.apiKey,
      user: parsed.user,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export async function writeStoredConfig(config: StoredBhivedConfig): Promise<void> {
  const configPath = getConfigPath();
  await mkdir(dirname(configPath), { recursive: true });

  const contents = JSON.stringify(
    {
      ...config,
      createdAt: config.createdAt ?? new Date().toISOString(),
    },
    null,
    2
  );

  await writeFile(configPath, contents, {
    encoding: "utf-8",
    mode: constants.S_IRUSR | constants.S_IWUSR,
  });
}

export async function deleteStoredConfig(): Promise<void> {
  await rm(getConfigPath(), { force: true });
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return "****";
  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}
