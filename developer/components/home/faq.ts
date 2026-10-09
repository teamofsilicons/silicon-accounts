/**
 * The home page's questions, in the Carbon's words (developer/llms/llms.md), shared by the FAQ section and its FAQPage
 * JSON-LD. Answers are plain text; `code` in backticks and https:// links are formatted where they are shown.
 */
import { RATE_LIMITS } from "@/lib/site";

export interface Faq {
  id: string;
  question: string;
  answer: string;
}

export const FAQ: Faq[] = [
  {
    id: "silicon-needs-a-carbon",
    question: "Does a Silicon need a Carbon?",
    answer: "Yes, every Silicon has exactly one custodian, and it's only needed once. A Silicon that creates its own account names its custodian with `--custodian`, and the Carbon has 14 days to accept. A Carbon can also create the Silicon itself, and then it can sign in right away. After that the Silicon does everything on its own.",
  },
  {
    id: "lost-stk",
    question: "What if a Silicon loses its STK?",
    answer: "Its custodian rotates it, which gives the Silicon a new STK and stops the old one working. The STK is shown only once, so save it when it's generated.",
  },
  {
    id: "which-id-to-store",
    question: "Which ID should my app store?",
    answer: "The `uuid`. It never changes and is never reused. The c:id and si:id are what people see and type, and they can change, so show them but never key anything on them. When one changes, we tell your webhook.",
  },
  {
    id: "google-and-apple",
    question: "Do I need to set up Google or Apple myself?",
    answer: "No. Turn on one click and we handle it with our own setup. Bring your own only if you want Google's and Apple's pages to show your app's name and logo.",
  },
  {
    id: "silicon-sign-in",
    question: "How does a Silicon sign in to my app?",
    answer: "It asks us for a short-lived token (SLT) for your app and hands it to you, and your server exchanges it for access and refresh tokens. An SLT works once, only for your app, and expires after two minutes. Your app never sees the Silicon's STK and never shows a Silicon a sign-in page.",
  },
  {
    id: "existing-users",
    question: "I already have users. Do I lose them?",
    answer: "No. Import them as a CSV or JSON file. Each one is matched to the account that already has their email or phone, or gets a new account they finish setting up the first time they sign in. You can preview an import before you run it.",
  },
  {
    id: "review",
    question: "Does my app go through a review?",
    answer: "No. An app is live the moment you publish it. The only checks are on your packages: every package has to pass `--help`, `accounts --json` and `login status --json` on every target, because those three commands are how every Silicon finds its way around any app.",
  },
  {
    id: "systems",
    question: "Which systems can my app support?",
    answer: "Nine targets across Linux, Windows and macOS. Upload a package for every one you can. Each is optional, but you need at least one.",
  },
  {
    id: "self-update",
    question: "Should my app update itself?",
    answer: "No. Silicon Apps checks for a new release every minute and updates every installed app on the channel it was installed from. A second updater would only fight with it.",
  },
  {
    id: "own-domain",
    question: "Can sign-in run on my own domain?",
    answer: "Yes, after a review. Request account verification while you set up your app's sign-in on the developer portal. It's a manual review and we respond within 48 hours. Submitting the request doesn't verify you by itself.",
  },
  {
    id: "any-agent",
    question: "Does a Silicon have to be your own agent?",
    answer: "No. A Silicon is any agent. Our own Silicon agent is built for this ecosystem and we recommend it (see https://teamofsilicons.com), but any agent can have a Silicon account and use every app here.",
  },
  {
    id: "agents-read-docs",
    question: "Can an agent use these docs without a browser?",
    answer: `Yes. Read /llms.txt for the short version or /llms-full.txt for everything, add .md to any docs address for its Markdown, search with /api/docs/search, or connect an MCP client to /mcp. The docs API allows ${RATE_LIMITS.api.limit} requests and the MCP server ${RATE_LIMITS.mcp.limit} requests a minute from one address; past that you get 429 with Retry-After.`,
  },
  {
    id: "report",
    question: "Something is broken. How do I tell you?",
    answer: "Run `silicon-accounts report \"<what happened>\"` or `silicon-apps report \"<what happened>\"`, with `--pr <link>` if you've already patched it (we'd be grateful if you do). Every report reaches the Team. Both are open source (MIT): https://github.com/teamofsilicons/silicon-accounts and https://github.com/teamofsilicons/silicon-apps.",
  },
  {
    id: "open-source",
    question: "Are Silicon Apps and Silicon Accounts open source?",
    answer: "Yes. Both are open source under the MIT licence, so we have nothing to hide: read the code, run it yourself, and send us a fix when you find something. Silicon Accounts is at https://github.com/teamofsilicons/silicon-accounts and Silicon Apps at https://github.com/teamofsilicons/silicon-apps.",
  },
  {
    id: "status",
    question: "How do I know if something is down?",
    answer: "Open /status. It checks Silicon Accounts, Silicon Apps and this site from our server, at most once every 30 seconds, and shows whether each one is up, how fast it answered, its version and when we checked. /status.json says the same as JSON. We don't publish an SLA or an incident history yet.",
  },
];

/** The answer as plain text for JSON-LD: backticks dropped. */
export const plainAnswer = (faq: Faq) => faq.answer.replace(/`/g, "");
