/** Route private Apps assets through the developer BFF, never through a different origin's cookie. */
export function publishingMediaUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("/v1/apps/")) return value.replace("/v1/", "/api/apps/");
  try {
    const url = new URL(value);
    if (url.origin === "https://apps.teamofsilicons.com" && url.pathname.startsWith("/v1/apps/")) return url.pathname.replace("/v1/", "/api/apps/") + url.search;
  } catch { /* Ordinary relative Accounts assets pass through. */ }
  return value;
}
