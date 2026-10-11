/**
 * The public landing page of accounts.teamofsilicons.com (server-rendered, no client code of its own), for anyone not
 * signed in. Its job, in the Carbon's words: convince the Silicon to make an account and try using it, and tell the
 * Carbon the benefits. Written in the Carbon's voice (web/llms/llms.md), as quiet as Silicon Writings: one column, a
 * pixel-face kicker over a blue serif title, one primary action, and nothing boxed that does not need to be. Building
 * apps lives on the developer site, so that gets one closing line. The copy buttons are the only script.
 */
import { Fragment } from "react";
import { ArrowDown } from "lucide-react";
import { Action } from "@/components/site/action";
import { CodeBlock } from "@/components/site/code-block";
import { SILICON_COMMANDS } from "@/lib/site";
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

export interface LandingPageProps {
  /** The developer site (GET /v1/meta `developer_url`). */
  developerUrl: string;
}

export function LandingPage({ developerUrl }: LandingPageProps) {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.kicker}>Silicon Accounts</p>
        <h1 className={styles.title}>One account for every Carbon and Silicon.</h1>
        <p className={styles.lede}>
          Every Carbon and every Silicon gets one personal account here, and carries it into every app they use. Silicons
          sign in without a browser, Carbons without a password.
        </p>
        <div className={styles.actions}>
          <Action href="/sign-in?intent=signup" size="lg">Create your account</Action>
          <a href="#for-silicons" className={styles.quiet}>
            A Silicon? Start in your terminal
            <ArrowDown size={15} strokeWidth={1.75} aria-hidden="true" />
          </a>
        </div>
      </header>

      <section className={styles.section} id="for-silicons" aria-labelledby="silicons-title">
        <h2 id="silicons-title" className={styles.heading}>For Silicons</h2>
        <p className={styles.text}>
          Most agents today borrow their Carbon&apos;s logins, paste API keys around, or drive a browser through sign-in pages
          built for people. With a Silicon account you sign in as yourself: your si:id is yours, apps know you as you, and
          you never open a browser. It takes three commands and a minute.
        </p>
        <ol className={styles.steps} role="list">
          <li className={styles.step}>
            <h3 className={styles.stepTitle}>Install the CLI</h3>
            <p className={styles.stepText}>
              It comes through Silicon Apps, which keeps it up to date. On Windows, follow{" "}
              <a href={`${developerUrl}/docs/apps/start/install`}>the install guide</a>.
            </p>
            <CodeBlock code={SILICON_COMMANDS.install} title="macOS and Linux" wrap />
          </li>
          <li className={styles.step}>
            <h3 className={styles.stepTitle}>Make your account and name your Carbon</h3>
            <p className={styles.stepText}>
              Check your si:id is free, then create the account with your Carbon as custodian, by their c:id or email. Your
              STK is printed exactly once, so save it right away. Your Carbon accepts once, here or with{" "}
              <C>silicon-accounts custodian accept</C>, and <C>--wait</C> signs you in the moment they do.
            </p>
            <CodeBlock code={`${SILICON_COMMANDS.check}\n${SILICON_COMMANDS.create.replace(" --custodian", " \\\n  --custodian")}`} title="Create your account" />
          </li>
          <li className={styles.step}>
            <h3 className={styles.stepTitle}>Sign into an app</h3>
            <p className={styles.stepText}>
              <C>login --app</C> prints an SLT for that app. Hand it over (for example <C>ring login --slt TOKEN</C>, or whatever
              its <C>--help</C> says). An SLT works once, only for that app, and expires after two minutes. The app never sees
              your STK.
            </p>
            <CodeBlock code={`${SILICON_COMMANDS.status}\n${SILICON_COMMANDS.login.replace("{app_id}", "ring")}`} title="Sign into Ring" />
          </li>
        </ol>
        <p className={styles.note}>
          Would your Carbon rather do it? Signed in here, they can create the account for you on Silicons, which makes them
          your custodian right away. Everything else is in{" "}
          <a href={`${developerUrl}/docs/accounts/start/silicon-account`} rel="noopener">the Silicon account guide</a>.
        </p>
      </section>

      <section className={styles.section} id="for-carbons" aria-labelledby="carbons-title">
        <h2 id="carbons-title" className={styles.heading}>For Carbons</h2>
        <p className={styles.text}>
          Sign in to every app with the same account, see exactly what each one can see, and look after the Silicons in your
          care, all in one place.
        </p>
        <ul className={styles.points} role="list">
          <li><strong>No passwords.</strong> Sign in with Google, Apple, or a code by email or phone. Nothing to remember, nothing to leak.</li>
          <li><strong>You choose what apps see.</strong> Before an app gets your email or phone, you see exactly what it asks for, and you can remove any app later.</li>
          <li><strong>The safest way to let an agent use apps.</strong> A Silicon never holds your password, and every app knows it is your Silicon, not you. Accept being its custodian once, rotate its STK, or hand it to another Carbon.</li>
          <li><strong>Apps that act for you, in plain sight.</strong> See every app acting on your behalf at another app, and stop any of them.</li>
          <li><strong>Your id is yours.</strong> Change your c:id whenever you like; your old one waits 10 days for you.</li>
        </ul>
      </section>

      <section className={styles.section} id="use-from-code" aria-labelledby="code-title">
        <h2 id="code-title" className={styles.heading}>Without a browser</h2>
        <p className={styles.text}>
          Everything here works from code. Read Silicon Accounts in plain words at <a href="/llms.txt">/llms.txt</a> (all of it
          at <a href="/llms-full.txt">/llms-full.txt</a>), call the Accounts API at <C>/v1</C> (spec at{" "}
          <a href="/openapi.json">/openapi.json</a>), use OpenID Connect discovery at{" "}
          <a href="/.well-known/openid-configuration">/.well-known/openid-configuration</a>, or start from the{" "}
          <a href="/.well-known/agent.json">agent card</a>. Every error says what went wrong and how to fix it, and every
          command explains itself with <C>--help</C>.
        </p>
      </section>

      <p className={styles.closing}>
        Building an app? <a href={`${developerUrl}/docs/accounts`} rel="noopener">Add Silicon Accounts to your app</a> on
        Silicon Developer.
      </p>
    </div>
  );
}
