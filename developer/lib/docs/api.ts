/**
 * The docs as data, for the public JSON API (app/api/docs), the MCP server's docs tools (lib/mcp/tools.ts) and the
 * server-rendered search page (/docs/search). Everything comes from the bundled docs: search ranks with the same code
 * as the search in the browser (lib/docs/search.ts), over the same records (lib/docs/search-index.ts).
 */
import "server-only";
import { docs, findPage, findPageByPath, neighbours, parsedPage, type DocPage } from "./content";
import { buildSearchIndex } from "./search-index";
import { prepareIndex, searchDocs, type PreparedRecord } from "./search";
import { CANONICAL_ORIGIN, DOCS_BASE, PRODUCTS } from "./site";
import { DEFAULT_LIMIT, KIND_KEYS, MAX_LIMIT, MAX_QUERY, PRODUCT_KEYS, type Kind, type Product } from "./api-constants";

export { DEFAULT_LIMIT, KIND_KEYS, MAX_LIMIT, MAX_QUERY, PRODUCT_KEYS, type Kind, type Product };

const absolute = (path: string) => `${CANONICAL_ORIGIN}${path}`;

/** The product and kind of a docs address (/docs/apps/start/install#x → apps, start). */
export function classify(href: string): { product: Product | null; kind: Kind } {
  const parts = href.split("#")[0]!.replace(/^\/docs\/?/, "").split("/").filter(Boolean);
  const product = (PRODUCT_KEYS as readonly string[]).includes(parts[0] ?? "") ? (parts[0] as Product) : null;
  const kind = product && (KIND_KEYS as readonly string[]).includes(parts[1] ?? "") ? (parts[1] as Kind) : "overview";
  return { product, kind };
}

export interface PageSummary {
  /** The page's path after /docs/: "apps/start/install" ("" for the docs landing page). */
  path: string;
  title: string;
  description: string;
  product: Product | null;
  kind: Kind;
  /** "Instructions", "Explanation", "Reference" or "Overview". */
  type: string;
  url: string;
  markdown_url: string;
  modified: string | null;
}

export interface PageDetail extends PageSummary {
  headings: Array<{ id: string; text: string; depth: number; url: string }>;
  related: Array<{ path: string; title: string; url: string }>;
  previous: { path: string; title: string; url: string } | null;
  next: { path: string; title: string; url: string } | null;
  /** The page's Markdown as written, after its front matter. */
  markdown: string;
}

function typeOf(page: DocPage): string {
  if (page.group.endsWith("reference")) return "Reference";
  if (page.group.endsWith("overview") || page.group === "overview") return "Overview";
  return page.kind === "instructive" ? "Instructions" : "Explanation";
}

export function summarize(page: DocPage): PageSummary {
  const { product, kind } = classify(page.href);
  return {
    path: page.slug,
    title: page.title,
    description: page.description,
    product,
    kind,
    type: typeOf(page),
    url: absolute(page.href),
    markdown_url: absolute(page.rawHref),
    modified: page.modified ?? null,
  };
}

const link = (page: DocPage) => ({ path: page.slug, title: page.title, url: absolute(page.href) });

export function detail(page: DocPage): PageDetail {
  const { previous, next } = neighbours(page);
  return {
    ...summarize(page),
    headings: parsedPage(page).headings.filter(heading => heading.depth >= 2).map(heading => ({ id: heading.id, text: heading.text, depth: heading.depth, url: absolute(`${page.href}#${heading.id}`) })),
    related: page.related.map(path => findPageByPath(path)).filter((entry): entry is DocPage => entry !== null).map(link),
    previous: previous ? link(previous) : null,
    next: next ? link(next) : null,
    markdown: page.body,
  };
}

/** Every page, in reading order, narrowed by product and kind. */
export function listPages({ product, kind }: { product?: Product | null; kind?: Kind | null } = {}): PageSummary[] {
  return docs().pages.map(summarize).filter(page => (!product || page.product === product) && (!kind || page.kind === kind));
}

/**
 * One page by its path after /docs/, as an address, a Markdown path or a full URL: "apps/start/publish",
 * "/docs/apps/start/publish.md", "https://developers.teamofsilicons.com/docs/apps". "" or "index" is the landing page.
 */
export function readPage(input: string): PageDetail | null {
  let path = input.trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    return null;
  }
  path = path.split("#")[0]!.split("?")[0]!.replace(/^\/+/, "").replace(/^docs(\/|$)/, "").replace(/\.md$/, "").replace(/\/+$/, "");
  if (path === "index") path = "";
  path = path.replace(/\/index$/, "");
  const page = findPage(path);
  return page ? detail(page) : null;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Search                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface SearchResult {
  title: string;
  /** The section's heading, or null for the page itself. */
  section: string | null;
  url: string;
  /** The address on this site: /docs/apps/start/publish#upload-a-package. */
  path: string;
  markdown_url: string;
  product: Product | null;
  kind: Kind;
  group: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  filters: { product: Product | null; kind: Kind | null };
  total: number;
  limit: number;
  results: SearchResult[];
}

let prepared: PreparedRecord[] | null = null;
const filtered = new Map<string, PreparedRecord[]>();

function records(product: Product | null, kind: Kind | null): PreparedRecord[] {
  prepared ??= prepareIndex(buildSearchIndex());
  if (!product && !kind) return prepared;
  const key = `${product ?? ""}/${kind ?? ""}`;
  let list = filtered.get(key);
  if (!list) {
    list = prepared.filter(record => {
      const where = classify(record.u);
      return (!product || where.product === product) && (!kind || where.kind === kind);
    });
    filtered.set(key, list);
  }
  return list;
}

export function search({ query, product = null, kind = null, limit = DEFAULT_LIMIT }: { query: string; product?: Product | null; kind?: Kind | null; limit?: number }): SearchResponse {
  const hits = searchDocs(records(product, kind), query, 500);
  return {
    query,
    filters: { product, kind },
    total: hits.length,
    limit,
    results: hits.slice(0, limit).map(hit => {
      const where = classify(hit.record.u);
      const page = findPage(hit.record.u.split("#")[0]!.replace(/^\/docs\/?/, ""));
      return {
        title: hit.record.t,
        section: hit.record.h ?? null,
        url: absolute(hit.record.u),
        path: hit.record.u,
        markdown_url: absolute(page?.rawHref ?? `${DOCS_BASE}/index.md`),
        product: where.product,
        kind: where.kind,
        group: hit.record.g,
        snippet: hit.snippet.map(part => part.text).join(""),
      };
    }),
  };
}

export const PRODUCT_LABELS: Record<Product, string> = Object.fromEntries(PRODUCTS.map(product => [product.key, product.label])) as Record<Product, string>;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Query checks, shared by the JSON API, MCP and the search page                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface QueryProblem {
  code: string;
  message: string;
  hint: string;
}

export function parseProduct(value: string | null | undefined): Product | null | QueryProblem {
  if (value === null || value === undefined || value === "") return null;
  if ((PRODUCT_KEYS as readonly string[]).includes(value)) return value as Product;
  return { code: "invalid_product", message: `There is no product called "${value.slice(0, 40)}".`, hint: "Use product=apps or product=accounts, or leave it out to search both." };
}

export function parseKind(value: string | null | undefined): Kind | null | QueryProblem {
  if (value === null || value === undefined || value === "") return null;
  if ((KIND_KEYS as readonly string[]).includes(value) || value === "overview") return value as Kind;
  return { code: "invalid_kind", message: `There is no kind of page called "${value.slice(0, 40)}".`, hint: "Use kind=start (guides), kind=learn (explanations), kind=reference, or kind=overview, or leave it out." };
}

export function parseLimit(value: string | number | null | undefined): number | QueryProblem {
  if (value === null || value === undefined || value === "") return DEFAULT_LIMIT;
  const number = typeof value === "number" ? value : /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  if (Number.isInteger(number) && number >= 1 && number <= MAX_LIMIT) return number;
  return { code: "invalid_limit", message: `limit must be a whole number from 1 to ${MAX_LIMIT}.`, hint: `Leave it out for ${DEFAULT_LIMIT} results.` };
}

export function parseQuery(value: string | null | undefined): string | QueryProblem {
  const query = (value ?? "").trim();
  if (!query) return { code: "missing_query", message: "Say what to look for.", hint: "Add q with a few words, for example q=publish an app or q=invalid_grant." };
  if (query.length > MAX_QUERY) return { code: "query_too_long", message: `The query is ${query.length} characters; the most is ${MAX_QUERY}.`, hint: "Use a few distinctive words: a command, an endpoint, an error code." };
  return query;
}

export const isProblem = (value: unknown): value is QueryProblem => typeof value === "object" && value !== null && "code" in value && "hint" in value;
