/**
 * The docs as the /docs routes see them (server only): every page from the generated bundle, in reading order, with
 * its address, its group in the navigation, its parent (reference/api/oauth.md sits under reference/api.md), the
 * previous and next page, and its parsed Markdown (parsed once per server process).
 *
 * The bundle (lib/docs/generated/pages.ts) is written by lib/docs/build.ts from the repository's docs/.
 */
import "server-only";
import { DOC_SOURCES } from "./generated/pages";
import { parseMarkdown, type Block, type Heading, type MarkdownDocument } from "./markdown";
import { DOCS_BASE, SECTIONS, editHref, pageHref, rawHref, slugOf } from "./site";
import type { DocSource, NavGroup, NavItem, TocItem } from "./types";

export type { NavGroup, NavItem, TocItem } from "./types";

export interface DocPage extends DocSource {
  /** After /docs/: "" for the landing page, "start/add-sign-in". */
  slug: string;
  href: string;
  rawHref: string;
  editHref: string;
  /** The navigation group: start, learn, reference, another folder's name, or "overview" for pages at the root. */
  group: string;
  groupLabel: string;
  /** The page this one sits under in the navigation (reference/api.md for reference/api/oauth.md). */
  parent: string | null;
}

export interface ParsedPage {
  blocks: Block[];
  headings: Heading[];
  toc: TocItem[];
}

interface DocsModel {
  pages: DocPage[];
  byPath: Map<string, DocPage>;
  bySlug: Map<string, DocPage>;
  nav: NavGroup[];
}

const GROUP_ORDER: string[] = SECTIONS.map(section => section.key);

function groupOf(path: string): string {
  return path.includes("/") ? path.split("/")[0]! : "overview";
}

function labelOf(group: string): string {
  if (group === "overview") return "Overview";
  return SECTIONS.find(section => section.key === group)?.label ?? group.replace(/[-_]/g, " ").replace(/^./, char => char.toUpperCase());
}

const byOrder = (a: DocSource, b: DocSource) => a.order - b.order || a.title.localeCompare(b.title) || a.path.localeCompare(b.path);

function build(): DocsModel {
  const sources = [...DOC_SOURCES];
  const paths = new Set(sources.map(source => source.path));
  // A page's parent is the page named like its folder: reference/api/oauth.md → reference/api.md.
  const parentOf = (path: string): string | null => {
    let directory = path.slice(0, path.lastIndexOf("/"));
    while (directory.includes("/")) {
      if (paths.has(`${directory}.md`)) return `${directory}.md`;
      directory = directory.slice(0, directory.lastIndexOf("/"));
    }
    return null;
  };

  const pages = sources.map<DocPage>(source => {
    const group = groupOf(source.path);
    return {
      ...source,
      slug: slugOf(source.path),
      href: pageHref(source.path),
      rawHref: rawHref(source.path),
      editHref: editHref(source.path),
      group,
      groupLabel: labelOf(group),
      parent: parentOf(source.path),
    };
  });

  const groups = [...new Set(pages.map(page => page.group))].sort((a, b) => {
    const rank = (key: string) => (key === "overview" ? -1 : GROUP_ORDER.includes(key) ? GROUP_ORDER.indexOf(key) : GROUP_ORDER.length);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  // Reading order: the landing page, then each group's pages by order, each followed by its children.
  const ordered: DocPage[] = [];
  const nav: NavGroup[] = [];
  const landing = pages.find(page => page.path === "index.md");
  if (landing) ordered.push(landing);
  for (const group of groups) {
    const members = pages.filter(page => page.group === group && page !== landing);
    const item = (page: DocPage): NavItem => {
      ordered.push(page);
      const children = members.filter(child => child.parent === page.path).sort(byOrder);
      return { path: page.path, title: page.title, href: page.href, children: children.map(item) };
    };
    const items = members.filter(page => !page.parent || !members.some(other => other.path === page.parent)).sort(byOrder).map(item);
    if (items.length) nav.push({ key: group, label: labelOf(group), href: group === "overview" ? null : `${DOCS_BASE}/${group}`, items });
  }

  return {
    pages: ordered,
    byPath: new Map(ordered.map(page => [page.path, page])),
    bySlug: new Map(ordered.map(page => [page.slug, page])),
    nav,
  };
}

let model: DocsModel | null = null;

/** Every page in reading order, with lookups and the navigation. */
export function docs(): DocsModel {
  model ??= build();
  return model;
}

/** The page at /docs/<slug>, or null. */
export function findPage(slug: string): DocPage | null {
  return docs().bySlug.get(slug.replace(/^\/+|\/+$/g, "")) ?? null;
}

export function findPageByPath(path: string): DocPage | null {
  return docs().byPath.get(path) ?? null;
}

/** The pages of a navigation group (start, learn, reference), in reading order. */
export function groupPages(group: string): DocPage[] {
  return docs().pages.filter(page => page.group === group);
}

/** Whether /docs/<key> is a group's page (start, learn, reference). */
export function isGroup(key: string): boolean {
  return docs().nav.some(group => group.key === key && group.href !== null);
}

/** The pages before and after this one in reading order. */
export function neighbours(page: DocPage): { previous: DocPage | null; next: DocPage | null } {
  const list = docs().pages;
  const index = list.findIndex(entry => entry.path === page.path);
  return { previous: index > 0 ? list[index - 1]! : null, next: index >= 0 && index < list.length - 1 ? list[index + 1]! : null };
}

const parsedCache = new Map<string, ParsedPage>();

/**
 * The page's Markdown, parsed. Its leading `# Title` is dropped (the page header shows the front matter's title), and
 * the table of contents lists its h2 and h3 headings.
 */
export function parsedPage(page: DocSource): ParsedPage {
  const cached = parsedCache.get(page.path);
  if (cached) return cached;
  const doc: MarkdownDocument = parseMarkdown(page.body);
  const blocks = doc.blocks[0]?.type === "heading" && doc.blocks[0].depth === 1 ? doc.blocks.slice(1) : doc.blocks;
  const headings = doc.headings.filter(heading => heading.depth > 1 || blocks.some(block => block.type === "heading" && block.id === heading.id));
  const toc = headings.filter(heading => heading.depth === 2 || heading.depth === 3).map(heading => ({ id: heading.id, text: heading.text, depth: heading.depth as 2 | 3 }));
  const parsed = { blocks, headings, toc };
  parsedCache.set(page.path, parsed);
  return parsed;
}

/** Whether `path` is a page of the docs (for link resolution). */
export function pageExists(path: string): boolean {
  return docs().byPath.has(path);
}
