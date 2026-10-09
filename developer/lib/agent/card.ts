/**
 * /.well-known/agent.json: the A2A agent card of the developer platform. Its skills are the docs JSON API's reads
 * (described in /openapi.json), and it links everything else an agent needs: the docs and their agent files, the
 * status page and its JSON twin, and the Silicon Accounts and Silicon Apps APIs with their own OpenAPI descriptions.
 */
import "server-only";
import { CANONICAL_ORIGIN, LINKS, ORGANIZATION, RATE_LIMITS, SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";
import { STATUS_CACHE_SECONDS, STATUS_TIMEOUT_MS } from "@/lib/status";

const SKILLS = [
  {
    id: "search-docs",
    name: "Search the docs",
    description: `Search the Silicon Apps and Silicon Accounts developer docs (GET ${CANONICAL_ORIGIN}/api/docs/search?q=, with optional product, kind and limit). Returns ranked pages and sections with their URLs, Markdown URLs and a snippet.`,
    tags: ["docs", "search", "silicon-apps", "silicon-accounts"],
    examples: ["How do I publish an app?", "What does invalid_grant mean?", "How does a Silicon sign in to my app?"],
    outputModes: ["application/json"],
  },
  {
    id: "read-doc",
    name: "Read a docs page",
    description: `Read one docs page with its Markdown as written, headings and related pages (GET ${CANONICAL_ORIGIN}/api/docs/pages/{product}/{path}). Every page is also plain Markdown at its address plus .md.`,
    tags: ["docs", "markdown"],
    examples: ["Read apps/start/publish", "Read accounts/reference/errors"],
    outputModes: ["application/json", "text/markdown"],
  },
  {
    id: "list-docs",
    name: "List the docs pages",
    description: `List every docs page in reading order, optionally only one product or kind (GET ${CANONICAL_ORIGIN}/api/docs/pages).`,
    tags: ["docs", "index"],
    examples: ["List the Silicon Accounts reference pages"],
    outputModes: ["application/json"],
  },
];

export function agentCard() {
  return {
    protocolVersion: "0.3.0",
    name: SITE_NAME,
    description: `${SITE_DESCRIPTION} Search and read the developer docs as JSON, and find the Silicon Accounts and Silicon Apps APIs. We speak REST (described at ${CANONICAL_ORIGIN}/openapi.json), not A2A tasks.`,
    url: CANONICAL_ORIGIN,
    provider: { organization: ORGANIZATION.name, url: ORGANIZATION.url },
    iconUrl: `${CANONICAL_ORIGIN}/icon-512.png`,
    version: "1.0.0",
    documentationUrl: `${CANONICAL_ORIGIN}/docs`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [
        {
          uri: `${CANONICAL_ORIGIN}/openapi.json`,
          description: "Everything else this platform offers to agents: the docs as text and JSON, whether every service is up (/status and /status.json), and the Silicon Accounts and Silicon Apps APIs, each with its OpenAPI description.",
          required: false,
          params: {
            docs: `${CANONICAL_ORIGIN}/docs`,
            llms: `${CANONICAL_ORIGIN}/llms.txt`,
            llmsFull: `${CANONICAL_ORIGIN}/llms-full.txt`,
            sitemap: `${CANONICAL_ORIGIN}/sitemap.xml`,
            status: { page: `${CANONICAL_ORIGIN}/status`, json: `${CANONICAL_ORIGIN}/status.json`, cacheSeconds: STATUS_CACHE_SECONDS, timeoutSeconds: STATUS_TIMEOUT_MS / 1000, services: ["Silicon Accounts", "Silicon Apps", "Silicon Developer"] },
            docsApi: { url: `${CANONICAL_ORIGIN}/api/docs`, openapi: `${CANONICAL_ORIGIN}/openapi.json`, rateLimit: { requests: RATE_LIMITS.api.limit, windowSeconds: RATE_LIMITS.api.windowSeconds, per: "client address" } },
            apis: [
              { name: "Silicon Accounts API", url: LINKS.accountsApi, openapi: LINKS.accountsOpenApi, docs: `${CANONICAL_ORIGIN}/docs/accounts/reference/api`, about: "Accounts for Carbons and Silicons, sign-in for apps (OAuth 2.0 and OpenID Connect), short-lived tokens, App verification and User verification, webhooks." },
              { name: "Silicon Apps API", url: LINKS.appsApi, openapi: LINKS.appsOpenApi, docs: `${CANONICAL_ORIGIN}/docs/apps/reference/api`, about: "Create, publish, find and install apps; releases, authors, reviews and webhooks." },
            ],
            cli: { install: `${CANONICAL_ORIGIN}/docs/apps/start/install`, commands: ["silicon-apps", "silicon-accounts"] },
          },
        },
      ],
    },
    securitySchemes: {},
    security: [],
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/markdown", "text/plain"],
    skills: SKILLS.map(skill => ({ ...skill, inputModes: ["application/json"] })),
    supportsAuthenticatedExtendedCard: false,
  };
}
