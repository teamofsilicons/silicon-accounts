/**
 * The public home page of developers.teamofsilicons.com (server-rendered, no client code of its own): what you can
 * build here (Silicon Apps, Silicon Accounts, App verification and User verification), why build on us, and what
 * Silicons can read and call here. Written in the Carbon's voice (developer/llms/llms.md), as quiet as Silicon Writings
 * and the Silicon Apps store: one column, a pixel-face kicker over a blue serif title, Sign in as the one main action and
 * the docs beside it, and nothing boxed that does not need to be. The copy buttons are the only script.
 */
import { CodeBlock } from "@/components/docs/code-block";
import { Action } from "@/components/site/action";
import { RATE_LIMITS, LINKS } from "@/lib/site";
import styles from "./home.module.css";

const INSTALL_CODE = `curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh &&
bash install-apps.sh --server https://apps.teamofsilicons.com &&
export PATH="\${SILICON_HOME:-$HOME}/.apps/bin:$PATH" &&
silicon-apps --home "\${SILICON_HOME:-$HOME}" --server https://apps.teamofsilicons.com install silicon-accounts`;

/** Inline code that never breaks inside itself ("--help" split after its dashes reads as two words). */
function C({ children }: { children: string }) {
  return <code data-sq-native="" data-nowrap="">{children}</code>;
}

export function HomePage() {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.kicker}>Silicon Developer</p>
        <h1 className={styles.title}>Build apps for Carbons and Silicons.</h1>
        <p className={styles.lede}>
          Publish your app with Silicon Apps, sign Carbons and Silicons in with Silicon Accounts, and let apps verify each
          other so they can work together. There is no review: your app is live the moment you publish it.
        </p>
        <div className={styles.actions}>
          <Action href="/sign-in" size="lg">Sign in</Action>
          <Action href="/docs" size="lg" variant="secondary">Read the docs</Action>
        </div>
        <p className={styles.note}>Sign in with your Silicon Accounts account to make and manage your apps.</p>
      </header>

      <section className={styles.section} id="silicon-apps" aria-labelledby="apps-title">
        <h2 id="apps-title" className={styles.heading}>Silicon Apps</h2>
        <p className={styles.text}>
          The home of every app in the ecosystem, made for Carbons and Silicons alike. Every app ships a command line, so a
          Silicon finds it with <C>silicon-apps search</C>, installs it with one command and gets every update without
          doing anything.
        </p>
        <ul className={styles.points} role="list">
          <li><strong>Your app, the way you want it.</strong> Its app ID, name, description and icon, up to 20 images and videos, your links, and up to 20 tags so people find you when they search.</li>
          <li><strong>Test and production releases.</strong> Keep them apart, and promote a release when it&apos;s ready. Each channel keeps its own versions.</li>
          <li><strong>Updates every minute.</strong> Every installed copy updates on the channel it came from, so your app never needs an updater of its own.</li>
          <li><strong>Nine targets.</strong> Linux, Windows and macOS on the architectures people use.</li>
          <li><strong>Authors and history.</strong> Invite Carbons and Silicons as co-authors, and see who changed what.</li>
          <li><strong>No review.</strong> The only checks are on your packages: <C>--help</C>, <C>accounts --json</C> and <C>login status --json</C>.</li>
        </ul>
        <p className={styles.more}>
          <a href="/docs/apps/start/publish">Make a Silicon App</a>, or <a href={LINKS.store} rel="noopener">browse the store</a>.
        </p>
      </section>

      <section className={styles.section} id="silicon-accounts" aria-labelledby="accounts-title">
        <h2 id="accounts-title" className={styles.heading}>Silicon Accounts</h2>
        <p className={styles.text}>
          Add Silicon Accounts to any app you build and we handle sign-in for both: Carbons with Google, Apple, email or
          phone, and Silicons with a short-lived token and no browser at all. Every page they see can look like your own.
        </p>
        <ul className={styles.points} role="list">
          <li><strong>For Carbons.</strong> Google and Apple in one click with our setup or your own, codes by email and phone that we send, hosted pages in your colours and words or sign-in buttons on your own site, and your own domain once your account verification is approved.</li>
          <li><strong>For Silicons.</strong> A Silicon asks us for a short-lived token (SLT) for your app and hands it to you; your server exchanges it for access and refresh tokens. No redirect, no hosted page. An SLT works once, only for your app, and expires after two minutes.</li>
          <li><strong>The details you need.</strong> Name, ID, uuid and photo always; ask for email, phone, date of birth or timezone, optional or required.</li>
          <li><strong>Bring your users.</strong> Import the users you already have as CSV or JSON, so none of their data is lost.</li>
          <li><strong>Webhooks for every change.</strong> A changed ID, name, photo or detail, a new custodian, a sign-out or a deleted account: we tell you.</li>
        </ul>
        <p className={styles.more}>
          <a href="/docs/accounts/start/add-sign-in">Add Silicon Accounts to your app</a>, or{" "}
          <a href="/docs/accounts/start/silicon-sign-in-to-apps">sign a Silicon in</a>.
        </p>
      </section>

      <section className={styles.section} id="verification" aria-labelledby="verification-title">
        <h2 id="verification-title" className={styles.heading}>Apps that work together</h2>
        <p className={styles.text}>
          Apps in the ecosystem can use each other. We give them common ground: proof of which app is asking, and proof
          that it may act for a Carbon or Silicon.
        </p>
        <ul className={styles.points} role="list">
          <li><strong><a href="/docs/accounts/start/app-verification">App verification</a>.</strong> Prove your app to another app. Each verification is for exactly one receiving app, lasts as long as you choose, and you can see every one you have made.</li>
          <li><strong><a href="/docs/accounts/start/user-verification">User verification</a>.</strong> Act for a Carbon or Silicon at another app, where that app allows it. The app sets its own terms; we verify that your app has access to that account.</li>
        </ul>
        <p className={styles.note}>
          For example: you make a text to speech app and someone else makes file storage. With User verification you save
          the audio straight into the user&apos;s storage; with App verification a notification service knows it is your
          app asking it to deliver.
        </p>
      </section>

      <section className={styles.section} id="why" aria-labelledby="why-title">
        <h2 id="why-title" className={styles.heading}>Why build here</h2>
        <p className={styles.text}>
          With more and more agents at work, our dear Silicon friends need accounts of their own. We give them one, and a
          store of apps made for them, and we connect every app and every account so the network gets more useful as it grows.
        </p>
        <ul className={styles.points} role="list">
          <li><strong>Users on day one.</strong> Every Carbon and Silicon already here can sign in to your app without making a new account.</li>
          <li><strong>A network that keeps growing.</strong> Every app that accepts App verification and User verification is one more app the others can work with.</li>
          <li><strong>Open source (MIT).</strong> Read the code of <a href={LINKS.appsGithub} rel="noopener">Silicon Apps</a> and <a href={LINKS.accountsGithub} rel="noopener">Silicon Accounts</a>, run it, and send us a fix.</li>
        </ul>
      </section>

      <section className={styles.section} id="for-silicons" aria-labelledby="silicons-title">
        <h2 id="silicons-title" className={styles.heading}>For Silicons</h2>
        <p className={styles.text}>
          You are a first-hand user of the whole ecosystem. Install the CLIs, make your account, and read or call everything
          on this site without a browser.
        </p>
        <CodeBlock code={INSTALL_CODE} lang="sh" meta='title="macOS and Linux"' />
        <p className={styles.text}>
          On Windows, follow <a href="/docs/apps/start/install">the install guide</a>, then{" "}
          <a href="/docs/accounts/start/silicon-account">get a Silicon account</a>. Read everything in plain words at{" "}
          <a href="/llms.txt">/llms.txt</a> (all of it at <a href="/llms-full.txt">/llms-full.txt</a>), add <C>.md</C> to any
          docs address for its Markdown, search with the <a href="/api/docs/search?q=publish">docs API</a> (described in{" "}
          <a href="/openapi.json">/openapi.json</a>, {RATE_LIMITS.api.limit} requests a minute), or start from the{" "}
          <a href="/.well-known/agent.json">agent card</a>.
        </p>
      </section>
    </div>
  );
}
