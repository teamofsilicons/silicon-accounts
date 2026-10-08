/** Unified, build-bundled documentation exports; no repository files are read at runtime. */
import "server-only";
import { docs } from "./content";
import { resolveLink, rewriteRelativeLinks } from "./links";
import { CANONICAL_ORIGIN, DOCS_BASE } from "./site";

export function publicOrigin(_headers: Headers, requestUrl: string): string {
  const configured = process.env.DEVELOPER_PUBLIC_URL?.trim() || process.env.ACCOUNTS_DEVELOPER_URL?.trim();
  if (configured) { try { return new URL(configured).origin; } catch {} }
  if (process.env.NODE_ENV === "production") return CANONICAL_ORIGIN;
  try { return new URL(requestUrl).origin; } catch { return CANONICAL_ORIGIN; }
}
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
export function llmsIndex(origin: string): string {
  const lines = ["# Silicon Developer docs", "", "> Create and publish apps with Silicon Apps. Add sign-in and manage accounts with Silicon Accounts.", "", "Start pages walk through tasks. Learn pages explain how things work and why. Reference pages list commands, API requests, fields, errors and limits.", "", `All documentation: ${origin}/llms-full.txt. Each link below is plain Markdown; the HTML address omits .md.`, ""];
  let group = "";
  for (const page of docs().pages) {
    if (page.groupLabel !== group) { group = page.groupLabel; lines.push(`## ${group}`, ""); }
    lines.push(`- [${page.title}](${origin}${page.rawHref}): ${oneLine(page.description)}`);
  }
  return `${lines.join("\n")}\n`;
}
export function llmsFull(origin: string): string {
  const { pages, byPath } = docs();
  const lines = ["# Silicon Developer docs (full text)", "", "Complete Silicon Apps and Silicon Accounts documentation.", `Index: ${origin}/llms.txt`, ""];
  for (const page of pages) {
    const body = rewriteRelativeLinks(page.body, href => {
      const link = resolveLink(href, page.path, path => byPath.has(path));
      return link.kind === "page" || link.kind === "section" ? `${origin}${link.href}` : link.kind === "repo" || link.kind === "external" ? link.href : href;
    });
    lines.push("---", "", `# ${page.title}`, "", `Source: ${origin}${page.href} (Markdown: ${origin}${DOCS_BASE}/${page.path})`, "", body.replace(/^#[ \t]+[^\n]*\n+/, "").trim(), "");
  }
  return lines.join("\n");
}
