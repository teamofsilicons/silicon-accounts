/**
 * Links inside the docs are written for the files, the way GitHub reads them: `../learn/proofs.md#what-ends-a-proof`
 * from start/user-verification.md, `start/cli.md` from index.md. This resolves them for the site:
 *
 *   ../learn/proofs.md#x   → /docs/learn/proofs#x        (a page of the docs)
 *   #x                     → #x                          (this page)
 *   ../crates/cli/README.md → https://github.com/…/blob/main/crates/cli/README.md   (a file outside docs/)
 *   https://…, mailto:…    → unchanged                   (another site)
 *   /v1/meta               → /v1/meta                    (an address on this site)
 *
 * A link to a .md file inside docs/ that does not exist is "missing": the checker reports it and the page shows the
 * text without a link.
 */
import { DOCS_BASE, SECTIONS, pageHref, repoHref } from "./site";

export type ResolvedLink =
  | { kind: "page"; href: string; path: string; anchor: string | null }
  | { kind: "anchor"; href: string; anchor: string }
  | { kind: "section"; href: string }
  | { kind: "external"; href: string }
  | { kind: "site"; href: string }
  | { kind: "repo"; href: string }
  | { kind: "missing"; target: string; reason: string };

const SAFE_SCHEMES = /^(?:https?|mailto|tel):/i;

/** Joins and normalizes POSIX paths; ".." past the start stays as leading "../". */
export function joinPath(directory: string, relative: string): string {
  const parts = directory ? directory.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

export function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Resolves `href` as written in the page at `from` (a path inside docs/). `exists` says whether a docs path is a page. */
export function resolveLink(href: string, from: string, exists: (path: string) => boolean): ResolvedLink {
  const value = href.trim();
  if (!value) return { kind: "missing", target: href, reason: "the link has no address" };
  if (value.startsWith("//")) return { kind: "external", href: `https:${value}` };
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return SAFE_SCHEMES.test(value) ? { kind: "external", href: value } : { kind: "missing", target: value, reason: "only http, https, mailto and tel links are allowed" };
  }
  if (value.startsWith("#")) return { kind: "anchor", href: value, anchor: decode(value.slice(1)) };
  if (value.startsWith("/")) return { kind: "site", href: value };

  const hashAt = value.indexOf("#");
  const pathPart = hashAt < 0 ? value : value.slice(0, hashAt);
  const anchor = hashAt < 0 ? null : decode(value.slice(hashAt + 1)) || null;
  const cleanPath = decode(pathPart.split("?")[0]!);
  const resolved = joinPath(directoryOf(from), cleanPath);

  if (resolved.startsWith("../")) {
    // Outside docs/: a file of the repository (docs/ sits at its root).
    const repoPath = resolved.slice(3);
    if (repoPath.startsWith("../") || !repoPath) return { kind: "missing", target: value, reason: "it points outside the repository" };
    const directory = cleanPath.endsWith("/") || !/\.[A-Za-z0-9]+$/.test(repoPath);
    return { kind: "repo", href: `${repoHref(repoPath, directory)}${anchor ? `#${anchor}` : ""}` };
  }

  if (resolved.endsWith(".md")) {
    if (exists(resolved)) return { kind: "page", href: pageHref(resolved, anchor), path: resolved, anchor };
    return { kind: "missing", target: value, reason: `docs/${resolved} does not exist` };
  }

  if (!resolved) return { kind: "page", href: pageHref("index.md", anchor), path: "index.md", anchor };
  const section = SECTIONS.find(entry => entry.key === resolved.replace(/\/$/, ""));
  if (section) return { kind: "section", href: `${DOCS_BASE}/${section.key}${anchor ? `#${anchor}` : ""}` };
  if (exists(`${resolved.replace(/\/$/, "")}.md`)) return { kind: "page", href: pageHref(`${resolved.replace(/\/$/, "")}.md`, anchor), path: `${resolved.replace(/\/$/, "")}.md`, anchor };
  return { kind: "repo", href: `${repoHref(`docs/${resolved}`, cleanPath.endsWith("/") || !/\.[A-Za-z0-9]+$/.test(resolved))}${anchor ? `#${anchor}` : ""}` };
}

/** Rewrites relative link destinations in raw Markdown (outside code), for copies served at another address. */
export function rewriteRelativeLinks(markdown: string, rewrite: (href: string) => string): string {
  let fence: string | null = null;
  return markdown.split("\n").map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !line.trim().slice(marker[1]!.length).trim()) fence = null;
      return line;
    }
    if (marker) {
      fence = marker[1]!;
      return line;
    }
    // Inline code keeps its text: rewrite only between code spans.
    return line.split(/(`+[^`]*`+)/).map((part, index) => (index % 2 ? part : part.replace(/(\]\()([^)\s]+)/g, (whole, open: string, href: string) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return whole;
      return `${open}${rewrite(href)}`;
    }))).join("");
  }).join("\n");
}
