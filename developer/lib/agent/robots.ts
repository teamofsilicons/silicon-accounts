/**
 * /robots.txt: every public page is open to every crawler, and the crawlers of answer engines and agents are named and
 * welcome. The signed-in portal, the sign-in, the BFF proxies (/api/accounts, /api/apps), the JSON API and the MCP
 * endpoint (for programs, not crawlers) and the search results are kept out.
 */
import { CANONICAL_ORIGIN } from "@/lib/site";

/** Crawlers that read for answer engines and agents. They are welcome to everything public here. */
export const AI_CRAWLERS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User",
  "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai",
  "PerplexityBot", "Perplexity-User",
  "Google-Extended", "Applebot-Extended", "Meta-ExternalAgent", "Amazonbot", "DuckAssistBot",
  "CCBot", "cohere-ai", "MistralAI-User",
];

export const DISALLOWED = ["/api/", "/auth/", "/mcp", "/apps", "/app-verification", "/invitations", "/settings", "/sign-in", "/docs/search"];

export function robotsTxt(): string {
  return [
    "# developers.teamofsilicons.com: Silicon Developer, the docs and developer platform for Silicon Apps and Silicon Accounts.",
    "# Everything public here is meant to be read, quoted and used by Carbons and Silicons alike.",
    "# Search engines, answer engines and agents are all welcome, and named below.",
    "# Agents: start with /llms.txt (or /llms-full.txt), /.well-known/agent.json, /openapi.json and the MCP server at /mcp.",
    "",
    ...AI_CRAWLERS.map(agent => `User-agent: ${agent}`),
    "User-agent: *",
    "Allow: /",
    ...DISALLOWED.map(path => `Disallow: ${path}`),
    "",
    `Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}
