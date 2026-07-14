import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredBhivedConfig {
  apiUrl: string;
  apiKey: string;
  user?: {
    email?: string;
  };
  /** Plan recorded at sign-in: "team", "pro", or "free". */
  plan?: string;
  /** Present only for team-provisioned keys; lets the MCP confirm team scope. */
  team?: {
    id: string;
    name?: string;
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
      plan: parsed.plan,
      team: parsed.team,
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

/**
 * Persist a live-verified plan (GET /v1/subscription) onto the stored config
 * so offline consumers — the MCP's tenancy banner, quiet instruction refresh —
 * see the key's current scope. Mutates ONLY `plan` (and drops stale `team`
 * metadata when the key is no longer team-provisioned): every other field —
 * including ones this CLI version doesn't know about — is preserved verbatim,
 * and the write goes through a temp-file rename so a crash can't truncate the
 * credentials file. Returns true when the file changed.
 */
export async function updateStoredPlan(plan: "free" | "pro" | "team"): Promise<boolean> {
  const path = getConfigPath();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  if (!parsed.apiKey || !parsed.apiUrl) return false;

  const planUnchanged = parsed.plan === plan;
  const teamUnchanged = plan === "team" || parsed.team === undefined;
  if (planUnchanged && teamUnchanged) return false;

  parsed.plan = plan;
  if (plan !== "team") delete parsed.team;

  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(parsed, null, 2), {
    encoding: "utf-8",
    mode: constants.S_IRUSR | constants.S_IWUSR,
  });
  await rename(tmpPath, path);
  return true;
}

export async function deleteStoredConfig(): Promise<void> {
  await rm(getConfigPath(), { force: true });
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return "****";
  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}
