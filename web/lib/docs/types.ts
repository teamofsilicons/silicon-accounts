/**
 * The shapes the docs pipeline passes around. `DocSource` is what lib/docs/build.ts writes into the generated bundle
 * (lib/docs/generated/pages.ts) for every Markdown file under the repository's docs/.
 */

export type DocKind = "instructive" | "informative";

export interface DocSource {
  /** The file inside docs/, POSIX separators: "start/add-sign-in.md". */
  path: string;
  title: string;
  /** One line: the page's lede, its search summary and its llms.txt note. */
  description: string;
  /** instructive (do this) or informative (why it works this way). */
  kind: DocKind;
  /** Position inside its group of the navigation (smaller first). */
  order: number;
  /** Other pages (paths inside docs/) shown under "Related" at the end of the page. */
  related: string[];
  /** The Markdown after the front matter. */
  body: string;
  /** The file's line number of the body's first line, so problems can name lines. */
  bodyLine: number;
}

export interface DocsBundle {
  pages: DocSource[];
}

/** One entry of the docs navigation (a page, with the pages that sit under it). */
export interface NavItem {
  path: string;
  title: string;
  href: string;
  children: NavItem[];
}

/** A group of the navigation: Start, Learn, Reference (or Overview for pages at the root of docs/). */
export interface NavGroup {
  key: string;
  label: string;
  /** The group's own page (/docs/start), or null. */
  href: string | null;
  items: NavItem[];
}

/** An entry of a page's table of contents: its h2 and h3 headings. */
export interface TocItem {
  id: string;
  text: string;
  depth: 2 | 3;
}

/** A page offered before anything is typed into search. */
export interface SearchSuggestion {
  title: string;
  href: string;
  group: string;
}
