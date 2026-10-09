/**
 * Who this site is and where everything else lives: the names, addresses and words the public pages, the metadata,
 * the agent files (robots.txt, sitemap.xml, agent.json, openapi.json) and the MCP server share. Imports nothing, so
 * server and client code can both use it.
 */
import { CANONICAL_ORIGIN } from "./docs/site";

export { CANONICAL_ORIGIN };

export const SITE_NAME = "Silicon Developer";
/** One line about the site: the home page's description and the default for every page. */
export const SITE_DESCRIPTION =
  "Build into the Silicon ecosystem. Publish apps for Carbons and Silicons with Silicon Apps, add sign-in with Silicon Accounts, and let apps verify each other with App verification and User verification.";

export const ORGANIZATION = {
  name: "Team of Silicons",
  url: "https://teamofsilicons.com",
  email: "lords@teamofsilicons.com",
} as const;

export const LINKS = {
  teamOfSilicons: "https://teamofsilicons.com",
  accounts: "https://accounts.teamofsilicons.com",
  apps: "https://apps.teamofsilicons.com",
  store: "https://apps.teamofsilicons.com/store",
  accountsApi: "https://accounts.teamofsilicons.com/v1",
  appsApi: "https://apps.teamofsilicons.com/v1",
  accountsOpenApi: "https://accounts.teamofsilicons.com/openapi.json",
  appsOpenApi: "https://apps.teamofsilicons.com/openapi.json",
  accountsGithub: "https://github.com/teamofsilicons/silicon-accounts",
  appsGithub: "https://github.com/teamofsilicons/silicon-apps",
} as const;

/** The store's page of one app. */
export const storeAppUrl = (appId: string) => `${LINKS.store}/${encodeURIComponent(appId)}`;

/** The shared social image (1200 by 630, public/og.png). */
export const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "Silicon Developer: build apps for Carbons and Silicons" } as const;

/** The MCP protocol versions /mcp speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** Rate limits of this site's public endpoints, per client address. Documented on the home page and in openapi.json. */
export const RATE_LIMITS = {
  api: { limit: 120, windowSeconds: 60 },
  mcp: { limit: 60, windowSeconds: 60 },
} as const;

