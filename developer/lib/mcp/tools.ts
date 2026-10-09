/**
 * The tools /mcp offers, all read-only:
 *
 *   search_docs, read_doc, list_docs   the bundled docs (lib/docs/api.ts), the same as the JSON API
 *   search_apps, get_app               the Silicon Apps store's public catalog: GET /v1/apps and /v1/apps/{app_id}
 *   check_app_id                       whether an app ID is free: GET /v1/apps/availability/{app_id} (Apps)
 *   check_account_id                   whether a c:id or si:id is free: GET /v1/ids/available?id= (Accounts)
 *
 * The Apps and Accounts calls go server to server (APPS_API_URL, ACCOUNTS_API_URL), with no token: they are public
 * reads. Their failures come back as tool results with isError, in the APIs' own words.
 */
import "server-only";
import { KIND_KEYS, PRODUCT_KEYS, isProblem, listPages, parseKind, parseLimit, parseProduct, parseQuery, readPage, search } from "@/lib/docs/api";
import { accountsApiUrl, appsApiUrl } from "@/lib/server/config";
import { LINKS, storeAppUrl } from "@/lib/site";
import { intArg, isToolResult, stringArg, toolError, toolResult, type Tool, type ToolResult } from "./protocol";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const READ_ONLY_REMOTE = { ...READ_ONLY, openWorldHint: true } as const;
const UPSTREAM_TIMEOUT_MS = 10_000;

const productSchema = { type: "string", enum: [...PRODUCT_KEYS], description: "apps (Silicon Apps) or accounts (Silicon Accounts). Leave out for both." };
const kindSchema = { type: "string", enum: [...KIND_KEYS, "overview"], description: "start (guides), learn (explanations), reference, or overview." };

function problemResult(problem: { code: string; message: string; hint: string }): ToolResult {
  return toolError(problem.code, problem.message, problem.hint);
}

/** GET a public JSON endpoint of the Apps or Accounts API. */
async function upstream(service: "Apps" | "Accounts", url: string): Promise<{ ok: true; status: number; body: unknown } | { ok: false; result: ToolResult }> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "silicon-developer-mcp" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "did not answer within 10 seconds" : "could not be reached";
    return { ok: false, result: toolError("upstream_unreachable", `Silicon ${service} ${reason}.`, "Try again in a moment.") };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 429) {
    const after = response.headers.get("retry-after");
    return { ok: false, result: toolError("rate_limited", `Silicon ${service} is limiting requests right now.`, after ? `Wait ${after} seconds, then try again.` : "Wait a little, then try again.") };
  }
  if (!response.ok && response.status !== 404) {
    const error = (body as { error?: { code?: string; message?: string; hint?: string } } | null)?.error;
    return { ok: false, result: toolError(error?.code ?? "upstream_error", error?.message ?? `Silicon ${service} answered ${response.status}.`, error?.hint ?? "Try again in a moment.") };
  }
  return { ok: true, status: response.status, body };
}

interface AppRecord {
  app_id: string;
  name: string;
  description?: string;
  logo?: string;
  tags?: string[];
  links?: Record<string, unknown>;
  published?: boolean;
  visibility?: string;
  authors?: Array<{ id?: string; display_name?: string }>;
  targets?: unknown[];
  latest_production?: { version?: string; created_at?: string } | null;
  latest_development?: { version?: string; created_at?: string } | null;
  rating?: number | null;
  review_count?: number;
  installs?: number;
  created_at?: string;
  updated_at?: string;
}

/** The public part of an app, with its store page and install command. */
function publicApp(app: AppRecord, full = false) {
  return {
    app_id: app.app_id,
    name: app.name,
    description: app.description ?? "",
    tags: app.tags ?? [],
    rating: app.rating ?? null,
    review_count: app.review_count ?? 0,
    installs: app.installs ?? 0,
    production_version: app.latest_production?.version ?? null,
    development_version: app.latest_development?.version ?? null,
    authors: (app.authors ?? []).map(author => ({ id: author.id ?? null, display_name: author.display_name ?? null })),
    store_url: storeAppUrl(app.app_id),
    install: `silicon-apps install ${app.app_id}`,
    ...(full ? { logo: app.logo || null, links: app.links ?? {}, targets: app.targets ?? [], visibility: app.visibility ?? "public", created_at: app.created_at ?? null, updated_at: app.updated_at ?? null } : {}),
  };
}

const APP_ID = /^[a-z0-9_-]{1,64}$/;

export const TOOLS: Tool[] = [
  {
    definition: {
      name: "search_docs",
      title: "Search the docs",
      description: "Search the Silicon Apps and Silicon Accounts developer docs. Returns ranked pages and sections with their URLs, Markdown URLs and a snippet. Use read_doc to read a result in full.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 200, description: "Words to look for: a task (publish an app), a command (silicon-accounts login), an endpoint (/v1/oauth/token) or an error code (invalid_grant)." },
          product: productSchema,
          kind: kindSchema,
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { title: "Search the docs", ...READ_ONLY },
    },
    async call(args) {
      const query = parseQuery(typeof args.query === "string" ? args.query : null);
      if (isProblem(query)) return problemResult(query);
      const product = parseProduct(typeof args.product === "string" ? args.product : null);
      if (isProblem(product)) return problemResult(product);
      const kind = parseKind(typeof args.kind === "string" ? args.kind : null);
      if (isProblem(kind)) return problemResult(kind);
      const limit = parseLimit(typeof args.limit === "number" || typeof args.limit === "string" ? args.limit : null);
      if (isProblem(limit)) return problemResult(limit);
      return toolResult(search({ query, product, kind, limit }));
    },
  },
  {
    definition: {
      name: "read_doc",
      title: "Read a docs page",
      description: "Read one docs page in full: its Markdown, headings, related pages and the pages before and after it. Takes the path after /docs/ (apps/start/publish, accounts/reference/errors), a /docs/… address, a .md address or a full URL.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", maxLength: 300, description: "The page, such as apps/start/publish or https://developers.teamofsilicons.com/docs/accounts/start/add-sign-in." } },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { title: "Read a docs page", ...READ_ONLY },
    },
    async call(args) {
      const path = stringArg(args, "path", { required: true, max: 300 });
      if (isToolResult(path)) return path;
      const page = readPage(path ?? "");
      if (!page) return toolError("page_not_found", `There is no docs page at "${(path ?? "").slice(0, 120)}".`, "Use list_docs or search_docs to find the right path.");
      // The Markdown starts with the page's own # title; where it lives and when it changed go before it.
      return toolResult(page, `URL: ${page.url}\nMarkdown: ${page.markdown_url}\n${page.modified ? `Updated: ${page.modified}\n` : ""}\n${page.markdown.trim()}\n`);
    },
  },
  {
    definition: {
      name: "list_docs",
      title: "List the docs pages",
      description: "List every docs page in reading order, optionally only one product or one kind, with titles, one-line descriptions and URLs.",
      inputSchema: { type: "object", properties: { product: productSchema, kind: kindSchema }, additionalProperties: false },
      annotations: { title: "List the docs pages", ...READ_ONLY },
    },
    async call(args) {
      const product = parseProduct(typeof args.product === "string" ? args.product : null);
      if (isProblem(product)) return problemResult(product);
      const kind = parseKind(typeof args.kind === "string" ? args.kind : null);
      if (isProblem(kind)) return problemResult(kind);
      const pages = listPages({ product, kind });
      return toolResult({ filters: { product, kind }, total: pages.length, pages });
    },
  },
  {
    definition: {
      name: "search_apps",
      title: "Search the Silicon Apps store",
      description: "Search the published apps in the Silicon Apps store by ID, name, tag or description. Returns each app's ID, description, rating, installs, current version, store page and install command.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 200, description: "Words to look for. Leave out to list apps." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          offset: { type: "integer", minimum: 0, maximum: 10000, default: 0 },
        },
        additionalProperties: false,
      },
      annotations: { title: "Search the Silicon Apps store", ...READ_ONLY_REMOTE },
    },
    async call(args) {
      const query = stringArg(args, "query");
      if (isToolResult(query)) return query;
      const limit = intArg(args, "limit", { min: 1, max: 50, fallback: 10 });
      if (isToolResult(limit)) return limit;
      const offset = intArg(args, "offset", { min: 0, max: 10_000, fallback: 0 });
      if (isToolResult(offset)) return offset;
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (query?.trim()) params.set("q", query.trim());
      const answer = await upstream("Apps", `${appsApiUrl()}/v1/apps?${params}`);
      if (!answer.ok) return answer.result;
      const body = answer.body as { items?: AppRecord[]; total?: number } | null;
      const apps = (body?.items ?? []).map(app => publicApp(app));
      return toolResult({ query: query?.trim() ?? null, total: body?.total ?? apps.length, limit, offset, apps, store: LINKS.store });
    },
  },
  {
    definition: {
      name: "get_app",
      title: "Get an app",
      description: "Get one app from the Silicon Apps store by its app ID: description, authors, tags, links, versions, targets, rating, installs, store page and install command.",
      inputSchema: {
        type: "object",
        properties: { app_id: { type: "string", maxLength: 64, description: "The app's ID, such as silicon-accounts." } },
        required: ["app_id"],
        additionalProperties: false,
      },
      annotations: { title: "Get an app", ...READ_ONLY_REMOTE },
    },
    async call(args) {
      const appId = stringArg(args, "app_id", { required: true, max: 64 });
      if (isToolResult(appId)) return appId;
      const id = (appId ?? "").trim().toLowerCase();
      if (!APP_ID.test(id)) return toolError("invalid_app_id", `"${id.slice(0, 64)}" is not an app ID.`, "App IDs are lowercase letters, digits, hyphens and underscores, such as silicon-accounts.");
      const answer = await upstream("Apps", `${appsApiUrl()}/v1/apps/${encodeURIComponent(id)}`);
      if (!answer.ok) return answer.result;
      if (answer.status === 404) return toolError("app_not_found", `No published app is called ${id}.`, "Check the ID with search_apps.");
      return toolResult(publicApp(answer.body as AppRecord, true));
    },
  },
  {
    definition: {
      name: "check_app_id",
      title: "Check an app ID",
      description: "Check whether an app ID is still free to create a new app with in Silicon Apps. New app IDs have 3 to 30 lowercase letters, digits, hyphens or underscores, and never change once taken.",
      inputSchema: {
        type: "object",
        properties: { app_id: { type: "string", maxLength: 64, description: "The app ID you want, such as ring." } },
        required: ["app_id"],
        additionalProperties: false,
      },
      annotations: { title: "Check an app ID", ...READ_ONLY_REMOTE },
    },
    async call(args) {
      const appId = stringArg(args, "app_id", { required: true, max: 64 });
      if (isToolResult(appId)) return appId;
      const id = (appId ?? "").trim();
      if (!/^[a-z0-9_-]{3,30}$/.test(id)) {
        return toolResult({ app_id: id, available: false, reason: "invalid", message: "A new app ID needs 3 to 30 lowercase letters, digits, hyphens or underscores." });
      }
      const answer = await upstream("Apps", `${appsApiUrl()}/v1/apps/availability/${encodeURIComponent(id)}`);
      if (!answer.ok) return answer.result;
      const available = (answer.body as { available?: boolean } | null)?.available === true;
      return toolResult({ app_id: id, available, reason: available ? null : "taken", message: available ? `${id} is free. Create it with: silicon-apps create ${id} --name "Your app name"` : `${id} is taken. Try another ID.` });
    },
  },
  {
    definition: {
      name: "check_account_id",
      title: "Check a Carbon or Silicon ID",
      description: "Check whether a Silicon Accounts ID can be taken: a Carbon's c:id or a Silicon's si:id, with its prefix (si:head_of_growth). Says why when it cannot, and suggests free IDs close to it.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", maxLength: 64, description: "The full ID with its prefix, such as si:scout or c:saket." } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { title: "Check a Carbon or Silicon ID", ...READ_ONLY_REMOTE },
    },
    async call(args) {
      const value = stringArg(args, "id", { required: true, max: 64 });
      if (isToolResult(value)) return value;
      const answer = await upstream("Accounts", `${accountsApiUrl()}/v1/ids/available?${new URLSearchParams({ id: (value ?? "").trim() })}`);
      if (!answer.ok) return answer.result;
      return toolResult(answer.body);
    },
  },
];

export const SERVER = {
  name: "silicon-developer",
  title: "Silicon Developer",
  version: "1.0.0",
  instructions: [
    "Silicon Developer is where you build into the Silicon ecosystem, where Carbons (people) and Silicons (agents) share apps and accounts.",
    "Use search_docs, then read_doc, to learn how to publish an app with Silicon Apps or add sign-in with Silicon Accounts; list_docs shows every page.",
    "Use search_apps and get_app to find apps in the store, check_app_id before creating an app, and check_account_id before creating a Carbon or Silicon account.",
    "Every tool only reads. To act, use the silicon-apps and silicon-accounts CLIs or the Apps and Accounts APIs the docs describe.",
  ].join(" "),
};
