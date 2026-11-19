"use client";

/**
 * /__signin: the hosted "Sign in to <app>" step (choose_method) in versions, inside the real hosted frame, for an app in
 * the default look (Briefcase), one with its own branding (Acme Notes: dark, serif, split), and Briefcase with no
 * subtitle of its own. Every version is kept; a new idea is a new
 * version. Nothing is sent: the buttons and the field answer locally.
 *
 *   Today  the real step (steps/choose-method.tsx) with the real footer (flow-page.tsx FlowFooter).
 *   A      The prototype's head (redesign/prototype-v7.html `signin`): the logo beside the title in one row (not in
 *          the split layout, which shows the logo beside the form already). The line under it stays the app's own
 *          subtitle (an app's copy is its own); an app without one gets the prototype's "New here? Signing in makes
 *          your account."
 *   B      A, plus the prototype's foot: the small print as one block, and "One account for every Team of Silicons
 *          app" with the mark at the card's end (the prototype's `.secured` line). "Powered by" stays, as the
 *          contract asks.
 *   C      Sections (Anil, 2026-11-19): the app (logo, name, its subtitle); then "Sign in with your Team of Silicons
 *          account" with the prototype's line under it; then Google and Apple; then email or phone. No note after
 *          the field and no Team of Silicons line at the end; the terms and privacy line stays with help, its
 *          underline further from the text. Hairlines divide the app, the sign-in and the small print.
 *   D      C with the two rows drawn alike (Anil, 2026-11-19): the app's icon (Briefcase's real icon,
 *          public/icons/briefcase) as the account site's AppMark (its corner and a hairline) beside its name and
 *          line; the account heading and its line with no icon (Anil took the Accounts logo out, 2026-11-19); the
 *          methods sit right under the heading, so the heading and the field read as one group.
 *   E      D with the sign-in in one soft panel (the canvas grey), the app above it on the card.
 *   F      D with less asking for attention (Anil, 2026-11-19: "everything's mostly primary color"): the account heading
 *          as a quiet caption (label size, secondary grey), Google and Apple side by side when there is room, and
 *          Send Me a Code the one solid button. Silicon UI's field label and buttons are as they ship.
 *          D, E and F, round three (Anil, 2026-11-19: "d is fine"): 40px from the app to the sign-in, 32px from the
 *          sign-in to the small print (32 / 24 tried, taken back). A Case switch draws D's states: sign in, sign up
 *          ("Sign up with your Team of Silicons account", a proposal), and a browser already signed in (the account
 *          row, Continue as, Use Another Account), and several accounts in one browser (select_account: Today is the
 *          real step; D puts Personal and Work under "Choose your account", each account with a soft Continue, and
 *          "Sign in to Another Account" as a soft button). Google and Apple in Silicon UI's soft button (light fill, no border).
 *          D and E, round two (Anil, 2026-11-19): the app's name and line closer; no dividers, only space; no "New
 *          here?" line; the terms and help in the muted grey, their underline closer, breaking around descenders.
 *          40px between the app and the sign-in, 32px between the sign-in and the small print, 16px inside the sign-in.
 *
 * Built from the step's own parts (flow/parts.tsx) and Silicon UI; only the placement and the words change.
 */
import { useMemo, useState, type ReactNode } from "react";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { FlowFooter } from "@/components/auth/flow-page";
import { AppIdentity, HostedFrame, usePaint } from "@/components/auth/flow/hosted-frame";
import type { FlowController } from "@/components/auth/flow/controller";
import { appSubtitle, appTitle, type HostedFlow } from "@/components/auth/flow/model";
import { AccountRow, AppleMark, ContactForm, GoogleMark, OrDivider, ProviderButton, StepHeading, contactKinds } from "@/components/auth/flow/parts";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { sampleFlow, type Scenario } from "@/components/auth/mocks/flows";
import { ChooseMethod } from "@/components/auth/steps/choose-method";
import { SelectAccount } from "@/components/auth/steps/select-account";
import { Details } from "@/components/auth/steps/details";
import { Cake, Clock, Mail, Phone, UserRound } from "lucide-react";
import { Switch } from "@teamofsilicons/silicon-ui/switch";
import { Row, Tile } from "@/components/account/parts/rows";
import { formatDate } from "@/lib/format";
import { timezoneLabel } from "@/lib/timezones";
import type { FlowDetailField } from "@/lib/api/types";
import type { LinkedAccount } from "@/lib/api/types";
import { AppMark } from "@/components/account/parts/app-mark";
import { AccountsGlyph } from "@/components/foundation/shell/brand-mark";
import { isProvider } from "@/components/auth/flow/model";
import type { AppPublic, Branding, SigninMethod } from "@/lib/api/types";
import { DEFAULT_BRANDING, DEFAULT_COPY, normalizeBranding, normalizeCopy } from "@/lib/branding/defaults";
import { SAMPLE_APPS } from "./sample-apps";
import flowStyles from "@/components/auth/flow/flow.module.css";
import styles from "./signin-lab.module.css";

const APPS = {
  briefcase: { label: "Briefcase", id: "briefcase" },
  acme: { label: "Acme Notes", id: "acme-notes" },
  bare: { label: "No subtitle", id: "briefcase", bare: true },
} as const satisfies Record<string, { label: string; id: keyof typeof SAMPLE_APPS; bare?: boolean }>;

const ORDER: SigninMethod[] = ["google", "apple", "email", "phone"];

/** A sample app as the API shows it publicly (scripts/mock/fixtures.ts appPublic, without Node). */
function samplePublic(appId: keyof typeof SAMPLE_APPS): AppPublic {
  const app = SAMPLE_APPS[appId];
  const defaults = app;
  const on: Partial<Record<string, boolean>> = app.methods;
  const order = ((app.method_order ?? ORDER) as readonly SigninMethod[]).filter(method => ORDER.includes(method));
  return {
    app_id: app.app_id, name: app.name, logo_url: app.logo_url ?? null, logo_dark_url: app.logo_dark_url ?? null, homepage_url: app.homepage_url ?? null,
    methods: order.filter(method => on[method]),
    branding: normalizeBranding({ ...DEFAULT_BRANDING, ...(defaults.branding ?? {}) }),
    copy: normalizeCopy({ ...DEFAULT_COPY, ...(defaults.copy ?? {}) }),
    allowed_origins: [],
  } as AppPublic;
}

/** The step's states, to design each in D (Anil, 2026-11-19: "we have [to] ideate all these"). */
const CASES = {
  signin: { label: "Sign in", scenario: "choose_method" },
  signup: { label: "Sign up", scenario: "signup_intent" },
  continue: { label: "Signed in already", scenario: "continue_as" },
  accounts: { label: "Several accounts", scenario: "choose_method" },
  details: { label: "Share details", scenario: "details" },
} as const satisfies Record<string, { label: string; scenario: Scenario }>;

/** D's heading for each state. "Sign up with…" is a proposal, to confirm. */
const ACCOUNT_HEADING = { signin: "Sign in with your Team of Silicons account", signup: "Sign up with your Team of Silicons account", continue: "Sign in with your Team of Silicons account", accounts: "Choose your account", details: "Share your details" } as const;

/** The icons Connected Apps uses for each detail. */
const DETAIL_ICON: Record<string, ReactNode> = { email: <Mail size={16} strokeWidth={2} />, phone: <Phone size={16} strokeWidth={2} />, dob: <Cake size={16} strokeWidth={2} />, timezone: <Clock size={16} strokeWidth={2} /> };
const valueOf = (field: FlowDetailField) => field.value === null ? "Not added yet" : field.field === "dob" ? formatDate(field.value) : field.field === "timezone" ? timezoneLabel(field.value) : field.value;

/**
 * D, share your details: who is signing in, then what the app always sees (the profile and the required details) and
 * what you choose (each optional detail with a switch, off until switched on; Add for one the account doesn't have), as
 * Connected Apps lists them; Share and Continue, Cancel. "Name, photo and CarbonID" is Connected Apps' name for the
 * profile (consent said "Name, id and profile photo").
 */
function ShareDetails({ flow }: { flow: HostedFlow }) {
  const fields = flow.details?.fields ?? [];
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(fields.map(field => [field.field, field.shared])));
  const always = fields.filter(field => field.mode === "required");
  const choose = fields.filter(field => field.mode === "optional");
  const account = flow.signed_in_as;
  return (
    <div className={styles.shareDetails}>
      {account ? <AccountRow account={account} size="sm" action={<Button size="sm" variant="soft" onClick={() => undefined}>Switch Account</Button>} /> : null}
      <section className={styles.accountList} aria-labelledby="lab-always">
        <h2 id="lab-always" className={styles.groupName}>{flow.app.name} always sees</h2>
        <div className={styles.detailRows} data-sq="clip">
          <Row lead={<Tile><UserRound size={16} strokeWidth={2} /></Tile>} title="Name, photo and CarbonID" detail={account ? `${account.display_name} · ${account.id}` : undefined} />
          {always.map(field => <Row key={field.field} lead={<Tile>{DETAIL_ICON[field.field]}</Tile>} title={field.label} detail={valueOf(field)} />)}
        </div>
      </section>
      {choose.length ? (
        <section className={styles.accountList} aria-labelledby="lab-choose">
          <h2 id="lab-choose" className={styles.groupName}>You choose</h2>
          <div className={styles.detailRows} data-sq="clip">
            {choose.map(field => (
              <Row key={field.field} lead={<Tile>{DETAIL_ICON[field.field]}</Tile>} title={field.label} detail={valueOf(field)}>
                {field.value === null
                  ? <Button size="sm" variant="soft" onClick={() => undefined}>Add</Button>
                  : <Switch checked={!!on[field.field]} onCheckedChange={value => setOn(current => ({ ...current, [field.field]: value }))} aria-label={`Share your ${field.label.toLowerCase()} with ${flow.app.name}`} />}
              </Row>
            ))}
          </div>
        </section>
      ) : null}
      <div className={styles.choices}>
        <Button className={flowStyles.wide} onClick={() => undefined}>Share and Continue</Button>
        <Button variant="soft" className={flowStyles.wide} onClick={() => undefined}>Cancel</Button>
      </div>
    </div>
  );
}

/**
 * The select_account step's sample: a personal account, a work account, and one whose org doesn't allow the app (as
 * components/work-accounts/screens.ts "auth-work-picker"). Sample people only.
 */
const ORG = { org_id: "studio", name: "The Design Studio", logo_url: "/icon-192.png" };
const SAMPLE_ACCOUNTS: LinkedAccount[] = [
  { uuid: "a8K", kind: "carbon", id: "c:saket", display_name: "Saket Dev", pfp_url: "", status: "active", org: null, is_main: true, allowed: true, reason: null },
  { uuid: "wrk", kind: "carbon", id: "c:saket.studio", display_name: "Saket Dev", pfp_url: "", status: "active", org: ORG, is_main: false, allowed: true, reason: null },
  { uuid: "blocked", kind: "carbon", id: "c:saket.research", display_name: "Saket Dev", pfp_url: "", status: "active", org: { org_id: "research", name: "Research Collective", logo_url: null }, is_main: false, allowed: false, reason: "Research Collective does not allow this app." },
];

/** D, several accounts: Personal and Work over the accounts, each with a soft Continue; another account at the end. */
function AccountChoices({ flow }: { flow: HostedFlow }) {
  const accounts = flow.accounts ?? [];
  return (
    <div className={styles.accountChoices}>
      {([false, true] as const).map(work => {
        const list = accounts.filter(account => !!account.org === work);
        if (!list.length) return null;
        const label = work ? "Work" : "Personal";
        return (
          <section key={label} className={styles.accountList} aria-labelledby={`lab-accounts-${label}`}>
            <h2 id={`lab-accounts-${label}`} className={styles.groupName}>{label}</h2>
            {list.map(account => {
              const blocked = account.allowed === false;
              return (
                <AccountRow
                  key={account.uuid}
                  account={account}
                  size="sm"
                  blocked={blocked}
                  detail={blocked ? account.reason ?? undefined : account.org ? (
                    <span className={flowStyles.orgLine}>
                      <AppMark app={{ app_id: account.org.org_id, name: account.org.name, logo_url: account.org.logo_url }} size={16} decorative />
                      {account.org.name}
                    </span>
                  ) : undefined}
                  // An account that can't be chosen shows why, and no button.
                  action={blocked ? undefined : <Button size="sm" variant="soft" onClick={() => undefined} aria-label={`Continue as ${account.id}`}>Continue</Button>}
                />
              );
            })}
          </section>
        );
      })}
      <Button variant="soft" className={flowStyles.wide} onClick={() => undefined}>Sign in to Another Account</Button>
    </div>
  );
}

const VERSIONS = {
  today: "Today",
  a: "A  Prototype head",
  b: "B  Head and foot",
  c: "C  Sections",
  d: "D  Icon rows",
  e: "E  Sign-in panel",
  f: "F  Quieter",
} as const;
type Version = keyof typeof VERSIONS;

/** Every action answers at once with no error: the lab never talks to the API. */
const quiet = async () => null;
const STUB = new Proxy({}, { get: (_target, key) => (key === "flow" || key === "failure" || key === "notice" ? null : key === "loading" ? false : quiet) }) as FlowController;

const NO_PASSWORDS = "No passwords. Building a Silicon? It signs in with its secret key from the command line.";

/** The methods as the step lays them out today: providers, "or get a code", the field, the note. */
function Methods({ flow, row, soft }: { flow: HostedFlow; row?: boolean; soft?: boolean }) {
  const providers = flow.methods.filter(isProvider);
  const contacts = contactKinds(flow.methods);
  return (
    <div className={flowStyles.methods}>
      {providers.length ? (
        <div className={row ? styles.providersRow : flowStyles.providers} data-count={providers.length}>
          {providers.map(provider => soft ? (
            // ProviderButton in Silicon UI's soft variant: a light fill, no border (Anil, 2026-11-19).
            <Button key={provider} type="button" variant="soft" className={flowStyles.wide} data-provider={provider} onClick={() => undefined}>
              <span className={flowStyles.providerLabel}>
                {provider === "google" ? <GoogleMark /> : <AppleMark />}
                Continue with {provider === "google" ? "Google" : "Apple"}
              </span>
            </Button>
          ) : <ProviderButton key={provider} provider={provider} onClick={() => undefined} />)}
        </div>
      ) : null}
      {providers.length && contacts.length ? <OrDivider label="or get a code" /> : null}
      {contacts.length ? <ContactForm kinds={contacts} submitLabel="Send Me a Code" onSubmit={quiet} errorContext={{ app: flow.app.name }} /> : null}
    </div>
  );
}

/** The app's own line when it wrote one (its copy is its own); the prototype's when it didn't. */
const lineOf = (flow: HostedFlow) => appSubtitle(flow) ?? "New here? Signing in makes your account.";

/** The prototype's head: the app's logo beside its title and the line under it. */
function RowHead({ flow }: { flow: HostedFlow }) {
  const paint = usePaint(flow.app, false);
  // The split layout already shows the logo beside the form; the panel doesn't repeat it.
  const split = normalizeBranding(flow.app.branding as Partial<Branding> | undefined).layout === "split";
  return (
    <div className={styles.rowHead}>
      {split ? null : <AppIdentity app={flow.app} paint={paint} hideName className={styles.rowLogo} />}
      <StepHeading title={appTitle(flow)} description={lineOf(flow)} appTitle noFocus />
    </div>
  );
}

/** C: the app as its own section (logo, name, its subtitle), in the split layout left to the panel beside the form. */
function AppSection({ flow }: { flow: HostedFlow }) {
  const paint = usePaint(flow.app, false);
  // Only what the app wrote: appSubtitle falls back to the prototype's line, which C already says under its heading.
  const subtitle = flow.app.copy.subtitle?.trim() || null;
  return (
    <section className={styles.appSection} aria-label={flow.app.name}>
      <AppIdentity app={flow.app} paint={paint} hideName className={styles.appLogo} />
      <div className={styles.appText}>
        <p className={styles.appName}>{flow.app.name}</p>
        {subtitle ? <p className={styles.appLine}>{subtitle}</p> : null}
      </div>
    </section>
  );
}

/** C: the panel, in sections. */
function Sections({ flow }: { flow: HostedFlow }) {
  const split = normalizeBranding(flow.app.branding as Partial<Branding> | undefined).layout === "split";
  return (
    <div className={styles.sections}>
      {split ? null : <AppSection flow={flow} />}
      <section className={styles.signinSection}>
        <div className={styles.signinHead}>
          <h1 className={styles.signinTitle}>Sign in with your Team of Silicons account</h1>
          <p className={styles.appLine}>New here? Signing in makes your account.</p>
        </div>
        <Methods flow={flow} />
      </section>
    </div>
  );
}

/** Briefcase's own icon (Anil's, full bleed so the mark's corner shapes it); other apps keep the logo they sent. */
const REAL_ICONS: Record<string, string> = { briefcase: "/icons/briefcase/web/icon-512-maskable.png" };

/** D and E: a mark beside a name and its line, the same for the app and the account. */
function MarkRow({ mark, title, line, heading, quiet }: { mark: ReactNode | null; title: string; line: string | null; heading?: boolean; quiet?: boolean }) {
  const Title = heading ? "h1" : "p";
  return (
    <div className={styles.markRow}>
      {mark}
      <div className={styles.markText}>
        <Title className={heading ? (quiet ? styles.accountQuiet : styles.accountTitle) : styles.appName}>{title}</Title>
        {line ? <p className={styles.markLine}>{line}</p> : null}
      </div>
    </div>
  );
}

function IconRows({ flow, panel, quiet, state = "signin" }: { flow: HostedFlow; panel?: boolean; quiet?: boolean; state?: keyof typeof CASES }) {
  const split = normalizeBranding(flow.app.branding as Partial<Branding> | undefined).layout === "split";
  const app = { app_id: flow.app.app_id, name: flow.app.name, logo_url: REAL_ICONS[flow.app.app_id] ?? flow.app.logo_url ?? null, logo_dark_url: REAL_ICONS[flow.app.app_id] ? null : flow.app.logo_dark_url ?? null };
  return (
    <div className={styles.sectionsD}>
      {split ? null : (
        <section className={styles.appOnly} aria-label={flow.app.name}>
          <MarkRow mark={<AppMark app={app} size={40} decorative className={styles.ringed} />} title={flow.app.name} line={flow.app.copy.subtitle?.trim() || null} />
        </section>
      )}
      <section className={panel ? styles.signinPanel : styles.signinGroup} data-sq={panel ? "surface" : undefined}>
        <MarkRow heading quiet={quiet} mark={null} title={ACCOUNT_HEADING[state]} line={null} />
        {state === "details" ? <ShareDetails flow={flow} /> : state === "accounts" ? <AccountChoices flow={flow} /> : state === "continue" && flow.signed_in_as ? (
          // A browser already signed in: the account and its two choices, the real step's words.
          // The sign-in group's rhythm: 16 between the account and its choices, 8 between the two choices.
          <div className={styles.continueAs}>
            <AccountRow account={flow.signed_in_as} />
            <div className={styles.choices}>
              <Button className={flowStyles.wide} onClick={() => undefined}>Continue as {flow.signed_in_as.display_name.split(/\s+/)[0]}</Button>
              <Button variant="soft" className={flowStyles.wide} onClick={() => undefined}>Use Another Account</Button>
            </div>
          </div>
        ) : <Methods flow={flow} row={quiet} soft />}
      </section>
    </div>
  );
}

export function SigninLab() {
  const [version, setVersion] = useState<Version>("today");
  const [appKey, setAppKey] = useState<keyof typeof APPS>("briefcase");
  const [state, setState] = useState<keyof typeof CASES>("signin");
  const flow = useMemo(() => {
    const chosen = APPS[appKey];
    const app = samplePublic(chosen.id);
    // "No subtitle": the same app with no line of its own, to see what each version says then.
    const base = sampleFlow("bare" in chosen ? { ...app, copy: { ...app.copy, subtitle: null } } : app, CASES[state].scenario);
    return state === "accounts" ? { ...base, step: "select_account" as const, accounts: SAMPLE_ACCOUNTS } : base;
  }, [appKey, state]);
  const option = ([value, label]: [string, string]) => ({ value, label });
  const footer = <FlowFooter flow={flow} step="choose_method" />;

  return (
    <>
      <div className={styles.bar} role="toolbar" aria-label="Sign-in lab">
        <SegmentedControl size="sm" label="Version" options={Object.entries(VERSIONS).map(option)} value={version} onValueChange={value => setVersion(value as Version)} />
        <SegmentedControl size="sm" label="Case" options={Object.entries(CASES).map(([value, entry]) => ({ value, label: entry.label }))} value={state} onValueChange={value => setState(value as keyof typeof CASES)} />
        <SegmentedControl size="sm" label="App" options={Object.entries(APPS).map(([value, entry]) => ({ value, label: entry.label }))} value={appKey} onValueChange={value => setAppKey(value as keyof typeof APPS)} />
      </div>
      {version === "d" || version === "e" || version === "f" ? (
        <HostedFrame key={`${version}-${appKey}`} app={flow.app} title={appTitle(flow)} subtitle={appSubtitle(flow)} plain footer={<div className={styles.dFoot}>{footer}</div>}>
          <IconRows flow={flow} panel={version === "e"} quiet={version === "f"} state={state} />
        </HostedFrame>
      ) : version === "c" ? (
        <HostedFrame key={`c-${appKey}`} app={flow.app} title={appTitle(flow)} subtitle={appSubtitle(flow)} plain footer={<div className={styles.cFoot}>{footer}</div>}>
          <Sections flow={flow} />
        </HostedFrame>
      ) : version === "today" ? (
        <HostedFrame key={`today-${appKey}`} app={flow.app} title={appTitle(flow)} subtitle={appSubtitle(flow)} hideName footer={footer}>
          {state === "details" ? <Details flow={flow} ctl={STUB} notice={null} /> : state === "accounts" ? <SelectAccount flow={flow} ctl={STUB} notice={null} /> : <ChooseMethod flow={flow} ctl={STUB} notice={null} memory={{}} onSent={() => undefined} />}
        </HostedFrame>
      ) : (
        <HostedFrame
          key={`${version}-${appKey}`}
          app={flow.app}
          title={appTitle(flow)}
          subtitle={lineOf(flow)}
          plain
          footer={version === "b" ? (
            <div className={styles.foot}>
              <div className={styles.small}>
                <p className="sa-brand-legal">{NO_PASSWORDS}</p>
                {footer}
              </div>
              <p className={styles.secured}><span className={styles.mark} aria-hidden="true"><AccountsGlyph /></span>One account for every Team of Silicons app</p>
            </div>
          ) : footer}
        >
          <RowHead flow={flow} />
          <Methods flow={flow} />
          {version === "a" ? <p className={flowStyles.methodsNote}>{NO_PASSWORDS}</p> : null}
        </HostedFrame>
      )}
    </>
  );
}
