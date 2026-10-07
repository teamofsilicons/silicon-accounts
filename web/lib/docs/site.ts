/**
 * Where the docs live and how their addresses are made. Shared by the generator (lib/docs/build.ts), the server pages
 * and the client islands, so it imports nothing.
 *
 *   docs/index.md              → /docs            raw: /docs/index.md (and /docs.md)
 *   docs/start/add-sign-in.md  → /docs/start/add-sign-in   raw: /docs/start/add-sign-in.md
 */

/** Where the site serves the docs. */
export const DOCS_BASE = "/docs";

/** The repository, for "Edit on GitHub" and links to files outside docs/. */
export const GITHUB_REPO = "https://github.com/teamofsilicons/silicon-accounts";
export const GITHUB_BRANCH = "main";

/**
 * Whether GITHUB_REPO holds the code and these docs. In October 2026 it holds only understanding/, so every link into
 * it would be a 404: until it is pushed, the pages leave out "Edit on GitHub" and the footer's GitHub link, and a link
 * to a repository file outside docs/ renders as its text. Set it to true once docs/ is on the branch above.
 */
export const GITHUB_PUBLISHED = false;

/** The public origin of the account site, used when a request names no better one (llms.txt links). */
export const CANONICAL_ORIGIN = "https://accounts.teamofsilicons.com";

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
  { key: "learn", label: "Learn", summary: "Explanations of why Silicon Accounts works the way it does, so you can make your own judgement calls." },
  { key: "reference", label: "Reference", summary: "Everything, exhaustively: the HTTP API, errors, limits, the Rust client and the accounts CLI." },
];

export function sectionInfo(key: string | null | undefined): SectionInfo | undefined {
  return SECTIONS.find(section => section.key === key);
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
  return `${GITHUB_REPO}/blob/${GITHUB_BRANCH}/docs/${path}`;
}

/** A file of the repository outside docs/ ("crates/cli/README.md"), on GitHub. */
export function repoHref(path: string, directory = false): string {
  return `${GITHUB_REPO}/${directory ? "tree" : "blob"}/${GITHUB_BRANCH}/${path.replace(/\/$/, "")}`;
}
