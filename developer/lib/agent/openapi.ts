/**
 * /openapi.json: OpenAPI 3.1 for this site's own public endpoints: the docs JSON API, the MCP endpoint and the agent
 * files. The Silicon Accounts and Silicon Apps APIs describe themselves; `x-related-apis` links their descriptions.
 */
import { KIND_KEYS, MAX_LIMIT, MAX_QUERY, PRODUCT_KEYS } from "@/lib/docs/api-constants";
import { SUPPORTED_VERSIONS } from "@/lib/mcp/protocol";
import { CANONICAL_ORIGIN, LINKS, ORGANIZATION, RATE_LIMITS, SITE_NAME } from "@/lib/site";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });

const rateHeaders = {
  "RateLimit-Limit": { $ref: "#/components/headers/RateLimit-Limit" },
  "RateLimit-Remaining": { $ref: "#/components/headers/RateLimit-Remaining" },
  "RateLimit-Reset": { $ref: "#/components/headers/RateLimit-Reset" },
};

const errors = {
  "429": { $ref: "#/components/responses/TooManyRequests" },
  "500": { $ref: "#/components/responses/InternalError" },
};

const productParam = { name: "product", in: "query", required: false, description: "Only one product: apps (Silicon Apps) or accounts (Silicon Accounts).", schema: { type: "string", enum: [...PRODUCT_KEYS] } };
const kindParam = { name: "kind", in: "query", required: false, description: "Only one kind of page: start (guides), learn (explanations), reference, or overview.", schema: { type: "string", enum: [...KIND_KEYS, "overview"] } };

export function openApi() {
  return {
    openapi: "3.1.0",
    info: {
      title: `${SITE_NAME} API`,
      version: "1.0.0",
      summary: "Search and read the Silicon Apps and Silicon Accounts docs, and reach the platform's MCP server.",
      description: [
        "The public API of developers.teamofsilicons.com. Every endpoint is a read and needs no sign-in.",
        "",
        `Rate limits: the docs API allows ${RATE_LIMITS.api.limit} requests and /mcp ${RATE_LIMITS.mcp.limit} requests every ${RATE_LIMITS.api.windowSeconds} seconds from one client address. Every answer carries RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset; a request over the limit gets 429 with Retry-After.`,
        "",
        "Errors are JSON: {\"error\": {\"code\", \"message\", \"hint\"}}. The code is stable, the message says what happened, the hint says what to do.",
        "",
        "To act on the platform (create apps, publish, sign Carbons and Silicons in, verify apps), use the Silicon Apps and Silicon Accounts APIs linked in x-related-apis.",
      ].join("\n"),
      contact: { name: ORGANIZATION.name, url: ORGANIZATION.url, email: ORGANIZATION.email },
    },
    servers: [{ url: CANONICAL_ORIGIN }],
    externalDocs: { description: "Silicon Developer docs", url: `${CANONICAL_ORIGIN}/docs` },
    "x-related-apis": [
      { name: "Silicon Accounts API", url: LINKS.accountsApi, openapi: LINKS.accountsOpenApi, docs: `${CANONICAL_ORIGIN}/docs/accounts/reference/api` },
      { name: "Silicon Apps API", url: LINKS.appsApi, openapi: LINKS.appsOpenApi, docs: `${CANONICAL_ORIGIN}/docs/apps/reference/api` },
    ],
    "x-agent-card": `${CANONICAL_ORIGIN}/.well-known/agent.json`,
    "x-llms-txt": `${CANONICAL_ORIGIN}/llms.txt`,
    tags: [
      { name: "Docs", description: "The developer docs as JSON." },
      { name: "MCP", description: "The Model Context Protocol server." },
      { name: "Agent files", description: "Text and JSON files for agents and crawlers." },
    ],
    paths: {
      "/api/docs/search": {
        get: {
          tags: ["Docs"],
          operationId: "searchDocs",
          summary: "Search the docs",
          description: "Ranks pages and their h2 and h3 sections. Every word must appear; titles and headings rank above text, whole words above parts, the exact phrase above scattered words. At most four sections of one page.",
          parameters: [
            { name: "q", in: "query", required: true, description: "What to look for: a task, a command, an endpoint or an error code.", schema: { type: "string", minLength: 1, maxLength: MAX_QUERY }, example: "publish an app" },
            productParam,
            kindParam,
            { name: "limit", in: "query", required: false, description: "How many results to return.", schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: 10 } },
          ],
          responses: {
            "200": { description: "Ranked results.", headers: rateHeaders, content: json(ref("SearchResponse")) },
            "400": { $ref: "#/components/responses/BadRequest" },
            ...errors,
          },
        },
      },
      "/api/docs/pages": {
        get: {
          tags: ["Docs"],
          operationId: "listDocs",
          summary: "List the docs pages",
          description: "Every page in reading order, optionally only one product or kind.",
          parameters: [productParam, kindParam],
          responses: {
            "200": { description: "The pages.", headers: rateHeaders, content: json(ref("PageList")) },
            "400": { $ref: "#/components/responses/BadRequest" },
            ...errors,
          },
        },
      },
      "/api/docs/pages/{product}/{path}": {
        get: {
          tags: ["Docs"],
          operationId: "readDoc",
          summary: "Read one docs page",
          description: "One page with its Markdown as written, headings, related pages and neighbours. The path may hold slashes (start/publish, reference/api/oauth) and may end in .md; leave it out for the product's overview. /api/docs/pages/index is the docs landing page.",
          parameters: [
            { name: "product", in: "path", required: true, schema: { type: "string", enum: [...PRODUCT_KEYS] } },
            { name: "path", in: "path", required: true, allowReserved: true, description: "The page's path inside the product.", schema: { type: "string" }, example: "start/publish" },
          ],
          responses: {
            "200": { description: "The page.", headers: rateHeaders, content: json(ref("PageDetail")) },
            "404": { $ref: "#/components/responses/NotFound" },
            ...errors,
          },
        },
      },
      "/api/docs": {
        get: {
          tags: ["Docs"],
          operationId: "docsApiIndex",
          summary: "What the docs API offers",
          responses: { "200": { description: "The endpoints, with links.", headers: rateHeaders, content: json({ type: "object" }) }, ...errors },
        },
      },
      "/mcp": {
        post: {
          tags: ["MCP"],
          operationId: "mcp",
          summary: "MCP server (Streamable HTTP)",
          description: `Stateless MCP over Streamable HTTP. Protocol versions ${SUPPORTED_VERSIONS.join(", ")}. Methods: initialize, ping, tools/list, tools/call. Tools: search_docs, read_doc, list_docs, search_apps, get_app, check_app_id, check_account_id (all read-only). Answers are JSON, or a one-event SSE stream when Accept names only text/event-stream. Notifications get 202. GET answers 405: the server opens no stream of its own.`,
          parameters: [{ name: "MCP-Protocol-Version", in: "header", required: false, schema: { type: "string", enum: [...SUPPORTED_VERSIONS] } }],
          requestBody: { required: true, content: json({ oneOf: [ref("JsonRpcRequest"), { type: "array", items: ref("JsonRpcRequest"), maxItems: 32 }] }) },
          responses: {
            "200": { description: "The JSON-RPC answer.", headers: rateHeaders, content: { ...json({ oneOf: [ref("JsonRpcResponse"), { type: "array", items: ref("JsonRpcResponse") }] }), "text/event-stream": { schema: { type: "string" } } } },
            "202": { description: "Accepted: the body held only notifications or responses." },
            "400": { description: "Not JSON, not JSON-RPC, or an unsupported MCP-Protocol-Version.", content: json(ref("JsonRpcResponse")) },
            "429": { description: "Too many requests from this address.", headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" }, ...rateHeaders }, content: json(ref("JsonRpcResponse")) },
          },
        },
      },
      "/llms.txt": { get: { tags: ["Agent files"], operationId: "llmsTxt", summary: "The docs for language models, in short (llmstxt.org)", responses: { "200": { description: "Markdown text.", content: { "text/plain": { schema: { type: "string" } } } } } } },
      "/llms-full.txt": { get: { tags: ["Agent files"], operationId: "llmsFullTxt", summary: "Everything in one text file", responses: { "200": { description: "Markdown text.", content: { "text/plain": { schema: { type: "string" } } } } } } },
      "/.well-known/agent.json": { get: { tags: ["Agent files"], operationId: "agentCard", summary: "The A2A agent card", responses: { "200": { description: "The agent card.", content: json({ type: "object" }) } } } },
      "/sitemap.xml": { get: { tags: ["Agent files"], operationId: "sitemap", summary: "Every public page", responses: { "200": { description: "A sitemap.", content: { "application/xml": { schema: { type: "string" } } } } } } },
    },
    components: {
      headers: {
        "RateLimit-Limit": { description: "Requests allowed in the window.", schema: { type: "integer" } },
        "RateLimit-Remaining": { description: "Requests left in this window.", schema: { type: "integer" } },
        "RateLimit-Reset": { description: "Seconds until the window resets.", schema: { type: "integer" } },
        "Retry-After": { description: "Seconds to wait before trying again.", schema: { type: "integer" } },
      },
      responses: {
        BadRequest: { description: "A parameter is missing or not valid.", content: json(ref("Error")) },
        NotFound: { description: "Nothing lives at this address.", content: json(ref("Error")) },
        TooManyRequests: { description: "Too many requests from this address.", headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" }, ...rateHeaders }, content: json(ref("Error")) },
        InternalError: { description: "The server failed to answer.", content: json(ref("Error")) },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "hint"],
              properties: { code: { type: "string", examples: ["missing_query", "invalid_product", "page_not_found", "rate_limited"] }, message: { type: "string" }, hint: { type: "string" } },
            },
          },
        },
        Product: { type: ["string", "null"], enum: [...PRODUCT_KEYS, null] },
        Kind: { type: "string", enum: [...KIND_KEYS, "overview"] },
        SearchResult: {
          type: "object",
          required: ["title", "section", "url", "path", "markdown_url", "product", "kind", "group", "snippet"],
          properties: {
            title: { type: "string", description: "The page's title." },
            section: { type: ["string", "null"], description: "The section's heading, or null for the page itself." },
            url: { type: "string", format: "uri" },
            path: { type: "string", description: "The address on this site, with the section's anchor." },
            markdown_url: { type: "string", format: "uri" },
            product: ref("Product"),
            kind: ref("Kind"),
            group: { type: "string", examples: ["Silicon Apps · Start"] },
            snippet: { type: "string" },
          },
        },
        SearchResponse: {
          type: "object",
          required: ["query", "filters", "total", "limit", "results"],
          properties: {
            query: { type: "string" },
            filters: { type: "object", properties: { product: ref("Product"), kind: { oneOf: [ref("Kind"), { type: "null" }] } } },
            total: { type: "integer", description: "Every match, before the limit." },
            limit: { type: "integer" },
            results: { type: "array", items: ref("SearchResult") },
          },
        },
        PageSummary: {
          type: "object",
          required: ["path", "title", "description", "product", "kind", "type", "url", "markdown_url", "modified"],
          properties: {
            path: { type: "string", description: "The path after /docs/ (empty for the docs landing page).", examples: ["apps/start/publish"] },
            title: { type: "string" },
            description: { type: "string" },
            product: ref("Product"),
            kind: ref("Kind"),
            type: { type: "string", enum: ["Instructions", "Explanation", "Reference", "Overview"] },
            url: { type: "string", format: "uri" },
            markdown_url: { type: "string", format: "uri" },
            modified: { type: ["string", "null"], format: "date-time" },
          },
        },
        PageList: {
          type: "object",
          required: ["filters", "total", "pages"],
          properties: { filters: { type: "object" }, total: { type: "integer" }, pages: { type: "array", items: ref("PageSummary") } },
        },
        PageLink: { type: "object", required: ["path", "title", "url"], properties: { path: { type: "string" }, title: { type: "string" }, url: { type: "string", format: "uri" } } },
        PageDetail: {
          allOf: [
            ref("PageSummary"),
            {
              type: "object",
              required: ["headings", "related", "previous", "next", "markdown"],
              properties: {
                headings: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, depth: { type: "integer" }, url: { type: "string", format: "uri" } } } },
                related: { type: "array", items: ref("PageLink") },
                previous: { oneOf: [ref("PageLink"), { type: "null" }] },
                next: { oneOf: [ref("PageLink"), { type: "null" }] },
                markdown: { type: "string", description: "The page's Markdown as written, after its front matter." },
              },
            },
          ],
        },
        JsonRpcRequest: {
          type: "object",
          required: ["jsonrpc", "method"],
          properties: { jsonrpc: { const: "2.0" }, id: { type: ["string", "integer", "null"] }, method: { type: "string", examples: ["initialize", "tools/list", "tools/call"] }, params: { type: "object" } },
        },
        JsonRpcResponse: {
          type: "object",
          required: ["jsonrpc", "id"],
          properties: {
            jsonrpc: { const: "2.0" },
            id: { type: ["string", "integer", "null"] },
            result: { type: "object" },
            error: { type: "object", required: ["code", "message"], properties: { code: { type: "integer" }, message: { type: "string" }, data: {} } },
          },
        },
      },
    },
  };
}
