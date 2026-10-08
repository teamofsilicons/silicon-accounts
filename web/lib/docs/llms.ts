/**
 * The docs for language models, in the llmstxt.org format (server only):
 *
 *   /llms.txt        the index: what Silicon Accounts is, how the docs are organised, and every page as
 *                    `- [Title](…/docs/<path>.md): description`, grouped Overview / Start / Learn / Reference
 *   /llms-full.txt   every page's Markdown in reading order, each under its title with its address, links made absolute
 *
 * Addresses use the origin the request came to (or ACCOUNTS_PUBLIC_URL), so a local stack's files point at itself.
 */
import "server-only";
import { docs, type DocPage } from "./content";
import { resolveLink, rewriteRelativeLinks } from "./links";
import { CANONICAL_ORIGIN, DOCS_BASE, GITHUB_PUBLISHED, SECTIONS } from "./site";

const HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/**
 * The public origin for absolute links: ACCOUNTS_PUBLIC_URL when the server has it, else the host the request came to
 * (X-Forwarded-Host / X-Forwarded-Proto from a load balancer, then Host), else https://accounts.teamofsilicons.com.
 */
export function publicOrigin(headers: Headers, requestUrl: string): string {
  const configured = process.env.ACCOUNTS_PUBLIC_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Not a URL: ignore it.
    }
  }
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]!.trim();
  if (host && HOST.test(host)) {
    let protocol = (headers.get("x-forwarded-proto") ?? "").split(",")[0]!.trim();
    if (protocol !== "http" && protocol !== "https") {
      try {
        protocol = new URL(requestUrl).protocol.replace(":", "");
      } catch {
        protocol = "https";
      }
    }
    return `${protocol === "http" ? "http" : "https"}://${host}`;
  }
  return CANONICAL_ORIGIN;
}

function groupsOf(pages: DocPage[]): Array<{ label: string; summary: string | null; pages: DocPage[] }> {
  const groups = new Map<string, DocPage[]>();
  for (const page of pages) groups.set(page.group, [...(groups.get(page.group) ?? []), page]);
  return [...groups.entries()].map(([key, members]) => ({
    label: members[0]!.groupLabel,
    summary: key === "overview" ? null : SECTIONS.find(section => section.key === key)?.summary ?? null,
    pages: members,
  }));
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function llmsIndex(origin: string): string {
  const { pages } = docs();
  const landing = pages.find(page => page.path === "index.md");
  const lines: string[] = [
    "# Silicon Accounts",
    "",
    `> ${oneLine(landing?.description ?? "One personal account for every Carbon (a person) and Silicon (an agent), and the whole sign-in for any app.")}`,
    "",
    "Silicon Accounts is the account system for every Carbon and Silicon, and the sign-in layer for apps: email and phone codes, Google and Apple, sign-up, the hosted pages people see, an app's user base, webhooks, and User verification/App verification proofs that let one app act at another. Silicons (agents) sign in with an si:id and an STK, never through an app's sign-in page.",
    "",
    "How to read these docs: Start pages are instructions and begin with a working example; Learn pages explain why each rule exists, so you can make your own judgement; Reference pages list every endpoint, error, limit, Rust client method and CLI command. Store an account's uuid, never its c:id or si:id (those can change). Errors say exactly what went wrong: `{\"error\": {\"code\", \"message\", \"hint\"}}`, except the OAuth token, revoke and introspect endpoints, which answer RFC 6749 `error` and `error_description`.",
    "",
    `Each page below is plain Markdown at its link (the HTML page is the same address without \`.md\`). All pages in one file: ${origin}/llms-full.txt. The silicon-accounts CLI carries offline guides too: \`silicon-accounts docs\`.`,
  ];
  for (const group of groupsOf(pages)) {
    lines.push("", `## ${group.label}`, "");
    if (group.summary) lines.push(group.summary, "");
    for (const page of group.pages) {
      lines.push(`- [${page.title}](${origin}${DOCS_BASE}/${page.path})${page.description ? `: ${oneLine(page.description)}` : ""}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function llmsFull(origin: string): string {
  const { pages, byPath } = docs();
  const landing = pages.find(page => page.path === "index.md");
  const out: string[] = [
    "# Silicon Accounts docs (full text)",
    "",
    `> ${oneLine(landing?.description ?? "One personal account for every Carbon and Silicon, and the whole sign-in for any app.")}`,
    "",
    `Every page of the Silicon Accounts docs, in reading order: the overview, then Start (instructions), Learn (why it works this way) and Reference. Each page starts with its title and its address; links between pages point at the docs on ${origin}. The index of pages: ${origin}/llms.txt.`,
  ];
  for (const page of pages) {
    const body = rewriteRelativeLinks(page.body, href => {
      const link = resolveLink(href, page.path, path => byPath.has(path));
      if (link.kind === "page" || link.kind === "section") return `${origin}${link.href}`;
      if (link.kind === "external") return link.href;
      // GitHub has the repository's files only once it is published there (GITHUB_PUBLISHED).
      if (link.kind === "repo") return GITHUB_PUBLISHED ? link.href : href;
      return href;
    }).trim();
    const withoutTitle = body.replace(/^#[ \t]+[^\n]*\n+/, "");
    out.push(
      "",
      "---",
      "",
      `# ${page.title}`,
      "",
      `Source: ${origin}${page.href} (Markdown: ${origin}${DOCS_BASE}/${page.path})`,
      "",
      ...(page.description ? [`> ${oneLine(page.description)}`, ""] : []),
      withoutTitle,
    );
  }
  out.push("");
  return out.join("\n");
}
