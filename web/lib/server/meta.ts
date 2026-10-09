/**
 * What the server side of the site needs from the API's GET /v1/meta: where the developer site is (`developer_url`).
 * Shared by proxy.ts (the /developer and /docs redirects) and the server-rendered public pages, cached for a minute
 * (a fallback only for five seconds, so the real answer is picked up soon). ACCOUNTS_API_URL is read at request time.
 */
import { LINKS } from "@/lib/site";

/** Where the Rust API listens (server side). */
export const apiUrl = () => (process.env.ACCOUNTS_API_URL ?? "http://127.0.0.1:8589").replace(/\/+$/, "");

const DEVELOPER_TTL_MS = 60_000;
let developerCache: { url: string; until: number } | null = null;

/** A clean http(s) origin-and-path without a trailing slash, or null. */
export function siteUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/** The developer site: GET /v1/meta `developer_url`, else ACCOUNTS_DEVELOPER_URL, else production. */
export async function developerUrl(): Promise<string> {
  if (developerCache && developerCache.until > Date.now()) return developerCache.url;
  let url: string | null = null;
  try {
    const response = await fetch(`${apiUrl()}/v1/meta`, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (response.ok) url = siteUrl(((await response.json()) as { developer_url?: unknown }).developer_url);
  } catch {
    url = null;
  }
  const resolved = url ?? siteUrl(process.env.ACCOUNTS_DEVELOPER_URL) ?? LINKS.developers;
  developerCache = { url: resolved, until: Date.now() + (url ? DEVELOPER_TTL_MS : 5_000) };
  return resolved;
}

/** Tests only: forget the cached answer. */
export function resetMetaCache(): void {
  developerCache = null;
}
