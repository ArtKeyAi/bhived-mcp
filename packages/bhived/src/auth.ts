import { hostname } from "node:os";
import open from "open";
import { writeStoredConfig, type StoredBhivedConfig } from "./configFile.js";

export interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type DeviceTokenResponse =
  | { status: "pending" }
  | {
      status: "approved";
      api_key: string;
      api_url?: string;
      user?: { email?: string };
      /** "team" for team-scoped keys, otherwise "pro" | "free". */
      plan?: string;
      /** Present only for team-scoped keys. */
      team?: { id: string; name?: string };
    }
  | { status: "denied" }
  | { status: "expired" };

export interface AuthOptions {
  websiteUrl?: string;
  packageVersion?: string;
}

const DEFAULT_WEBSITE_URL = "https://bhived.ai";
const DEFAULT_API_URL = "https://mcp.bhived.ai";

export async function authenticateWithBrowser(options: AuthOptions = {}): Promise<StoredBhivedConfig> {
  const websiteUrl = normalizeUrl(
    options.websiteUrl ?? process.env.BHIVED_WEBSITE_URL ?? DEFAULT_WEBSITE_URL
  );

  const start = await startDeviceFlow(websiteUrl, options.packageVersion);
  const browserUrl = normalizeVerificationUrl(
    start.verification_uri_complete || start.verification_uri,
    websiteUrl
  );

  console.log("Opening browser to sign in to Bhived...");
  console.log(`If the browser did not open, visit: ${browserUrl}`);
  console.log("");

  await open(browserUrl);

  const approved = await pollForToken(websiteUrl, start);
  const storedConfig: StoredBhivedConfig = {
    apiUrl: approved.api_url ?? DEFAULT_API_URL,
    apiKey: approved.api_key,
    user: approved.user,
    plan: approved.plan,
    team: approved.team,
    createdAt: new Date().toISOString(),
  };

  await writeStoredConfig(storedConfig);
  return storedConfig;
}

async function startDeviceFlow(
  websiteUrl: string,
  packageVersion: string | undefined
): Promise<DeviceStartResponse> {
  const response = await fetch(`${websiteUrl}/api/mcp/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Bhived CLI",
      machine_name: hostname(),
      package_version: packageVersion ?? "unknown",
    }),
  });

  if (!response.ok) {
    throw new Error(`Could not start Bhived auth flow (${response.status}): ${await response.text()}`);
  }

  return (await response.json()) as DeviceStartResponse;
}

async function pollForToken(
  websiteUrl: string,
  start: DeviceStartResponse
): Promise<Extract<DeviceTokenResponse, { status: "approved" }>> {
  const intervalMs = Math.max(1, start.interval || 3) * 1000;
  const deadline = Date.now() + Math.max(60, start.expires_in || 600) * 1000;

  console.log("Waiting for authentication...");

  while (Date.now() < deadline) {
    await delay(intervalMs);

    const response = await fetch(`${websiteUrl}/api/mcp/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code }),
    });

    if (!response.ok) {
      throw new Error(`Auth polling failed (${response.status}): ${await response.text()}`);
    }

    const token = (await response.json()) as DeviceTokenResponse;

    if (token.status === "pending") continue;
    if (token.status === "approved") return token;
    if (token.status === "denied") throw new Error("Bhived CLI authorization was denied.");
    if (token.status === "expired") throw new Error("Bhived CLI authorization expired. Run `npx bhived setup` again.");
  }

  throw new Error("Bhived CLI authorization timed out. Run `npx bhived setup` again.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizeVerificationUrl(url: string, websiteUrl: string): string {
  const parsed = new URL(url);
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    return url;
  }

  const website = new URL(websiteUrl);
  parsed.protocol = website.protocol;
  parsed.hostname = website.hostname;
  parsed.port = website.port;
  return parsed.toString();
}
