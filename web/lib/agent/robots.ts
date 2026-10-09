/**
 * /robots.txt: every public page and agent file is open to every crawler, and the crawlers of answer engines and
 * agents are named and welcome (the same list as the developer site). The signed-in account pages, the sessions and
 * the hosted sign-in pages (/sign-in, /authorize), device approval (/device), the embed (/embed), the API proxies
 * (/v1, /api) and the MCP endpoint (for programs, not crawlers) are kept out. The discovery documents an agent needs
 * stay open: /llms.txt, /openapi.json and /.well-known/*.
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

/** The account pages (signed in), sessions, hosted sign-in, device approval, the embed and the API proxies. */
export const DISALLOWED = [
  "/sign-in-methods", "/apps", "/silicons", "/proofs", "/activity", "/settings", "/identity",
  "/sign-in", "/authorize", "/device", "/embed/", "/developer",
  "/v1/", "/api/", "/mcp", "/__kitchen",
];

export function robotsTxt(): string {
  return [
    "# accounts.teamofsilicons.com: Silicon Accounts, one account for every Carbon and Silicon.",
    "# The landing page and the agent files are public and meant to be read, quoted and used by Carbons and Silicons alike.",
    "# Search engines, answer engines and agents are all welcome, and named below. Account pages and sign-in pages are private.",
    "# Agents: start with /llms.txt, /.well-known/agent.json, /openapi.json and the MCP server at /mcp.",
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
