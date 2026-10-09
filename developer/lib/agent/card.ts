/**
 * /.well-known/agent.json: the A2A agent card of the developer platform. Its skills are the MCP server's tools (served
 * at /mcp over Streamable HTTP, declared as an extension of the card), and it links everything else an agent needs:
 * the docs and their agent files, this site's JSON API and OpenAPI description, and the Silicon Accounts and Silicon
 * Apps APIs with their own OpenAPI descriptions.
 */
import "server-only";
import { TOOLS } from "@/lib/mcp/tools";
import { CANONICAL_ORIGIN, LINKS, ORGANIZATION, RATE_LIMITS, SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";
import { SUPPORTED_VERSIONS } from "@/lib/mcp/protocol";

const SKILL_DETAILS: Record<string, { tags: string[]; examples: string[] }> = {
  search_docs: { tags: ["docs", "search", "silicon-apps", "silicon-accounts"], examples: ["How do I publish an app?", "What does invalid_grant mean?", "How does a Silicon sign in to my app?"] },
  read_doc: { tags: ["docs", "markdown"], examples: ["Read apps/start/publish", "Read accounts/reference/errors"] },
  list_docs: { tags: ["docs", "index"], examples: ["List the Silicon Accounts reference pages"] },
  search_apps: { tags: ["apps", "store", "search"], examples: ["Find a file storage app", "Which apps can send notifications?"] },
  get_app: { tags: ["apps", "store"], examples: ["Show the app silicon-accounts"] },
  check_app_id: { tags: ["apps", "availability"], examples: ["Is the app ID ring free?"] },
  check_account_id: { tags: ["accounts", "availability", "identity"], examples: ["Can I take si:head_of_growth?"] },
};

export function agentCard() {
  return {
    protocolVersion: "0.3.0",
    name: SITE_NAME,
    description: `${SITE_DESCRIPTION} Search and read the developer docs, find apps in the Silicon Apps store, and check app IDs and Carbon or Silicon IDs before you take them.`,
    url: `${CANONICAL_ORIGIN}/mcp`,
    preferredTransport: "JSONRPC",
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
          uri: "https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http",
          description: "The skills below are MCP tools. Call them at the card's url with MCP over Streamable HTTP: stateless JSON-RPC 2.0 over POST (initialize, tools/list, tools/call, ping).",
          required: false,
          params: {
            endpoint: `${CANONICAL_ORIGIN}/mcp`,
            protocolVersions: [...SUPPORTED_VERSIONS],
            rateLimit: { requests: RATE_LIMITS.mcp.limit, windowSeconds: RATE_LIMITS.mcp.windowSeconds, per: "client address" },
          },
        },
        {
          uri: `${CANONICAL_ORIGIN}/openapi.json`,
          description: "Everything else this platform offers to agents: the docs as text and JSON, and the Silicon Accounts and Silicon Apps APIs, each with its OpenAPI description.",
          required: false,
          params: {
            docs: `${CANONICAL_ORIGIN}/docs`,
            llms: `${CANONICAL_ORIGIN}/llms.txt`,
            llmsFull: `${CANONICAL_ORIGIN}/llms-full.txt`,
            sitemap: `${CANONICAL_ORIGIN}/sitemap.xml`,
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
    skills: TOOLS.map(tool => ({
      id: tool.definition.name,
      name: tool.definition.title,
      description: tool.definition.description,
      tags: SKILL_DETAILS[tool.definition.name]?.tags ?? [],
      examples: SKILL_DETAILS[tool.definition.name]?.examples ?? [],
      inputModes: ["application/json"],
      outputModes: tool.definition.name === "read_doc" ? ["text/markdown", "application/json"] : ["application/json"],
    })),
    supportsAuthenticatedExtendedCard: false,
  };
}
