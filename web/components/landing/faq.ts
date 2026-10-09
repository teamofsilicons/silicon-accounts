/**
 * The landing page's questions, in the Carbon's words (web/llms/llms.md and UNDERSTANDING.md), shared by the FAQ
 * section and its FAQPage JSON-LD. Answers are plain text; `code` in backticks and https:// links are formatted where
 * they are shown.
 */

export interface Faq {
  id: string;
  question: string;
  answer: string;
}

export const FAQ: Faq[] = [
  {
    id: "what-is-it",
    question: "What is Silicon Accounts?",
    answer: "The account system of the Silicon ecosystem. Every Carbon (a person) and every Silicon (an agent) gets one personal account here, and carries it into every app they use. Carbons are shown as c:{handle}, like c:shubham, and Silicons as si:{handle}, like si:head_of_growth.",
  },
  {
    id: "why-silicon-account",
    question: "Why should a Silicon have its own account?",
    answer: "So it stops borrowing its Carbon's logins, pasting API keys around, or driving a browser through sign-in pages built for people. With its own si:id, apps know it as itself, not as its Carbon. It signs into any app in the ecosystem with a short-lived token, without a browser, and the app never sees its STK.",
  },
  {
    id: "create-silicon-account",
    question: "How does a Silicon make its account?",
    answer: "Install the CLI, then run `silicon-accounts silicon create --self-create --id si:{your-id} --custodian {your-carbon-email@example.com} --wait`. Your STK is printed exactly once, so save it right away. Your Carbon accepts once, and from then on you act on your own.",
  },
  {
    id: "needs-a-carbon",
    question: "Does a Silicon need a Carbon?",
    answer: "Yes, every Silicon has exactly one custodian, and it's only needed once. A Silicon that makes its own account names its custodian by their c:id or email, and the Carbon has 14 days to accept. A Carbon can also create the Silicon itself, which makes them its custodian right away.",
  },
  {
    id: "stk-and-slt",
    question: "What are the STK and the SLT?",
    answer: "The STK is a Silicon's password. Only the Silicon and Silicon Accounts ever see it, and its custodian can rotate it at any time, which stops the old one working. An SLT is a short-lived token a Silicon asks us for, made for one app: it works once, only for that app, and expires after two minutes.",
  },
  {
    id: "no-passwords",
    question: "Do I need a password?",
    answer: "No. A Carbon signs in with Google, Apple, or a 6 digit code we send by email or text message. There is no password to remember or to leak.",
  },
  {
    id: "what-apps-see",
    question: "What does an app see about me?",
    answer: "Your name, your c:id or si:id, your uuid and your profile photo. An app can also ask for your email, phone number, date of birth or timezone. We show you exactly what it asks for before you share it, optional details stay unticked until you tick them, and you can remove an app's access at any time.",
  },
  {
    id: "change-id",
    question: "Can I change my c:id or si:id?",
    answer: "Yes. Your uuid never changes, and apps know you by it. Your c:id or si:id is yours to change: the old one stays reserved for you for 10 days, and every app you use hears about the change.",
  },
  {
    id: "stop-a-silicon",
    question: "How do I stop a Silicon or an app?",
    answer: "On https://accounts.teamofsilicons.com you see every app you signed into and can remove any of them, see and revoke every User verification issued on your behalf, and rotate a Silicon's STK, so the old one stops working at once. You can also transfer a Silicon to another Carbon, who accepts before it moves.",
  },
  {
    id: "building-an-app",
    question: "I'm building an app. Where do I start?",
    answer: "On the developer site: https://developers.teamofsilicons.com/docs/accounts. Adding sign-in for Carbons and Silicons, verifying requests between apps and webhooks all live there.",
  },
  {
    id: "agents-without-browser",
    question: "Can an agent use this site without a browser?",
    answer: "Yes. Read /llms.txt, call the API described in /openapi.json, or read the agent card at /.well-known/agent.json. Errors always say what went wrong and how to fix it.",
  },
  {
    id: "open-source",
    question: "Is Silicon Accounts open source?",
    answer: "Yes. Silicon Accounts is open source (MIT), and so is Silicon Apps. You can read every line that handles your account, and fixes are welcome: https://github.com/teamofsilicons/silicon-accounts and https://github.com/teamofsilicons/silicon-apps.",
  },
  {
    id: "report",
    question: "Something is broken. How do I tell you?",
    answer: "Run `silicon-accounts report \"<what happened>\"`, with `--pr <link>` if you've already patched it. Every report reaches the Team. Silicon Accounts is open source (MIT), so you can send the fix yourself: https://github.com/teamofsilicons/silicon-accounts.",
  },
];

/** The answer as plain text for JSON-LD: backticks dropped. */
export const plainAnswer = (faq: Faq) => faq.answer.replace(/`/g, "");
