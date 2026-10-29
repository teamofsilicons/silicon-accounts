/**
 * The public landing page of accounts.teamofsilicons.com (server-rendered), for anyone not signed in. Its structure and
 * layout are in web/redesign/audits/landing.md: a hero that fills the first screen (the pitch beside a sample identity
 * card), then the problem, For Carbons (three reasons and how sign-in goes), what an app sees, For Silicons (three
 * commands), safe by design, questions and a closing call to action. Carbons come first because the hero's one
 * primary action is theirs; a Silicon jumps past them with "I'm a Silicon". Building apps lives on the developer site,
 * reached from the footer. Client code is only Silicon UI's (cards, the accordion, the alert, copy buttons) and the
 * sample card.
 */
import { Fragment, type ReactNode } from "react";
import Image from "next/image";
import { ArrowDown, Bot, Clock, CodeXml, Eye, EyeOff, Fingerprint, KeyRound, RefreshCw, Timer } from "lucide-react";
import { Accordion } from "@teamofsilicons/silicon-ui/accordion";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Card } from "@teamofsilicons/silicon-ui/card";
import { IdentityCardSample } from "@/components/account/identity/sample";
import { Action } from "@/components/site/action";
import { CodeBlock } from "@/components/site/code-block";
import { LINKS, SILICON_COMMANDS } from "@/lib/site";
import styles from "./landing.module.css";

/**
 * Inline code. Short code (a flag, a tool name) never breaks on a phone: "--help" split after its dashes reads as two
 * words. Code too long for a phone's line may break after a "_" or a path's "/" before it breaks anywhere else.
 */
function C({ children }: { children: string }) {
  if (children.length <= 20) return <code data-sq-native="" data-nowrap="">{children}</code>;
  if (children.length <= 26) return <code data-sq-native="">{children}</code>;
  const parts = children.split(/(?<=_)|(?<=[^/:]\/)(?!\/)/);
  return <code data-sq-native="">{parts.map((part, index) => <Fragment key={index}>{index ? <wbr /> : null}{part}</Fragment>)}</code>;
}

/** The small label over a section title, so the page reads as a sequence. */
function SectionHead({ label, title, id, children }: { label: string; title: string; id: string; children?: ReactNode }) {
  return (
    <div className={styles.head}>
      <p className={styles.label}>{label}</p>
      <h2 id={id} className={styles.sectionTitle}>{title}</h2>
      {children}
    </div>
  );
}

/** The two ways in, used by the hero and the closing call to action. */
function WaysIn({ centred }: { centred?: boolean }) {
  return (
    <div className={styles.actions} data-centred={centred ? "" : undefined}>
      <Action href="/sign-in?intent=signup" size="lg">Create your account</Action>
      <a href="#for-silicons" className={styles.quiet}>
        I&apos;m a Silicon
        <ArrowDown size={16} strokeWidth={1.75} aria-hidden="true" />
      </a>
    </div>
  );
}

export interface LandingPageProps {
  /** The developer site (GET /v1/meta `developer_url`). */
  developerUrl: string;
}

export function LandingPage({ developerUrl }: LandingPageProps) {
  return (
    <div className={styles.page}>
      <Hero />
      <Problem />
      <ForCarbons />
      <WhatAppsSee />
      <ForSilicons developerUrl={developerUrl} />
      <Safety />
      <Questions developerUrl={developerUrl} />
      <Closing />
    </div>
  );
}

/* Hero: the first screen ------------------------------------------------------------------------------------------- */

function Hero() {
  return (
    <header className={styles.hero}>
      <div className={`${styles.container} ${styles.heroGrid}`}>
        <div className={styles.heroText}>
          <h1 className={styles.title}>One account for every Carbon and Silicon.</h1>
          <p className={styles.lede}>
            Carbons are people and Silicons are their AI agents. Carbons sign into every app without a password, Silicons
            without a browser.
          </p>
          <WaysIn />
        </div>
        <figure className={styles.heroCard}>
          <IdentityCardSample />
          <figcaption className={styles.caption}>A sample Carbon identity card. Click it to turn it over.</figcaption>
        </figure>
      </div>
    </header>
  );
}

/* The problem ------------------------------------------------------------------------------------------------------ */

function Problem() {
  return (
    <section className={styles.band} aria-labelledby="problem-title">
      <div className={`${styles.container} ${styles.split}`}>
        <SectionHead label="Today" title="Signing in wasn't built for both of you" id="problem-title" />
        <div className={styles.pair}>
          <div className={styles.statement}>
            <KeyRound size={22} strokeWidth={1.75} aria-hidden="true" className={styles.icon} />
            <h3 className={styles.statementTitle}>Carbons</h3>
            <p>A password for every app, and no single place to see which apps know what about you.</p>
          </div>
          <div className={styles.statement}>
            <Bot size={22} strokeWidth={1.75} aria-hidden="true" className={styles.icon} />
            <h3 className={styles.statementTitle}>Silicons</h3>
            <p>Borrowed logins, API keys pasted around, and browsers driven through sign-in pages built for people.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* For Carbons ------------------------------------------------------------------------------------------------------ */

const STEPS_CARBON = [
  { title: "Sign in", text: "With a code by email or phone, or with Google or Apple." },
  { title: "Check what the app gets", text: "The first time, and whenever it asks for more." },
  { title: "You're in", text: "Back in the app, as yourself, with nothing to remember." },
];

function ForCarbons() {
  return (
    <section className={styles.section} id="for-carbons" aria-labelledby="carbons-title">
      <div className={styles.container}>
        <SectionHead label="For Carbons" title="Your account, under your control" id="carbons-title">
          <p className={styles.intro}>One account for every app, and one place to see and stop everything that uses it.</p>
        </SectionHead>
        <div className={styles.cards}>
          <Card
            media={<KeyRound size={28} strokeWidth={1.5} aria-hidden="true" />}
            title="No passwords"
            description="Sign in with Google, Apple, or a code by email or phone. Nothing to remember, nothing to leak."
          />
          <Card
            media={<Eye size={28} strokeWidth={1.5} aria-hidden="true" />}
            title="See and stop what acts as you"
            description="Every app you have signed into, and every app acting for you at another, in one place. Stop any of them."
          />
          <Card
            media={<Bot size={28} strokeWidth={1.5} aria-hidden="true" />}
            title="Look after your Silicons"
            description="A Silicon never holds your password, and apps know it is your Silicon, not you. Rotate its STK or hand it on."
          />
        </div>
        <ol className={styles.flow} role="list" aria-label="How signing in goes">
          {STEPS_CARBON.map(step => (
            <li key={step.title} className={styles.flowStep}>
              <h3 className={styles.flowTitle}>{step.title}</h3>
              <p className={styles.flowText}>{step.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* What an app sees ------------------------------------------------------------------------------------------------- */

function WhatAppsSee() {
  return (
    <section className={styles.section} aria-labelledby="sees-title">
      <div className={`${styles.container} ${styles.showcase}`}>
        <div className={styles.shot} data-sq="surface">
          <Image
            src="/images/landing-consent.png"
            alt="The sign-in screen for an app called Briefcase: it lists name, id and photo, email and date of birth as required, timezone as chosen, and phone number as not shared, above Share and continue."
            width={716}
            height={1300}
            sizes="(min-width: 1024px) 358px, 80vw"
            className={styles.shotImage}
          />
        </div>
        <div className={styles.showcaseText}>
          <SectionHead label="Before you share" title="You see exactly what an app gets" id="sees-title" />
          <ul className={styles.facts} role="list">
            <li>Each app asks for the details it needs. Required ones are marked; optional ones start unticked.</li>
            <li>You see the screen the first time you sign in, and again whenever the app asks for more.</li>
            <li>Remove an app&apos;s access any time, from your account.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/* For Silicons ----------------------------------------------------------------------------------------------------- */

function ForSilicons({ developerUrl }: { developerUrl: string }) {
  return (
    <section className={styles.band} id="for-silicons" aria-labelledby="silicons-title">
      <div className={`${styles.container} ${styles.split}`}>
        <div className={styles.sticky}>
          <SectionHead label="For Silicons" title="Three commands, about a minute" id="silicons-title">
            <p className={styles.intro}>Sign in as yourself, not with your Carbon&apos;s logins or a browser built for people.</p>
          </SectionHead>
          <p className={styles.note}>
            Would your Carbon rather do it? Signed in here, they can create the account for you, which makes them your
            custodian right away; or they accept your request here or with <C>silicon-accounts custodian accept</C>.
            Everything else is in <a href={`${developerUrl}/docs/accounts/start/silicon-account`} rel="noopener">the Silicon account guide</a>.
          </p>
          <p className={styles.note}>
            Reading this as code? Start at <a href="/llms.txt">/llms.txt</a> (all of it at <a href="/llms-full.txt">/llms-full.txt</a>),
            the Accounts API at <C>/v1</C> (<a href="/openapi.json">spec</a>),{" "}
            <a href="/.well-known/openid-configuration">OpenID Connect discovery</a> or the{" "}
            <a href="/.well-known/agent.json">agent card</a>. Every command explains itself with <C>--help</C>.
          </p>
        </div>
        <ol className={styles.steps} role="list">
          <li className={styles.step}>
            <h3 className={styles.stepTitle}>Install the CLI</h3>
            <p className={styles.stepText}>
              On Windows, follow <a href={`${developerUrl}/docs/apps/start/install`}>the install guide</a>.
            </p>
            <CodeBlock code={SILICON_COMMANDS.install} title="macOS and Linux" wrap />
          </li>
          <li className={styles.step}>
            <h3 className={styles.stepTitle}>Create your account</h3>
            <p className={styles.stepText}>
              Check your si:id is free (like <C>si:head_of_growth</C>), then name your Carbon as your custodian by their c:id
              or email. <C>--wait</C> signs you in the moment they accept.
            </p>
            <CodeBlock code={`${SILICON_COMMANDS.check}\n${SILICON_COMMANDS.create.replace(" --custodian", " \\\n  --custodian")}`} title="Create your account" />
            <Alert tone="warning" title="Save your STK right away">
              Your STK is your password. It is printed exactly once.
            </Alert>
          </li>
          <li className={styles.step}>
            <h3 className={styles.stepTitle}>Sign into an app</h3>
            <p className={styles.stepText}>
              <C>login --app</C> prints a one-time sign-in token (an SLT) for that app. Hand it over, for example{" "}
              <C>ring login --slt TOKEN</C>. It works once, for two minutes, and the app never sees your STK.
            </p>
            <CodeBlock code={`${SILICON_COMMANDS.status}\n${SILICON_COMMANDS.login.replace("{app_id}", "ring")}`} title="Sign into Ring" />
          </li>
        </ol>
      </div>
    </section>
  );
}

/* Safe by design --------------------------------------------------------------------------------------------------- */

const SAFETY = [
  { icon: Timer, title: "Codes expire in 10 minutes", text: "Sending them is rate-limited, and wrong tries pause after 10." },
  { icon: EyeOff, title: "An STK is shown once", text: "Only its hash is kept; your Carbon can rotate it at any time." },
  { icon: Fingerprint, title: "Apps never get a password", text: "They know you by a uuid that never changes." },
  { icon: Clock, title: "Short-lived access", text: "An app's access token lasts 30 minutes." },
  { icon: RefreshCw, title: "Your id can change", text: "Every change reaches the apps you use; your old id waits 10 days for you." },
  { icon: CodeXml, title: "Open source", text: "The code is on GitHub, under the MIT licence." },
];

function Safety() {
  return (
    <section className={styles.section} aria-labelledby="safety-title">
      <div className={`${styles.container} ${styles.split}`}>
        <SectionHead label="Safe by design" title="Built so nothing happens without you" id="safety-title">
          <p className={styles.intro}>
            Read every rule in <a href={LINKS.accountsGithub} rel="noopener">the code</a>.
          </p>
        </SectionHead>
        <ul className={styles.safety} role="list">
          {SAFETY.map(({ icon: Icon, title, text }) => (
            <li key={title} className={styles.safetyItem}>
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" className={styles.icon} />
              <h3 className={styles.safetyTitle}>{title}</h3>
              <p className={styles.safetyText}>{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* Questions -------------------------------------------------------------------------------------------------------- */

function Questions({ developerUrl }: { developerUrl: string }) {
  const items = [
    { title: "What are Carbons and Silicons?", content: <p>A Carbon is a person and a Silicon is an AI agent. Each has one personal account here, and every Silicon has exactly one Carbon who looks after it, its custodian.</p> },
    { title: "What does an app get?", content: <p>Only the details it asks for and you agree to share, shown on one screen before you continue. Your name, id and photo always; email, phone, date of birth or timezone only when the app asks.</p> },
    { title: "What if I lose access to my email?", content: <p>Add up to 10 emails and 10 phone numbers. Any of them signs you into the same account.</p> },
    { title: "Can I change my id?", content: <p>Yes, any time. Your old id stays reserved for you for 10 days, and every app you use is told about the change.</p> },
    { title: "What happens to my Silicon if I hand it over?", content: <p>You transfer it to another Carbon, who becomes its custodian. The Silicon keeps its account and its id.</p> },
    { title: "How does a Silicon sign in without a browser?", content: <p>With its si:id and STK through the Accounts CLI or package, which gives it a one-time token for the app. It never sees an app&apos;s sign-in page.</p> },
  ];
  return (
    <section className={styles.section} aria-labelledby="questions-title">
      <div className={`${styles.container} ${styles.split}`}>
        <SectionHead label="Questions" title="Before you start" id="questions-title">
          <p className={styles.intro}>
            More in <a href={`${developerUrl}/docs/accounts`} rel="noopener">the docs</a>.
          </p>
        </SectionHead>
        <div className={styles.accordion}>
          <Accordion items={items} size="lg" />
        </div>
      </div>
    </section>
  );
}

/* Closing call to action ------------------------------------------------------------------------------------------- */

function Closing() {
  return (
    <section className={styles.section} aria-labelledby="closing-title">
      <div className={styles.container}>
        <div className={styles.closing} data-sq="surface">
          <h2 id="closing-title" className={styles.closingTitle}>One account, for you and your Silicons.</h2>
          <p className={styles.closingText}>It takes a minute, with no password to make up.</p>
          <WaysIn centred />
        </div>
      </div>
    </section>
  );
}
