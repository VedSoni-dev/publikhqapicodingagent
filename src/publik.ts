// publik.ts — publik API as one provider option. Resolution order:
// the user's own key > PUBLIK_API_KEY / PUBLIK_API_BASE_URL env > this app's
// credential file > provision on first launch (after the user accepts
// DISCLOSURE) > the user's own key again if provisioning fails.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_SLUG = "publik-code";
export const APP_VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://publikhq.com/api/v1";
/** Ask for a tier, never a vendor model name. */
export const MODELS = { fast: "publik-fast", balanced: "publik-balanced", smart: "publik-smart" } as const;
/** Show this and get a yes BEFORE provision(). */
export const DISCLOSURE =
  "This app can use publik API for its AI features: no key to paste, priced per use in dollars from a publik balance that starts at $0.00. " +
  "Linking this computer to a publik account gives $0.05 of free use, once. Your prompts go through publik's servers to the model; you can switch to your own key at any time.";

export interface PublikCredential {
  key: string;
  base_url: string;
  install_id: string;
  claim_url: string | null;
  claim_state: "anonymous" | "claimed";
  add_credit_url: string | null;
  cost_sentence: string | null;
  balance_micros: number | null;
}

export type Provider =
  | { kind: "own"; baseURL: string; apiKey: string }
  | { kind: "publik"; baseURL: string; apiKey: string; credential: PublikCredential | null }
  | { kind: "needs_consent" };

/** The app token. Public by design (it can only mint capped keys attributed to this app), so
 *  publik-app-token.txt is committed and read from this module's folder or the nearest parent.
 *  PUBLIK_APP_TOKEN in the environment overrides it. */
function appToken(): string {
  const env = process.env.PUBLIK_APP_TOKEN?.trim();
  if (env) return env;
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const file = join(dir, "publik-app-token.txt");
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
    if (dirname(dir) === dir) return "";
  }
}

/** ~/Library/Application Support/publik/apps/<slug>.json, %LOCALAPPDATA%\publik\apps\<slug>.json, ~/.config/publik/apps/<slug>.json */
export function credentialPath(): string {
  const os = platform();
  const base =
    os === "darwin" ? join(homedir(), "Library", "Application Support")
    : os === "win32" ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
    : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "publik", "apps", `${APP_SLUG}.json`);
}

export function readCredential(): PublikCredential | null {
  try {
    const c = JSON.parse(readFileSync(credentialPath(), "utf8")) as PublikCredential;
    return typeof c.key === "string" && c.key.startsWith("pk_") ? c : null;
  } catch {
    return null;
  }
}

function writeCredential(c: PublikCredential): void {
  const file = credentialPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function resolveProvider(userKey?: { baseURL: string; apiKey: string } | null): Provider {
  if (userKey?.apiKey) return { kind: "own", ...userKey };
  if (process.env.PUBLIK_API_KEY) {
    return { kind: "publik", baseURL: process.env.PUBLIK_API_BASE_URL ?? DEFAULT_BASE_URL, apiKey: process.env.PUBLIK_API_KEY, credential: null };
  }
  const c = readCredential();
  if (c) return { kind: "publik", baseURL: c.base_url || DEFAULT_BASE_URL, apiKey: c.key, credential: c };
  return { kind: "needs_consent" };
}

/** Call only after the user accepted DISCLOSURE. Throws a readable message; the caller offers the user's own key. */
export async function provision(): Promise<PublikCredential> {
  const token = appToken();
  if (!token.startsWith("pat_")) throw new Error("This build has no publik API app token. Use your own key for now.");
  const prior = readCredential();
  let installId = prior?.install_id ?? randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${DEFAULT_BASE_URL}/installs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_token: token, app_slug: APP_SLUG, app_version: APP_VERSION,
        os: platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux",
        arch: arch(), device_name: hostname().slice(0, 120), install_id: installId,
        disclosure_version: 1, dialects: ["chat_completions"],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    const key: string | null = body.key ?? (res.status === 200 ? prior?.key ?? null : null);
    if ((res.status === 201 || res.status === 200) && key) {
      const c: PublikCredential = {
        key, base_url: body.base_url ?? DEFAULT_BASE_URL, install_id: body.install_id ?? installId,
        claim_url: body.claim_url ?? null, claim_state: body.claim_state ?? "anonymous",
        add_credit_url: body.wallet?.add_credit_url ?? null, cost_sentence: body.disclosure?.cost ?? null,
        balance_micros: body.balance_micros ?? null,
      };
      writeCredential(c); // the key reaches disk before anything else sees it
      return c;
    }
    // A replay with no key on disk, or an install its owner revoked: one fresh install_id.
    if (res.status === 200 || body.error?.type === "install_revoked") { installId = randomUUID(); continue; }
    throw new Error(body.error?.message ?? `publik API could not set up this computer (${res.status}). Use your own key for now.`);
  }
  throw new Error("publik API could not set up this computer. Use your own key for now.");
}

/** OpenAI-compatible client config: new OpenAI(clientConfig(p)). */
export function clientConfig(p: Extract<Provider, { kind: "own" | "publik" }>) {
  return { baseURL: p.baseURL, apiKey: p.apiKey };
}

/** First-run card, line 1. Then keep it live from the x-publik-balance header. A new install is $0.00 until it is linked. */
export function balanceLine(micros: number | null | undefined, claimState: "anonymous" | "claimed" = "anonymous"): string {
  if (micros == null) return "";
  const dollars = `$${(micros / 1_000_000).toFixed(2)}`;
  return micros === 0 && claimState === "anonymous" ? `${dollars} · link this computer for $0.05 of free use` : `${dollars} of publik balance`;
}

/** A 402 renders its message plus exactly ONE link: this one. */
export function topUpUrlFrom402(body: unknown): { message: string; url: string | null } {
  const e = (body as { error?: { message?: string; top_up_url?: string } } | null)?.error;
  return { message: e?.message ?? "Not enough publik API balance.", url: e?.top_up_url ?? null };
}
