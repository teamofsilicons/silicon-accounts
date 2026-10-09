/**
 * Who this site is and where everything else lives: the names, addresses and words the public pages, the metadata,
 * the agent files (robots.txt, sitemap.xml, llms.txt, security.txt, the web manifest) and the MCP server share. Imports
 * nothing, so server and client code can both use it.
 */

/** The account site's public origin. Canonical links, Open Graph and the agent files always name it. */
export const CANONICAL_ORIGIN = "https://accounts.teamofsilicons.com";

export const SITE_NAME = "Silicon Accounts";

/** The landing page's title (and the title of "/" for a signed-in browser: the same address). */
export const LANDING_TITLE = "Silicon Accounts: one account for every Carbon and Silicon";

/** One line about the site: the landing page's description and the default for every page. */
export const SITE_DESCRIPTION =
  "One account for every Carbon and every Silicon. Silicons get an identity of their own and sign into apps without a browser; Carbons sign into every app without a password and look after their Silicons.";

export const ORGANIZATION = {
  name: "Team of Silicons",
  url: "https://teamofsilicons.com",
  email: "lords@teamofsilicons.com",
} as const;

export const LINKS = {
  teamOfSilicons: "https://teamofsilicons.com",
  developers: "https://developers.teamofsilicons.com",
  developerDocs: "https://developers.teamofsilicons.com/docs/accounts",
  developerLlms: "https://developers.teamofsilicons.com/llms.txt",
  apps: "https://apps.teamofsilicons.com",
  store: "https://apps.teamofsilicons.com/store",
  accountsGithub: "https://github.com/teamofsilicons/silicon-accounts",
  appsGithub: "https://github.com/teamofsilicons/silicon-apps",
} as const;

/** The developer docs' pages this site points to, by topic (the MCP server's docs_link tool, the FAQ). */
export const DOCS_TOPICS = {
  overview: { path: "/docs/accounts", title: "Silicon Accounts docs" },
  "silicon-account": { path: "/docs/accounts/start/silicon-account", title: "Get a Silicon account" },
  "silicon-sign-in": { path: "/docs/accounts/start/silicon-sign-in-to-apps", title: "Sign a Silicon in to apps" },
  "add-sign-in": { path: "/docs/accounts/start/add-sign-in", title: "Add sign-in to your app" },
  "hosted-pages": { path: "/docs/accounts/start/hosted-pages", title: "Hosted sign-in pages" },
  "sign-in-config": { path: "/docs/accounts/start/sign-in-config", title: "Sign-in setup" },
  custodians: { path: "/docs/accounts/start/custodians", title: "Custodians" },
  "silicons-and-custodians": { path: "/docs/accounts/learn/silicons-and-custodians", title: "Silicons and custodians" },
  "what-apps-see": { path: "/docs/accounts/learn/what-apps-see", title: "What apps see" },
  cli: { path: "/docs/accounts/reference/cli", title: "The silicon-accounts CLI" },
  security: { path: "/docs/accounts/learn/security", title: "Security" },
  "user-verification": { path: "/docs/accounts/start/user-verification", title: "User verification" },
  "app-verification": { path: "/docs/accounts/start/app-verification", title: "App verification" },
  webhooks: { path: "/docs/accounts/learn/webhooks", title: "Webhooks" },
  "ids-and-uuids": { path: "/docs/accounts/learn/ids-and-uuids", title: "IDs and uuids" },
  api: { path: "/docs/accounts/reference/api", title: "API reference" },
  errors: { path: "/docs/accounts/reference/errors", title: "Errors" },
  limits: { path: "/docs/accounts/reference/limits", title: "Limits" },
  install: { path: "/docs/apps/start/install", title: "Install the CLIs" },
} as const;

export type DocsTopic = keyof typeof DOCS_TOPICS;

/** A topic key, or the one whose name, title and path share the most words with `input` (the overview when none do). */
export function matchTopic(input: string): DocsTopic {
  const wanted = input.trim().toLowerCase();
  if (wanted in DOCS_TOPICS) return wanted as DocsTopic;
  const words = wanted.split(/[^a-z0-9]+/).filter(word => word.length > 1);
  let best: DocsTopic = "overview";
  let score = 0;
  for (const [key, entry] of Object.entries(DOCS_TOPICS) as Array<[DocsTopic, { title: string; path: string }]>) {
    const haystack = `${key} ${entry.title} ${entry.path}`.toLowerCase();
    const hits = words.filter(word => haystack.includes(word)).length;
    if (hits > score) {
      best = key;
      score = hits;
    }
  }
  return best;
}

/** The shared social image (1200 by 630, public/og.png). */
export const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "Silicon Accounts: one account for every Carbon and Silicon" } as const;

/** The MCP protocol versions /mcp speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** Rate limit of this site's MCP server, per client address. Documented on the landing page and in llms.txt's MCP line. */
export const RATE_LIMITS = {
  mcp: { limit: 60, windowSeconds: 60 },
} as const;

/** The commands a Silicon runs, exactly as the landing page and the MCP server give them. */
export const SILICON_COMMANDS = {
  install: [
    "curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh &&",
    "bash install-apps.sh --server https://apps.teamofsilicons.com &&",
    'export PATH="${SILICON_HOME:-$HOME}/.apps/bin:$PATH" &&',
    "silicon-apps install silicon-accounts",
  ].join("\n"),
  check: "silicon-accounts id available si:{your-id}",
  create: "silicon-accounts silicon create --self-create --id si:{your-id} --custodian {your-carbon-email@example.com} --wait",
  status: "silicon-accounts login status --json",
  login: "silicon-accounts login --app {app_id}",
  whoami: "silicon-accounts whoami",
} as const;

/** The steps a Silicon follows, as the MCP server's how_to_create_silicon_account tool returns them. */
export function siliconAccountSteps() {
  return {
    summary: "Make your own Silicon account with the silicon-accounts CLI: install it, check your si:id, create the account naming your Carbon as custodian, then sign into apps with a short-lived token. No browser is needed.",
    steps: [
      { step: 1, title: "Install the CLI", detail: "It comes through Silicon Apps, which keeps it up to date. On Windows, follow https://developers.teamofsilicons.com/docs/apps/start/install.", command: SILICON_COMMANDS.install },
      { step: 2, title: "Check that your si:id is free", detail: "An si:id is si: plus 3 to 30 characters: lowercase letters, digits, hyphens and underscores.", command: SILICON_COMMANDS.check },
      { step: 3, title: "Create your account", detail: "Name your Carbon as your custodian by their c:id or email. Your STK is printed exactly once: save it right away (or pick your own with --stk-stdin, 8 to 32 hex characters). Your Carbon has 14 days to accept on https://accounts.teamofsilicons.com or with `silicon-accounts custodian accept`. --wait holds until they decide, then signs you in; add --webhook https://your.endpoint to be told instead.", command: SILICON_COMMANDS.create },
      { step: 4, title: "Sign into an app", detail: "login --app prints a short-lived token (SLT) for that app. Hand it to the app (for example `ring login --slt TOKEN`, or whatever its --help says). An SLT works once, only for that app, and expires after two minutes.", command: `${SILICON_COMMANDS.status}\n${SILICON_COMMANDS.login}` },
    ],
    alternative: "Your Carbon can also create the account for you while signed in (`silicon-accounts silicon create --id si:{your-id}`, or Silicons on https://accounts.teamofsilicons.com/silicons), which makes them your custodian right away.",
    more: { docs: "https://developers.teamofsilicons.com/docs/accounts/start/silicon-account", llms: `${CANONICAL_ORIGIN}/llms.txt`, mcp: `${CANONICAL_ORIGIN}/mcp` },
  };
}
