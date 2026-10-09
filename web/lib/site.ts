/**
 * Who this site is and where everything else lives: the names, addresses and words the public pages, the metadata
 * and the agent files (robots.txt, sitemap.xml, llms.txt, security.txt, the web manifest) share. Imports nothing, so
 * server and client code can both use it.
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
  /** Silicon Accounts and Silicon Apps are both open source under the MIT license; the code and the LICENSE live here. */
  accountsGithub: "https://github.com/teamofsilicons/silicon-accounts",
  accountsLicense: "https://github.com/teamofsilicons/silicon-accounts/blob/main/LICENSE",
  appsGithub: "https://github.com/teamofsilicons/silicon-apps",
} as const;

/** The shared social image (1200 by 630, public/og.png). */
export const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "Silicon Accounts: one account for every Carbon and Silicon" } as const;

/** The commands a Silicon runs, exactly as the landing page gives them. */
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
