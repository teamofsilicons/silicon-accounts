/** Only the current developer account's organization management surface. */
export function organizationProxyRoute(raw: string, method: string): string | null {
  if (!raw || raw.includes("%") || raw.includes("\\") || raw.split("/").some(s => !s || s === "." || s === "..")) return null;
  const org = "[a-z0-9_-]{3,30}";
  const allowed = (method === "GET" && (/^(me|publishing)$/.test(raw) || new RegExp(`^orgs/${org}(/publishing-policy)?$`).test(raw))) ||
    (method === "POST" && new RegExp(`^orgs/${org}/actions$`).test(raw));
  return allowed ? `v1/integrations/developer/${raw}` : null;
}
