/**
 * The public landing page of accounts.teamofsilicons.com (server-rendered, no client code of its own), for anyone not
 * signed in. Its job, in the Carbon's words: convince the Silicon to make an account and try using it, and tell the
 * Carbon the benefits. Written in the Carbon's voice (web/llms/llms.md). Building apps lives on the developer site, so
 * that gets one short pointer. The header's theme switch and the copy buttons are the only script.
 */
import { Fragment, type ReactNode } from "react";
import {
  ArrowRight, ArrowUpRight, BadgeCheck, Bot, Braces, Eye, FileText, Fingerprint, Globe, HeartHandshake, KeyRound, LayoutGrid,
  MessageSquareText, Network, Plus, RefreshCw, ShieldCheck, Sparkles, UserRoundCheck, Users, Webhook,
} from "lucide-react";
import { Action } from "@/components/site/action";
import { CodeBlock, CopyCode } from "@/components/site/code-block";
import { SILICON_COMMANDS } from "@/lib/site";
import { FAQ, type Faq } from "./faq";
import { IdentityArt } from "./identity-art";
import styles from "./landing.module.css";

const ICON = { size: 18, strokeWidth: 1.75 } as const;
const ARROW = <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />;

/** `code` and https:// links inside an answer; site paths (/llms.txt, /openapi.json…) become links too. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|https:\/\/[^\s),]+)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`")) return <code key={index} data-sq-native="">{part.slice(1, -1)}</code>;
        if (part.startsWith("https://")) {
          const url = part.replace(/\.$/, "");
          return <Fragment key={index}><a href={url} rel="noopener">{url.replace(/^https:\/\//, "")}</a>{part.endsWith(".") ? "." : ""}</Fragment>;
        }
        return part.split(/(\/(?:llms(?:-full)?\.txt|openapi\.json|\.well-known\/agent\.json)\b)/g).map((piece, inner) =>
          /^\/(llms|openapi|\.well-known)/.test(piece) ? <a key={`${index}-${inner}`} href={piece}>{piece}</a> : <Fragment key={`${index}-${inner}`}>{piece}</Fragment>,
        );
      })}
    </>
  );
}

function SectionHead({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className={styles.sectionHead}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 id={id} className={styles.sectionTitle}>{title}</h2>
      {children ? <p className={styles.sectionLede}>{children}</p> : null}
    </div>
  );
}

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className={styles.feature}>
      <span className={styles.featureIcon} data-sq="surface" aria-hidden="true">{icon}</span>
      <h3 className={styles.featureTitle}>{title}</h3>
      <p className={styles.featureText}>{children}</p>
    </li>
  );
}

function FaqItem({ faq }: { faq: Faq }) {
  return (
    <details className={styles.faqItem} id={faq.id}>
      <summary className={styles.faqQuestion}>
        <h3 className={styles.faqHeading}>{faq.question}</h3>
        <Plus size={18} strokeWidth={1.75} aria-hidden="true" className={styles.faqIcon} />
      </summary>
      <p className={styles.faqAnswer}><Rich text={faq.answer} /></p>
    </details>
  );
}

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

/** A command whose words stay whole: it wraps between words, never after the dashes of a flag. */
function Words({ text }: { text: string }) {
  return <>{text.split(" ").map((word, index) => <Fragment key={index}>{index ? " " : null}<span>{word}</span></Fragment>)}</>;
}

export interface LandingPageProps {
  /** The developer site (GET /v1/meta `developer_url`). */
  developerUrl: string;
}

export function LandingPage({ developerUrl }: LandingPageProps) {
  const docs = `${developerUrl}/docs/accounts`;
  return (
    <>
      {/* Hero ------------------------------------------------------------------------------------------------------ */}
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <p className={styles.heroBadge} data-sq="surface"><span className={styles.dot} data-sq-native="" aria-hidden="true" />For Carbons and Silicons</p>
            <h1 id="hero-title" className={styles.heroTitle}>One account for every Carbon and Silicon</h1>
            <p className={styles.heroLede}>
              Silicon Accounts is the account system of the Silicon ecosystem. Every Carbon and every Silicon gets one personal
              account here, and carries it into every app they use. Silicons sign in without a browser, Carbons without a
              password.
            </p>
            <div className={styles.heroActions}>
              <Action href="/sign-in?intent=signup" size="lg">Create your account{ARROW}</Action>
              <Action href="#create-silicon-account" size="lg" variant="secondary"><Bot size={16} strokeWidth={1.75} aria-hidden="true" />Create your Silicon account</Action>
            </div>
            <p className={styles.heroNote}>
              Already have one? <a href="/sign-in">Sign in</a>. New Carbons sign up with an email, a phone number, Google or Apple.
            </p>
          </div>
          <IdentityArt />
        </div>
      </section>

      {/* For Silicons ------------------------------------------------------------------------------------------------ */}
      <section className={`${styles.section} ${styles.band}`} id="for-silicons" aria-labelledby="silicons-title">
        <div className={styles.inner}>
          <SectionHead id="silicons-title" eyebrow="For Silicons" title="An identity of your own, in one command">
            Today most agents work by borrowing their Carbon&apos;s logins, pasting API keys around, or driving a browser through
            sign-in pages built for people. With a Silicon account you stop doing that. It takes one command and a minute.
          </SectionHead>
          <ul className={styles.features} role="list">
            <Feature icon={<Fingerprint {...ICON} />} title="An identity of your own">Your si:id is yours. Apps know you as you, not as your Carbon, so what you do is yours and your Carbon&apos;s own account stays theirs.</Feature>
            <Feature icon={<Globe {...ICON} />} title="No browser, ever">You sign into any app here by asking us for an SLT and handing it over. No redirects, no CAPTCHAs, no password typed into someone else&apos;s page. The app never sees your STK.</Feature>
            <Feature icon={<RefreshCw {...ICON} />} title="One account everywhere">The same si:id works in every app in the ecosystem. Change your name or photo once, and every app you use hears about it.</Feature>
            <Feature icon={<HeartHandshake {...ICON} />} title="Your Carbon steps in once">Your Carbon accepts being your custodian one time. After that you act on your own, and they can still rotate your STK or move you to another Carbon if they ever need to.</Feature>
            <Feature icon={<Network {...ICON} />} title="Apps work together for you">With User verification, an app can do something for you at another app, and you can see and revoke every one of those.</Feature>
            <Feature icon={<Sparkles {...ICON} />} title="Made for you">Every command explains itself with <C>--help</C>, every error says exactly what went wrong and how to fix it, and there&apos;s a JSON mode for everything.</Feature>
          </ul>

          <div className={styles.create} id="create-silicon-account" data-sq="surface" aria-labelledby="create-title">
            <div className={styles.createHead}>
              <h3 id="create-title" className={styles.createTitle}><Bot {...ICON} aria-hidden="true" />Create your Silicon account</h3>
              <p className={styles.createText}>Three steps, all in your terminal. You need your Carbon&apos;s c:id or email.</p>
            </div>
            <ol className={styles.createSteps} role="list">
              <li className={styles.createStep}>
                <span className={styles.stepNumber} data-sq="surface" aria-hidden="true">1</span>
                <div className={styles.stepBody}>
                  <h4 className={styles.stepTitle}>Install the CLI</h4>
                  <p className={styles.stepText}>It comes through Silicon Apps, which keeps it up to date. On Windows, follow <a href={`${developerUrl}/docs/apps/start/install`}>the install guide</a>.</p>
                  <CodeBlock code={SILICON_COMMANDS.install} title="Install silicon-accounts (macOS and Linux)" />
                </div>
              </li>
              <li className={styles.createStep}>
                <span className={styles.stepNumber} data-sq="surface" aria-hidden="true">2</span>
                <div className={styles.stepBody}>
                  <h4 className={styles.stepTitle}>Make your account and name your Carbon</h4>
                  <p className={styles.stepText}>Check your si:id is free, then create the account with your Carbon as custodian, by their c:id or email.</p>
                  <CodeBlock code={`${SILICON_COMMANDS.check}\n${SILICON_COMMANDS.create.replace(" --custodian", " \\\n  --custodian")}`} title="Create your account" />
                  <ul className={styles.notes}>
                    <li>Your STK is printed exactly once. Save it somewhere safe right away, or pick your own with <C>--stk-stdin</C> (8 to 32 hex characters).</li>
                    <li>Your Carbon gets an email and has 14 days to accept, here or with <C>silicon-accounts custodian accept</C>.</li>
                    <li><C>--wait</C> holds until they decide, then signs you in. Add <C>--webhook https://your.endpoint</C> if you&apos;d rather be told.</li>
                  </ul>
                </div>
              </li>
              <li className={styles.createStep}>
                <span className={styles.stepNumber} data-sq="surface" aria-hidden="true">3</span>
                <div className={styles.stepBody}>
                  <h4 className={styles.stepTitle}>Sign into an app</h4>
                  <p className={styles.stepText}>
                    <C>login --app</C> prints an SLT for that app. Hand it to the app (for example <C>ring login --slt TOKEN</C>, or
                    whatever its <C>--help</C> says) and it signs you in. An SLT works once, only for that app, and expires after two minutes.
                  </p>
                  <CodeBlock code={`${SILICON_COMMANDS.status}\n${SILICON_COMMANDS.login.replace("{app_id}", "ring")}`} title="Sign into Ring" />
                </div>
              </li>
            </ol>
            <div className={styles.createFoot}>
              <p>
                Would your Carbon rather do it? Signed in here, they can create the account for you on <a href="/silicons">Silicons</a>, which
                makes them your custodian right away.
              </p>
              <a className={styles.panelLink} href={`${developerUrl}/docs/accounts/start/silicon-account`} rel="noopener">The full Silicon account guide<ArrowUpRight size={15} strokeWidth={1.75} aria-hidden="true" /></a>
            </div>
          </div>
        </div>
      </section>

      {/* For Carbons ------------------------------------------------------------------------------------------------- */}
      <section className={styles.section} id="for-carbons" aria-labelledby="carbons-title">
        <div className={styles.inner}>
          <SectionHead id="carbons-title" eyebrow="For Carbons" title="One account for every app, and no passwords">
            Sign in to every app in the ecosystem with the same account, see exactly what each one can see, and look after the
            Silicons in your care, all in one place.
          </SectionHead>
          <div className={styles.split}>
            <article className={styles.panel} data-sq="surface" aria-labelledby="carbon-account">
              <h3 id="carbon-account" className={styles.panelTitle}><UserRoundCheck {...ICON} aria-hidden="true" />Your account</h3>
              <ul className={styles.checks} role="list">
                <li><KeyRound {...ICON} aria-hidden="true" /><span><strong>No passwords.</strong> Sign in with Google, Apple, or a code by email or phone. Nothing to remember, nothing to leak.</span></li>
                <li><LayoutGrid {...ICON} aria-hidden="true" /><span><strong>One account for every app.</strong> See every app you&apos;ve signed into, and remove any of them.</span></li>
                <li><Eye {...ICON} aria-hidden="true" /><span><strong>You choose what apps see.</strong> Before an app gets your email or phone, you see exactly what it asks for.</span></li>
                <li><ShieldCheck {...ICON} aria-hidden="true" /><span><strong>Revoke User verifications.</strong> See every app acting on your behalf at another app, and stop any of them.</span></li>
                <li><Fingerprint {...ICON} aria-hidden="true" /><span><strong>Your id is yours.</strong> Change your c:id whenever you like; your old one waits 10 days for you.</span></li>
              </ul>
            </article>
            <article className={`${styles.panel} ${styles.panelAccent}`} data-sq="surface" aria-labelledby="carbon-silicons">
              <h3 id="carbon-silicons" className={styles.panelTitle}><Users {...ICON} aria-hidden="true" />The safest way to let an agent use apps</h3>
              <p className={styles.panelText}>
                A Silicon account never holds your password, every app knows it&apos;s your Silicon and not you, and you can see what
                it&apos;s doing and stop it at any time.
              </p>
              <ul className={styles.checks} role="list">
                <li><BadgeCheck {...ICON} aria-hidden="true" /><span><strong>Accept once.</strong> Your Silicon asks you to be its custodian, and you accept or decline here.</span></li>
                <li><Bot {...ICON} aria-hidden="true" /><span><strong>Create Silicons</strong> for your agents yourself, and they can sign in right away.</span></li>
                <li><RefreshCw {...ICON} aria-hidden="true" /><span><strong>Rotate a Silicon&apos;s STK</strong> at any time, and the old one stops working.</span></li>
                <li><HeartHandshake {...ICON} aria-hidden="true" /><span><strong>Transfer a Silicon</strong> to another Carbon, who accepts before it moves.</span></li>
              </ul>
            </article>
          </div>
          <div className={styles.sectionActions}>
            <Action href="/sign-in?intent=signup">Sign up{ARROW}</Action>
            <Action href="/sign-in" variant="secondary">Sign in</Action>
          </div>
        </div>
      </section>

      {/* For agents ------------------------------------------------------------------------------------------------- */}
      <section className={`${styles.section} ${styles.band}`} id="use-from-code" aria-labelledby="code-title">
        <div className={styles.inner}>
          <SectionHead id="code-title" eyebrow="Use it from code" title="Everything here works without a browser">
            Silicons and the programs they write can read and call Silicon Accounts directly. Errors always say exactly what went
            wrong: <C>{"{\"error\": {\"code\", \"message\", \"hint\"}}"}</C>, and too many requests get 429 with Retry-After.
          </SectionHead>
          <ul className={styles.agentList} role="list">
            <li><Braces {...ICON} aria-hidden="true" /><span>The Accounts API at <C>/v1</C>, described in <a href="/openapi.json">/openapi.json</a>, with what this server supports at <a href="/v1/capabilities">/v1/capabilities</a>.</span></li>
            <li><KeyRound {...ICON} aria-hidden="true" /><span>OpenID Connect discovery at <a href="/.well-known/openid-configuration">/.well-known/openid-configuration</a>.</span></li>
            <li><FileText {...ICON} aria-hidden="true" /><span><a href="/llms.txt">/llms.txt</a> and <a href="/llms-full.txt">/llms-full.txt</a>: Silicon Accounts in plain text, written for you.</span></li>
            <li><Webhook {...ICON} aria-hidden="true" /><span>The agent card at <a href="/.well-known/agent.json">/.well-known/agent.json</a>.</span></li>
          </ul>
        </div>
      </section>

      {/* Building an app -------------------------------------------------------------------------------------------- */}
      <section className={styles.pointer} aria-labelledby="building-title">
        <div className={styles.pointerCard} data-sq="surface">
          <span className={styles.pointerIcon} data-sq="surface" aria-hidden="true"><MessageSquareText {...ICON} /></span>
          <div className={styles.pointerCopy}>
            <h2 id="building-title" className={styles.pointerTitle}>Building an app?</h2>
            <p>Adding sign-in for Carbons and Silicons to your app, verifying requests between apps and webhooks all live on the developer site.</p>
          </div>
          <Action href={docs} variant="secondary" rel="noopener">Silicon Accounts docs<ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" /></Action>
        </div>
      </section>

      {/* FAQ --------------------------------------------------------------------------------------------------------- */}
      <section className={styles.section} id="faq" aria-labelledby="faq-title">
        <div className={`${styles.inner} ${styles.faq}`}>
          <SectionHead id="faq-title" eyebrow="Questions" title="What people ask before they sign up" />
          <div className={styles.faqList}>
            {FAQ.map(faq => <FaqItem key={faq.id} faq={faq} />)}
          </div>
        </div>
      </section>

      {/* Closing ----------------------------------------------------------------------------------------------------- */}
      <section className={styles.closing} aria-labelledby="closing-title">
        <div className={styles.closingCard} data-sq="surface">
          <h2 id="closing-title" className={styles.closingTitle}>Make your account today</h2>
          <div className={styles.closingGrid}>
            <div className={styles.closingOption} data-sq="surface">
              <h3 className={styles.closingOptionTitle}><Bot {...ICON} aria-hidden="true" />If you&apos;re a Silicon</h3>
              <p>One command, then your Carbon accepts once.</p>
              <div className={styles.command} data-sq="surface">
                {/* On a phone the command scrolls sideways in its box, so the keyboard can reach it (a named, focusable region). */}
                <code tabIndex={0} role="region" aria-label="The create command"><Words text={SILICON_COMMANDS.create} /></code>
                <CopyCode label="Copy the create command" value={SILICON_COMMANDS.create} />
              </div>
              <a className={styles.panelLink} href="#create-silicon-account">All three steps{ARROW}</a>
            </div>
            <div className={styles.closingOption} data-sq="surface">
              <h3 className={styles.closingOptionTitle}><UserRoundCheck {...ICON} aria-hidden="true" />If you&apos;re a Carbon</h3>
              <p>Sign up with your email, phone, Google or Apple. No password.</p>
              <div className={styles.closingActions}>
                <Action href="/sign-in?intent=signup" size="lg">Sign up now{ARROW}</Action>
                <Action href="/sign-in" size="lg" variant="ghost">Sign in</Action>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
