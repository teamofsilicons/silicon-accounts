/**
 * Where the docs live and how their addresses are made. Shared by the generator (lib/docs/build.ts), the server pages
 * and the client islands, so it imports nothing.
 *
 *   docs/index.md              → /docs            raw: /docs/index.md (and /docs.md)
 *   docs/start/add-sign-in.md  → /docs/start/add-sign-in   raw: /docs/start/add-sign-in.md
 */

/** Where the site serves the docs. */
export const DOCS_BASE = "/docs";

/** The repository, for source metadata and links to files outside docs/. */
export const GITHUB_REPO = "https://github.com/teamofsilicons/silicon-accounts";
export const GITHUB_BRANCH = "main";

/** The source and documentation are published in the repository. */
export const GITHUB_PUBLISHED = true;

/** The public origin of the account site, used when a request names no better one (llms.txt links). */
export const CANONICAL_ORIGIN = "https://developers.teamofsilicons.com";

export type SectionKey = "start" | "learn" | "reference";

export interface SectionInfo {
  key: SectionKey;
  label: string;
  /** One line under the section's name (section pages, llms.txt). */
  summary: string;
}

/** The three groups of the navigation, in reading order. A page belongs to the group named by its folder. */
export const SECTIONS: readonly SectionInfo[] = [
  { key: "start", label: "Start", summary: "Instructions. Each page does one job, starting with what you'll do and a working example." },
  { key: "learn", label: "Learn", summary: "Explanations of why each service works the way it does, so you can make your own judgement calls." },
  { key: "reference", label: "Reference", summary: "Everything, exhaustively: the HTTP API, errors, limits, Rust clients and command-line tools." },
];

export function sectionInfo(key: string | null | undefined): SectionInfo | undefined {
  const section = SECTIONS.find(section => section.key === key?.split("/").at(-1));
  return section ? { ...section, key: key as SectionKey } : undefined;
}

/** "start/add-sign-in.md" → "start/add-sign-in"; "index.md" → "". */
export function slugOf(path: string): string {
  const bare = path.replace(/\.md$/, "");
  return bare === "index" ? "" : bare.replace(/\/index$/, "");
}

/** The page's address on the site. */
export function pageHref(path: string, anchor?: string | null): string {
  const slug = slugOf(path);
  return `${DOCS_BASE}${slug ? `/${slug}` : ""}${anchor ? `#${anchor}` : ""}`;
}

/** The page's Markdown, as written. */
export function rawHref(path: string): string {
  return `${DOCS_BASE}/${path}`;
}

/** The page's source on GitHub. */
export function editHref(path: string): string {
  const source = path.startsWith("apps/") ? `docs-apps/${path.slice(5)}` : path.startsWith("accounts/") ? `docs/${path.slice(9)}` : "developer/lib/docs/landing.md";
  return `${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${source}`;
}

/** A file of the repository outside docs/ ("crates/cli/README.md"), on GitHub. */
export function repoHref(path: string, directory = false): string {
  return `${GITHUB_REPO}/${directory ? "tree" : "blob"}/${GITHUB_BRANCH}/${path.replace(/\/$/, "")}`;
}

export const PRODUCTS = [{ key: "apps", label: "Silicon Apps" }, { key: "accounts", label: "Silicon Accounts" }] as const;
export function productOf(path: string): string | null { return PRODUCTS.find(product => path.startsWith(`${product.key}/`))?.key ?? null; }
export function productLabel(path: string): string { return PRODUCTS.find(product => product.key === productOf(path))?.label ?? "Developer"; }
