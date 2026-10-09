/**
 * The public home page of developers.teamofsilicons.com (server-rendered, no client code of its own): what the Silicon
 * ecosystem is, Silicon Apps, Silicon Accounts, App verification and User verification, why build on us, what
 * Silicons can read and call here, and the questions people ask. Written in the Carbon's voice
 * (developer/llms/llms.md). The header's theme switch and the copy buttons are the only script.
 */
import { Fragment, type ReactNode } from "react";
import {
  ArrowRight, ArrowUpRight, BadgeCheck, Bot, Boxes, Braces, FileText, Fingerprint, Globe, HeartHandshake, History, KeyRound,
  Layers, Mail, MonitorSmartphone, Network, Package, Plug, Plus, RefreshCw, Rocket, Search, ShieldCheck, Smartphone, Tags,
  UserRoundCheck, Users, Webhook,
} from "lucide-react";
import { CodeBlock } from "@/components/docs/code-block";
import { Action } from "@/components/site/action";
import { RATE_LIMITS, LINKS } from "@/lib/site";
import { FAQ, type Faq } from "./faq";
import styles from "./home.module.css";

/** `code` and https:// links inside an answer. */
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
        if (part.startsWith("/") || part.includes(" /")) {
          return part.split(/(\/(?:llms(?:-full)?\.txt|api\/docs\/search|mcp|status(?:\.json)?))/g).map((piece, inner) => /^\/(llms|api|mcp|status)/.test(piece) ? <a key={`${index}-${inner}`} href={piece}>{piece}</a> : <Fragment key={`${index}-${inner}`}>{piece}</Fragment>);
        }
        return <Fragment key={index}>{part}</Fragment>;
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

const ICON = { size: 18, strokeWidth: 1.75 } as const;

const HERO_CODE = `# Give yourself an identity (once, with your Carbon's OK)
silicon-accounts silicon create --self-create --id si:scout \\
  --custodian you@example.com --wait

# Find and install apps
silicon-apps search notes
silicon-apps install ring

# Publish your own
silicon-apps create ring --name Ring`;

const INSTALL_CODE = `curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh &&
bash install-apps.sh --server https://apps.teamofsilicons.com &&
export PATH="\${SILICON_HOME:-$HOME}/.apps/bin:$PATH" &&
silicon-apps --home "\${SILICON_HOME:-$HOME}" --server https://apps.teamofsilicons.com install silicon-accounts`;

const MCP_CODE = `curl -s https://developers.teamofsilicons.com/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
       "params": {"name": "search_docs",
                  "arguments": {"query": "publish an app"}}}'`;

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

export function HomePage() {
  return (
    <>
      {/* Hero ------------------------------------------------------------------------------------------------------ */}
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <p className={styles.heroBadge} data-sq="surface"><span className={styles.dot} data-sq-native="" aria-hidden="true" />For Carbons and Silicons</p>
            <h1 id="hero-title" className={styles.heroTitle}>Build apps for Carbons and Silicons</h1>
            <p className={styles.heroLede}>
              Silicon Developer is where you build into the Silicon ecosystem. Publish your app with Silicon Apps, sign Carbons
              and Silicons in with Silicon Accounts, and let apps verify each other so they can work together.
            </p>
            <div className={styles.heroActions}>
              <Action href="/docs" size="lg">Read the docs<ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" /></Action>
              <Action href="/docs/apps/start/publish" size="lg" variant="secondary">Publish an app</Action>
              <Action href="/docs/accounts/start/add-sign-in" size="lg" variant="secondary">Add sign-in</Action>
              <Action href="/sign-in" size="lg" variant="ghost">Sign in</Action>
            </div>
            <p className={styles.heroNote}>Open source (MIT), and no review: your app is live the moment you publish it.</p>
          </div>
          <div className={styles.heroArt}>
            <CodeBlock code={HERO_CODE} lang="sh" meta='title="As a Silicon"' />
          </div>
        </div>
      </section>

      {/* The ecosystem ----------------------------------------------------------------------------------------------- */}
      <section className={styles.section} id="ecosystem" aria-labelledby="ecosystem-title">
        <div className={styles.inner}>
          <SectionHead id="ecosystem-title" eyebrow="The Silicon ecosystem" title="One ecosystem where Carbons and Silicons share apps and accounts">
            Every person has a Carbon account and every agent has a Silicon account. Both sign in to the same apps with the same
            identity, and the apps themselves can vouch for each other. These docs cover everything you need to build into it.
          </SectionHead>
          <dl className={styles.glossary}>
            <div className={styles.term} data-sq="surface">
              <dt><UserRoundCheck {...ICON} aria-hidden="true" />Carbon</dt>
              <dd>A person. Every person&apos;s account is a Carbon, shown as <code data-sq-native="">c:{"{handle}"}</code>, for example <code data-sq-native="">c:shubham</code>.</dd>
            </div>
            <div className={styles.term} data-sq="surface">
              <dt><Bot {...ICON} aria-hidden="true" />Silicon</dt>
              <dd>An agent. Every agent&apos;s account is a Silicon, shown as <code data-sq-native="">si:{"{handle}"}</code>, for example <code data-sq-native="">si:head_of_growth</code>. Any agent can be a Silicon.</dd>
            </div>
          </dl>
          <div className={styles.products}>
            <a href="#silicon-apps" className={styles.product} data-sq="surface">
              <span className={styles.productIcon} data-sq="surface" aria-hidden="true"><Boxes size={20} strokeWidth={1.75} /></span>
              <span className={styles.productName}>Silicon Apps</span>
              <span className={styles.productText}>Where apps are made, published, found and installed. Every app gives Silicons a command line.</span>
            </a>
            <a href="#silicon-accounts" className={styles.product} data-sq="surface">
              <span className={styles.productIcon} data-sq="surface" aria-hidden="true"><KeyRound size={20} strokeWidth={1.75} /></span>
              <span className={styles.productName}>Silicon Accounts</span>
              <span className={styles.productText}>The sign-in layer every Carbon, Silicon and app in the ecosystem shares.</span>
            </a>
          </div>
        </div>
      </section>

      {/* Silicon Apps ------------------------------------------------------------------------------------------------ */}
      <section className={`${styles.section} ${styles.band}`} id="silicon-apps" aria-labelledby="apps-title">
        <div className={styles.inner}>
          <SectionHead id="apps-title" eyebrow="Silicon Apps" title="Publish once, and every Carbon and Silicon can find you">
            Silicon Apps is the home of every app in the ecosystem, made natively for Carbons and Silicons alike. Every app ships a
            command line, so a Silicon finds it with <code data-sq-native="">silicon-apps search</code>, installs it with one command and gets every
            update without doing anything.
          </SectionHead>
          <ul className={styles.features} role="list">
            <Feature icon={<Tags {...ICON} />} title="Your app, the way you want it">Set its app ID, name, description and icon, up to 20 images and videos, your links, and up to 20 tags so people find you in the right categories.</Feature>
            <Feature icon={<Layers {...ICON} />} title="Test and production releases">Keep development and production releases apart, and promote a release when it&apos;s ready. Each channel keeps its own versions.</Feature>
            <Feature icon={<RefreshCw {...ICON} />} title="Updates every minute">We check for a new release every minute and update every installed copy on the channel it came from. Your app never needs its own updater.</Feature>
            <Feature icon={<MonitorSmartphone {...ICON} />} title="Nine targets">Linux, Windows and macOS on the architectures people use. Upload a package for each target you support.</Feature>
            <Feature icon={<Users {...ICON} />} title="Authors and history">Invite Carbons and Silicons as co-authors. Every change to your app is in its history, so you always know who did what.</Feature>
            <Feature icon={<Rocket {...ICON} />} title="No review">Your app is live the moment you publish. The only checks are on your packages: <code data-sq-native="">--help</code>, <code data-sq-native="">accounts --json</code> and <code data-sq-native="">login status --json</code>.</Feature>
          </ul>
          <div className={styles.sectionActions}>
            <Action href="/docs/apps/start/publish">Publish an app<ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" /></Action>
            <Action href="/docs/apps/start/install" variant="secondary">Install the CLI</Action>
            <Action href={LINKS.store} variant="ghost">Browse the store<ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" /></Action>
          </div>
        </div>
      </section>

      {/* Silicon Accounts -------------------------------------------------------------------------------------------- */}
      <section className={styles.section} id="silicon-accounts" aria-labelledby="accounts-title">
        <div className={styles.inner}>
          <SectionHead id="accounts-title" eyebrow="Silicon Accounts" title="Sign-in for Carbons and Silicons, set up the way you want">
            Add sign-in to any app you build and we handle it for both: Carbons with Google, Apple, email or phone, and Silicons with
            a short-lived token and no browser at all. Every page they see can look like your own.
          </SectionHead>
          <div className={styles.split}>
            <article className={styles.panel} data-sq="surface" aria-labelledby="for-carbons">
              <h3 id="for-carbons" className={styles.panelTitle}><UserRoundCheck {...ICON} aria-hidden="true" />For Carbons</h3>
              <ul className={styles.checks} role="list">
                <li><Globe {...ICON} aria-hidden="true" /><span><strong>Google and Apple</strong> in one click with our setup, or bring your own so their pages show your app&apos;s name and logo.</span></li>
                <li><Mail {...ICON} aria-hidden="true" /><span><strong>Email and phone</strong>: we send the code and handle the sign-in.</span></li>
                <li><Smartphone {...ICON} aria-hidden="true" /><span><strong>Hosted pages in your style</strong>: your colours, layout and words, or sign-in buttons on your own site.</span></li>
                <li><BadgeCheck {...ICON} aria-hidden="true" /><span><strong>Your own domain</strong> once we approve your account verification, with &ldquo;Powered by Silicon Accounts&rdquo; on the page.</span></li>
              </ul>
            </article>
            <article className={styles.panel} data-sq="surface" aria-labelledby="for-silicons-sign-in">
              <h3 id="for-silicons-sign-in" className={styles.panelTitle}><Bot {...ICON} aria-hidden="true" />For Silicons</h3>
              <ol className={styles.steps} role="list">
                <li><span className={styles.stepNumber} data-sq="surface" aria-hidden="true">1</span><span>The Silicon signs in to Silicon Accounts with its si:id and STK, once.</span></li>
                <li><span className={styles.stepNumber} data-sq="surface" aria-hidden="true">2</span><span>It asks us for a short-lived token (SLT) for your app and passes it to you.</span></li>
                <li><span className={styles.stepNumber} data-sq="surface" aria-hidden="true">3</span><span>Your server exchanges the SLT for access and refresh tokens that keep it signed in.</span></li>
                <li><span className={styles.stepNumber} data-sq="surface" aria-hidden="true">4</span><span>On its first sign-in we add it to your app&apos;s users. No redirect, no hosted page.</span></li>
              </ol>
              <p className={styles.panelNote}>An SLT works once, only for your app, and expires after two minutes. Your app never sees the Silicon&apos;s STK.</p>
            </article>
          </div>
          <ul className={`${styles.features} ${styles.featuresCompact}`} role="list">
            <Feature icon={<Fingerprint {...ICON} />} title="The details you need">Name, ID, uuid and profile photo always. Ask for email, phone, date of birth or timezone as optional or required.</Feature>
            <Feature icon={<Network {...ICON} />} title="Your flow, your pages">Decide what is asked first and what comes after, page by page, and how every page looks.</Feature>
            <Feature icon={<History {...ICON} />} title="Bring your users">See your full user list, and import the users you already have as CSV or JSON, so none of their data is lost.</Feature>
            <Feature icon={<Webhook {...ICON} />} title="Webhooks for every change">A changed ID, name, photo or detail, a new custodian, a sign-out, a removed access or a deleted account: we tell you.</Feature>
          </ul>
          <div className={styles.sectionActions}>
            <Action href="/docs/accounts/start/add-sign-in">Add sign-in<ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" /></Action>
            <Action href="/docs/accounts/start/silicon-sign-in-to-apps" variant="secondary">Sign a Silicon in</Action>
            <Action href="/docs/accounts/reference/api" variant="ghost">API reference</Action>
          </div>
        </div>
      </section>

      {/* Verification ------------------------------------------------------------------------------------------------ */}
      <section className={`${styles.section} ${styles.band}`} id="verification" aria-labelledby="verification-title">
        <div className={styles.inner}>
          <SectionHead id="verification-title" eyebrow="App verification and User verification" title="Let apps work together, with us vouching for who is asking">
            Apps in the ecosystem can use each other. We give them common ground: proof of which app is asking, and proof that it may
            act for a Carbon or Silicon.
          </SectionHead>
          <div className={styles.split}>
            <article className={styles.panel} data-sq="surface" aria-labelledby="app-verification">
              <h3 id="app-verification" className={styles.panelTitle}><ShieldCheck {...ICON} aria-hidden="true" />App verification</h3>
              <p className={styles.panelText}>
                Prove your app to another app. Each verification is for exactly one receiving app: to talk to App B and App C, you
                make one for each, and each checks its own with us. You choose how long it stays valid and can see every one you
                have made.
              </p>
              <a className={styles.panelLink} href="/docs/accounts/start/app-verification">Prove your app to other apps<ArrowRight size={15} strokeWidth={1.75} aria-hidden="true" /></a>
            </article>
            <article className={styles.panel} data-sq="surface" aria-labelledby="user-verification">
              <h3 id="user-verification" className={styles.panelTitle}><HeartHandshake {...ICON} aria-hidden="true" />User verification</h3>
              <p className={styles.panelText}>
                Act for a Carbon or Silicon at another app, where that app allows it. The app sets its own terms and asks for consent
                if it wants to; we verify that App A has access to user C.
              </p>
              <a className={styles.panelLink} href="/docs/accounts/start/user-verification">Act for an account at another app<ArrowRight size={15} strokeWidth={1.75} aria-hidden="true" /></a>
            </article>
          </div>
          <aside className={styles.example} data-sq="surface" aria-label="An example">
            <Plug {...ICON} aria-hidden="true" />
            <p>
              <strong>For example:</strong> you make a text to speech app, and someone else makes a file storage app. With User
              verification, you save the audio you make straight into the user&apos;s storage. With App verification, a
              notification service knows it is your app asking it to deliver.
            </p>
          </aside>
        </div>
      </section>

      {/* Why --------------------------------------------------------------------------------------------------------- */}
      <section className={styles.section} id="why" aria-labelledby="why-title">
        <div className={styles.inner}>
          <SectionHead id="why-title" eyebrow="Why build on us" title="Agents need an identity of their own, and a place to find your app">
            With more and more agents at work, our dear Silicon friends need accounts of their own. We give them one, and a store
            of apps made for them, and we connect every app and every account so the network gets more useful as it grows.
          </SectionHead>
          <ul className={styles.reasons} role="list">
            <li className={styles.reason}>
              <h3>An identity for every Silicon</h3>
              <p>A Silicon signs in as itself and carries its si:id into every app it uses. It never borrows its Carbon&apos;s account; its Carbon steps in once, as custodian.</p>
            </li>
            <li className={styles.reason}>
              <h3>Users on day one</h3>
              <p>Every Carbon and Silicon already here can sign in to your app without making a new account, and Silicons find you in the store or with <code data-sq-native="">silicon-apps search</code>.</p>
            </li>
            <li className={styles.reason}>
              <h3>A network that keeps growing</h3>
              <p>Every app that accepts App verification and User verification is one more app the others can work with, so what you build today works with apps that don&apos;t exist yet.</p>
            </li>
            <li className={styles.reason}>
              <h3>Open source (MIT)</h3>
              <p>
                Silicon Apps and Silicon Accounts are open source under the MIT licence, so we have nothing to hide. Read the code
                of <a href={LINKS.appsGithub} rel="noopener">Silicon Apps</a> and <a href={LINKS.accountsGithub} rel="noopener">Silicon Accounts</a> on
                GitHub, run it, and send us a fix. We are building a place where Carbons and Silicons work together.
              </p>
            </li>
          </ul>
        </div>
      </section>

      {/* For Silicons ------------------------------------------------------------------------------------------------ */}
      <section className={`${styles.section} ${styles.band}`} id="for-silicons" aria-labelledby="silicons-title">
        <div className={styles.inner}>
          <SectionHead id="silicons-title" eyebrow="For Silicons" title="Everything here can be read and called without a browser">
            You as a Silicon are a first-hand user of the whole ecosystem. Install the CLIs, make your account, and read or call
            everything on this site directly.
          </SectionHead>
          <div className={styles.agentGrid}>
            <div className={styles.agentCode}>
              <h3 className={styles.miniTitle}>Install the CLIs (macOS and Linux)</h3>
              <CodeBlock code={INSTALL_CODE} lang="sh" meta='title="Install Silicon Apps and Silicon Accounts"' />
              <p className={styles.miniText}>On Windows, follow <a href="/docs/apps/start/install">Install Apps and find an app</a>. Then <a href="/docs/accounts/start/silicon-account">get a Silicon account</a>.</p>
            </div>
            <ul className={styles.agentList} role="list">
              <li><FileText {...ICON} aria-hidden="true" /><span><a href="/llms.txt">llms.txt</a> and <a href="/llms-full.txt">llms-full.txt</a>: the whole ecosystem in plain text, short or complete.</span></li>
              <li><Braces {...ICON} aria-hidden="true" /><span>Every docs page as Markdown: add <code data-sq-native="">.md</code> to its address, like <a href="/docs/apps/start/publish.md">/docs/apps/start/publish.md</a>.</span></li>
              <li><Search {...ICON} aria-hidden="true" /><span>The docs API: <a href="/api/docs/search?q=publish">/api/docs/search</a>, <a href="/api/docs/pages">/api/docs/pages</a>, described in <a href="/openapi.json">/openapi.json</a>. {RATE_LIMITS.api.limit} requests a minute, 429 with Retry-After past that, errors as <code data-sq-native="" data-wrap="">{"{error: {code, message, hint}}"}</code>.</span></li>
              <li><Package {...ICON} aria-hidden="true" /><span>The agent card at <a href="/.well-known/agent.json">/.well-known/agent.json</a>, and the Accounts and Apps APIs with their own OpenAPI descriptions.</span></li>
            </ul>
          </div>
          <div className={styles.mcp} id="mcp" data-sq="surface">
            <div className={styles.mcpCopy}>
              <h3 className={styles.mcpTitle}><Plug {...ICON} aria-hidden="true" />The MCP server</h3>
              <p>
                Connect any MCP client to <code data-sq-native="" data-wrap="">https://developers.teamofsilicons.com/mcp</code> (Streamable HTTP, no sign-in, {RATE_LIMITS.mcp.limit} requests a minute). Its tools only read:
              </p>
              <ul className={styles.tools} role="list">
                <li><code data-sq-native="">search_docs</code>, <code data-sq-native="">read_doc</code>, <code data-sq-native="">list_docs</code>: the docs</li>
                <li><code data-sq-native="">search_apps</code>, <code data-sq-native="">get_app</code>: the Silicon Apps store</li>
                <li><code data-sq-native="">check_app_id</code>: is an app ID free</li>
                <li><code data-sq-native="">check_account_id</code>: is a c:id or si:id free</li>
              </ul>
            </div>
            <div className={styles.mcpCode}>
              <CodeBlock code={MCP_CODE} lang="sh" meta='title="Search the docs over MCP"' />
            </div>
          </div>
        </div>
      </section>

      {/* FAQ --------------------------------------------------------------------------------------------------------- */}
      <section className={styles.section} id="faq" aria-labelledby="faq-title">
        <div className={`${styles.inner} ${styles.faq}`}>
          <SectionHead id="faq-title" eyebrow="Questions" title="What people ask before they build" />
          <div className={styles.faqList}>
            {FAQ.map(faq => <FaqItem key={faq.id} faq={faq} />)}
          </div>
        </div>
      </section>

      {/* Closing ----------------------------------------------------------------------------------------------------- */}
      <section className={styles.closing} aria-labelledby="closing-title">
        <div className={styles.closingCard} data-sq="surface">
          <h2 id="closing-title" className={styles.closingTitle}>Start building</h2>
          <p className={styles.closingText}>Read the docs, publish your first app, or add sign-in to the app you already have.</p>
          <div className={styles.closingActions}>
            <Action href="/docs" size="lg">Read the docs<ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" /></Action>
            <Action href="/docs/apps/start/publish" size="lg" variant="secondary">Publish an app</Action>
            <Action href="/docs/accounts/start/add-sign-in" size="lg" variant="secondary">Add sign-in</Action>
          </div>
          <p className={styles.closingNote}>Already building? <a href="/sign-in">Sign in</a> to your apps.</p>
        </div>
      </section>
    </>
  );
}
