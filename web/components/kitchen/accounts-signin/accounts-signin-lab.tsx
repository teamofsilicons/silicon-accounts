"use client";

/**
 * /__accounts-signin: /__google-signin's structure (redesign/explorations/google-like/index.html) in the account site's
 * design: a provider bar ("Sign in with Team of Silicons" and our mark) on a card, the heading and its line on the left,
 * the form on the right, the actions at the bottom right, links under the card; one column on a phone. Silicon UI
 * components, the site's tokens and type roles (Allo). Five states: sign in, enter the code, choose an account, share
 * your details, create your account. Sample data (real Briefcase: "Silicon Briefcase", asking for no extra details).
 * Two flows (Anil, 2026-11-19: "can you create the complete flow of this?"): sign in (sign in, check your email, choose
 * an account, share your details, done) and sign up (sign up, check your email, create your account, with the CarbonID
 * taken and finishing an import as its other cases, share your details, done). The pages' own buttons walk the flow.
 * Google's language picker isn't drawn: the site has one language. A Layout switch draws it horizontal (Google's two
 * columns) or vertical (Google's one-column card: the heading, its line and the chip centred over the form; Anil,
 * 2026-11-19: "making it vertical from horizontal while keeping the design").
 */
import Image from "next/image";
import Link from "next/link";
import { createContext, useContext, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Lock, UserPlus, UserRound } from "lucide-react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Input } from "@teamofsilicons/silicon-ui/input";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { LinkItem, Row, Section, Tile } from "@/components/account/parts/rows";
import { AppleMark, GoogleMark, OrDivider } from "@/components/auth/flow/parts";
import { AccountsGlyph } from "@/components/foundation/shell/brand-mark";
import { AppMark } from "@/components/account/parts/app-mark";
import { BrandingScope, PoweredBy } from "@/components/foundation/branding/branding";
import type { Branding } from "@/lib/api/types";
import { SAMPLE_APPS } from "@/components/kitchen/signin/sample-apps";
import { columnsShader } from "@/components/landing/columns-shader";
import { ShaderFill } from "@/components/landing/figma-shader/index";
import { skyColor, skyInk } from "@/lib/sky";
import { paletteName, watercolourShader } from "./watercolour-shader";
import styles from "./accounts-signin-lab.module.css";

const APP_DEFAULT = "Silicon Briefcase";
/**
 * Whose style the pages wear (Anil, 2026-11-19: "what happens when companies want to use their own design"). Default:
 * an app that kept the default branding (Briefcase) gets Accounts' own look, the designs in this lab. The app's own: a
 * sample app's branding (Acme Notes, its colours, fonts and logo) painted by the real BrandingScope, as the hosted pages
 * do; the lab's looks give way to the app's own background, and the bar shows the app instead of Team of Silicons.
 * "Powered by Silicon Accounts" stays under every page either way, outside the app's styling (UNDERSTANDING.md).
 */
type Style = "default" | "app";
const ACME = SAMPLE_APPS["acme-notes"];
const ACME_LINKS = { help: `mailto:${ACME.copy.support_email}`, privacy: ACME.copy.privacy_url, terms: ACME.copy.terms_url };
const TOS_LINKS = { help: "https://teamofsilicons.com/help", privacy: "https://teamofsilicons.com/legal/privacy", terms: "https://teamofsilicons.com/legal/terms" };
const StyleContext = createContext<Style>("default");
/** The app's name as the pages say it: Briefcase in the default style, Acme Notes in the app's own. */
const useAppName = () => (useContext(StyleContext) === "app" ? ACME.name : APP_DEFAULT);

/** Horizontal: Google's two columns. Vertical: Google's one-column card, the heading centred over the form. */
type Layout = "horizontal" | "vertical";
const LayoutContext = createContext<Layout>("horizontal");
/** Moves the lab to another step: the pages' own buttons walk the flow, as a person would. */
const GoContext = createContext<(to: Step) => void>(() => undefined);
/**
 * The page's look (Anil, 2026-11-19: "the aesthetics is really boring and plain… come up with some design"), from what
 * the project already has. Plain: today's. Sky: the sky at the visitor's hour (lib/sky.ts, Create a Silicon's sky bands)
 * under a frosted card. Painted: a painted cloud background (public/banner, Home's introduction; licence still to
 * confirm). App colour: a wash of the app's own icon behind the card, and the app's icon beside ours in the bar.
 * Columns: the landing page's Columns backdrop (WebGPU; plain canvas where the browser has none). Watercolour: a new
 * painting every visit from a seed (watercolour-shader.ts; Anil: "we can generate a new artwork everytime"), kept for
 * the whole flow so it does not change between steps.
 */
type Look = "plain" | "sky" | "painted" | "watercolour" | "app" | "columns";
const LookContext = createContext<Look>("plain");
/** The watercolour's seed, 0..1: one painting for the whole flow, a new one on "New painting" or a reload. */
const SeedContext = createContext(0.5);
const APP_ICON = { app_id: "briefcase", name: APP_DEFAULT, logo_url: "/icons/briefcase/web/icon-512-maskable.png" };

/** Which flow the lab is walking: where "Next" on the code page goes. */
const FlowContext = createContext<"signin" | "signup">("signin");
const ME = { name: "Saket Dev", id: "c:saket", email: "s***@gmail.com" };
const noop = () => undefined;

/** The account as a pill under the heading (Google's chip), in our avatar and squircle. */
function Chip({ label }: { label: string }) {
  return (
    <span className={styles.chip} data-sq="surface">
      <Avatar name={ME.name} size="sm" />
      <span>{label}</span>
      <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

/** The card: the provider bar, then the two columns. */
function Backdrop({ look }: { look: Look }) {
  const seed = useContext(SeedContext);
  const watercolour = useMemo(() => watercolourShader(seed), [seed]);
  const [minutes] = useState(() => { const now = new Date(); return now.getHours() * 60 + now.getMinutes(); });
  if (look === "sky") return <div className={styles.backdrop} aria-hidden="true" style={{ "--sky": skyColor(minutes), "--sky-ink": skyInk(minutes) } as CSSProperties} data-look="sky" />;
  if (look === "painted") return <div className={styles.backdrop} aria-hidden="true" data-look="painted" />;
  if (look === "app") return <div className={styles.backdrop} aria-hidden="true" data-look="app"><Image src={APP_ICON.logo_url} alt="" width={512} height={512} unoptimized className={styles.washIcon} /></div>;
  if (look === "watercolour") return <div className={styles.backdrop} aria-hidden="true" data-look="watercolour"><ShaderFill className={styles.columns} shader={watercolour} /></div>;
  if (look === "columns") return <div className={styles.backdrop} aria-hidden="true" data-look="columns"><ShaderFill className={styles.columns} shader={columnsShader} /></div>;
  return null;
}

function Screen({ left, children }: { left: ReactNode; children: ReactNode }) {
  const layout = useContext(LayoutContext);
  const style = useContext(StyleContext);
  const own = style === "app";
  const look = useContext(LookContext);
  const links = own ? ACME_LINKS : TOS_LINKS;
  const policies = (
    <nav className={styles.under} aria-label="Help and policies">
      <a href={links.help}>Help</a>
      <a href={links.privacy}>Privacy</a>
      <a href={links.terms}>Terms</a>
    </nav>
  );
  if (own) {
    // The app's own: a different page, not our card recoloured (Anil, 2026-11-19: "use a significantly different design
    // for app's own"). Acme's branding asks for the split layout and the dark theme: its side carries its logo and its
    // own words (copy.title, copy.subtitle), the form stands on the page with no card, the steps' headings over it.
    return (
      <div className={styles.hosted}>
        <BrandingScope branding={ACME.branding as unknown as Partial<Branding>} theme={ACME.branding.theme} className={styles.scope}>
          <div className={styles.split}>
            <aside className={styles.splitAside}>
              <span className={styles.splitBrand}>
                <Image src={ACME.branding.logo_dark_url} alt="" width={40} height={40} unoptimized className={styles.splitLogo} />
                {ACME.name}
              </span>
              <div className={styles.splitHero}>
                <p className={styles.splitTitle}>{ACME.copy.title}</p>
                <p className={styles.splitLine}>{ACME.copy.subtitle}</p>
              </div>
            </aside>
            <div className={styles.splitMain}>
              <div className={styles.splitForm}>
                <div className={styles.splitHead}>{left}</div>
                <div className={styles.right}>{children}</div>
              </div>
              {policies}
            </div>
          </div>
        </BrandingScope>
        <PoweredBy theme={ACME.branding.theme} overlay />
      </div>
    );
  }
  const stage = (
    <div className={styles.stage} data-layout={layout} data-look={look}>
      <Backdrop look={look as Look} />
      <div className={styles.card} data-sq="surface">
        <div className={styles.bar}>
          {look === "app" ? <span className={styles.pairMark} aria-hidden="true"><AppMark app={APP_ICON} size={20} decorative /><span className={styles.pairSep}>·</span></span> : null}
              <span className={styles.glyph} aria-hidden="true"><AccountsGlyph /></span>
          Sign in with Team of Silicons
        </div>
        <div className={styles.cols}>
          <div className={styles.left}>{left}</div>
          <div className={styles.right}>{children}</div>
        </div>
      </div>
      {policies}
    </div>
  );
  // Powered by sits outside the app's styling, so no branding can reach it.
  return (
    <div className={styles.hosted}>
      {stage}
      <PoweredBy theme="light" overlay />
    </div>
  );
}

function ToApp() {
  const APP = useAppName();
  return <p className={styles.line}>to continue to <strong className={styles.app}>{APP}</strong></p>;
}

function SignIn() {
  const go = useContext(GoContext);
  return (
    <Screen left={<><h1 className={styles.title}>Sign in</h1><ToApp /></>}>
      {/* Google and Apple first, then the code (Anil, 2026-11-19), as the real methods page orders them. */}
      <div className={styles.stack}>
        <Button variant="soft" className={styles.wide} onClick={noop}><span className={styles.provider}><GoogleMark />Continue with Google</span></Button>
        <Button variant="soft" className={styles.wide} onClick={noop}><span className={styles.provider}><AppleMark />Continue with Apple</span></Button>
      </div>
      <OrDivider label="or get a code" />
      <Input label="Email or phone" autoComplete="username" description="We'll send you a 6-digit code. New here? Signing in makes your account." />
      <div className={styles.actions}><Button onClick={() => go("code")}>Next</Button></div>
    </Screen>
  );
}

function EnterCode() {
  const go = useContext(GoContext);
  const flow = useContext(FlowContext);
  return (
    <Screen left={<><h1 className={styles.title}>Check your email</h1><Chip label={ME.email} /></>}>
      <p className={styles.text}>A 6-digit code was sent to <strong>{ME.email}</strong>. It works for 10 minutes.</p>
      <div className={styles.group}>
        <Input label="Enter code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" />
        <Button variant="link" size="sm" onClick={noop}>Send a New Code</Button>
      </div>
      <div className={styles.actions}><Button variant="ghost" onClick={() => go(flow === "signup" ? "signup" : "signin")}>Try Another Way</Button><Button onClick={() => go(flow === "signup" ? "create" : "choose")}>Next</Button></div>
    </Screen>
  );
}

const ACCOUNTS = [
  { id: "c:saket", detail: "c:saket", org: null, blocked: null },
  { id: "c:saket.studio", detail: "c:saket.studio · The Design Studio", org: "The Design Studio", blocked: null },
  { id: "c:saket.research", detail: "c:saket.research", org: "Research Collective", blocked: "Research Collective doesn't allow this app" },
];

/**
 * Choose an account in the app's own style (Anil, 2026-11-19: "even tho it's a mock, use some sensible design"). Not
 * our boxed list recoloured: each account its own option, told apart by what differs (Personal, or the org's name; the
 * same name and photo on every row says nothing), the one the org blocks quiet and set apart with why, and "Use Another
 * Account" a plain button under the choices rather than a fourth account.
 */
function OwnAccountList() {
  const go = useContext(GoContext);
  const APP = useAppName();
  const open = ACCOUNTS.filter(account => !account.blocked);
  const blocked = ACCOUNTS.filter(account => account.blocked);
  return (
    <div className={styles.ownChoose}>
      <ul className={styles.ownAccounts} aria-label="Your accounts">
        {open.map(account => (
          <li key={account.id}>
            <Link href="#share" className={styles.ownAccount} data-sq="surface" aria-label={`Continue as ${account.id}`} onClick={event => { event.preventDefault(); go("share"); }}>
              <Avatar name={ME.name} size="md" />
              <span className={styles.ownWho}>
                <strong>{account.org ?? "Personal"}</strong>
                <span className={styles.mono}>{account.id}</span>
              </span>
              <ChevronRight className={styles.ownChevron} size={16} strokeWidth={2} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
      {blocked.map(account => (
        <p key={account.id} className={styles.ownBlocked}>
          <Lock size={14} strokeWidth={2} aria-hidden="true" />
          <span><span className={styles.mono}>{account.id}</span> can&apos;t be used here: {account.org} doesn&apos;t allow {APP}.</span>
        </p>
      ))}
      <Button variant="secondary" className={styles.wide} onClick={() => go("signin")}><UserPlus size={16} strokeWidth={2} aria-hidden="true" />Use Another Account</Button>
    </div>
  );
}

/**
 * Choose an account as the site's boxed list (Anil, 2026-11-19: "like list... with full container"): one bordered list,
 * each account a whole row you click, with a chevron (account/parts/rows.tsx LinkItem, as Home, Security and Connected
 * Apps draw lists); the account an org blocks is a plain row with its reason and no chevron; "Use another account" last.
 */
function ChooseAccount() {
  const APP = useAppName();
  const own = useContext(StyleContext) === "app";
  const go = useContext(GoContext);
  // The rows are links in the site's list; in the lab a click walks the flow instead of navigating.
  const choose = (event: MouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest("a");
    if (!row) return;
    event.preventDefault();
    go(row.getAttribute("href") === "#signin" ? "signin" : "share");
  };
  return (
    <Screen left={<><h1 className={styles.title}>Choose an account</h1><ToApp /></>}>
      {own ? <OwnAccountList /> : <div className={styles.list} onClickCapture={choose}>
        <Section id="lab-accounts" label="Your accounts">
          {ACCOUNTS.map(account => account.blocked ? (
            <Row key={account.id} lead={<Avatar name={ME.name} size="sm" />} title={ME.name} detail={<span className={styles.blocked}>{account.blocked}</span>} />
          ) : (
            <LinkItem key={account.id} href="#share" label={`Continue as ${account.id}`} lead={<Avatar name={ME.name} size="sm" />} title={ME.name} detail={account.detail} />
          ))}
          <LinkItem href="#signin" lead={<Tile><UserPlus size={16} strokeWidth={2} /></Tile>} title="Use another account" />
        </Section>
      </div>}
      <p className={styles.note}>To continue, Team of Silicons will share your name, photo and CarbonID with {APP}.</p>
    </Screen>
  );
}

function ShareDetails() {
  const APP = useAppName();
  const go = useContext(GoContext);
  const flow = useContext(FlowContext);
  return (
    <Screen left={<><h1 className={styles.title}>Sign in to {APP}</h1><Chip label={ME.id} /></>}>
      <p className={styles.text}>Team of Silicons will share this with {APP}:</p>
      {/* What's shared as the site's boxed list (Anil: "same here"), as Connected Apps lists what an app sees. */}
      <div className={styles.list}>
        <Section id="lab-shared" label={`What ${APP} gets`}>
          <Row lead={<Tile><UserRound size={16} strokeWidth={2} /></Tile>} title="Name, photo and CarbonID" detail={`${ME.name} · ${ME.id}`} />
        </Section>
      </div>
      <p className={styles.note}>Make sure you trust {APP}. You can see or remove its access any time in <Link href="/apps">Connected Apps</Link>.</p>
      <div className={styles.actions}><Button variant="ghost" onClick={() => go(flow === "signup" ? "signup" : "signin")}>Cancel</Button><Button onClick={() => go("done")}>Continue</Button></div>
    </Screen>
  );
}

/**
 * Sign-up, step 1: the same page as sign in when the app asks for sign-up (intent=signup). The account logic is the same:
 * a first visit makes the account either way.
 */
function SignUp() {
  const go = useContext(GoContext);
  return (
    <Screen left={<><h1 className={styles.title}>Create your account</h1><ToApp /></>}>
      <div className={styles.stack}>
        <Button variant="soft" className={styles.wide} onClick={() => go("create")}><span className={styles.provider}><GoogleMark />Continue with Google</span></Button>
        <Button variant="soft" className={styles.wide} onClick={() => go("create")}><span className={styles.provider}><AppleMark />Continue with Apple</span></Button>
      </div>
      <OrDivider label="or get a code" />
      <Input label="Email or phone" autoComplete="username" description="We'll send you a 6-digit code to check it's yours." />
      <div className={styles.actions}><Button onClick={() => go("code")}>Next</Button></div>
    </Screen>
  );
}

/**
 * Sign-up, step 3, the details page (UNDERSTANDING.md "Sign up"; steps/signup.tsx's words): everything already filled
 * in (name from the provider or the email, a free CarbonID from the email, the default photo; timezone and date of birth
 * go along unseen), the verified address with "Not You?", the photo, Your name, Your CarbonID checked as it's typed, and
 * Create Account. `taken`: the CarbonID is taken, with free ones to pick. `imported`: an app added the Carbon, and they
 * finish that account.
 */
function CreateAccount({ variant = "new" }: { variant?: "new" | "taken" | "imported" }) {
  const APP = useAppName();
  const go = useContext(GoContext);
  const [id, setId] = useState(variant === "taken" ? "saket" : "saket");
  const imported = variant === "imported";
  const taken = variant === "taken" && id === "saket";
  const importer = "Legacy CRM";
  return (
    <Screen
      left={(
        <>
          <h1 className={styles.title}>{imported ? "Finish setting up your account" : `Welcome to ${APP}`}</h1>
          <p className={styles.line}>{imported ? `${importer} added you to Silicon Accounts. Check the details it gave us, then continue to ${APP}.` : "This is how people and Silicons will see you in every app."}</p>
        </>
      )}
    >
      {/* Who proved it: the verified address, and the way out for someone else at this computer. */}
      <div className={styles.verified} data-sq="surface">
        <span className={styles.who}><strong>{ME.email}</strong><span>Verified with a code</span></span>
        <Button size="sm" variant="ghost" onClick={() => go("signup")} aria-label="Not you? Use another account">Not You?</Button>
      </div>
      <div className={styles.photoRow}>
        <Avatar name={ME.name} size="lg" />
        <Button size="sm" variant="soft" onClick={noop}>Change Photo</Button>
      </div>
      <Input label="Your name" defaultValue={ME.name} autoComplete="name" />
      <div className={styles.group}>
        <Input
          label="Your CarbonID"
          prefix="c:"
          value={id}
          onChange={event => setId(event.target.value)}
          error={taken ? "c:saket is taken." : undefined}
          description={taken ? undefined : imported ? `This is the CarbonID ${importer} set up for you. Keep it, or pick another.` : `c:${id} is available. Others type it to find you; you can change it later in Personal info.`}
        />
        {taken ? (
          <div className={styles.suggestions}>
            {["saket-2", "saket-dev"].map(free => <Button key={free} size="xs" variant="soft" onClick={() => setId(free)}>c:{free}</Button>)}
          </div>
        ) : null}
      </div>
      <div className={styles.actions}><Button onClick={() => go("share")}>{imported ? "Finish Setup" : "Create Account"}</Button></div>
    </Screen>
  );
}
const CreateTaken = () => <CreateAccount variant="taken" />;
const CreateImported = () => <CreateAccount variant="imported" />;

/** The last page (steps/complete.tsx's words): signed in, on the way back to the app. */
function Done() {
  const APP = useAppName();
  return (
    <Screen left={<><h1 className={styles.title}>Signed in to {APP}</h1><p className={styles.line}>As <span className={styles.mono}>{ME.id}</span>. Taking you to {APP} now.</p></>}>
      {/* One centred column under the heading: the photo over the name and CarbonID, then the way back, full width. */}
      <div className={styles.doneBlock}>
        <Avatar name={ME.name} size="xl" />
        <span className={styles.doneWho}><strong>{ME.name}</strong><span>{ME.id}</span></span>
      </div>
      <Button variant="secondary" className={styles.wide} onClick={noop}>Continue to {APP}</Button>
    </Screen>
  );
}

const STATES = {
  signin: { label: "Sign in", View: SignIn },
  signup: { label: "Sign up", View: SignUp },
  code: { label: "Check your email", View: EnterCode },
  choose: { label: "Choose an account", View: ChooseAccount },
  create: { label: "Create your account", View: CreateAccount },
  taken: { label: "CarbonID taken", View: CreateTaken },
  imported: { label: "Finish an import", View: CreateImported },
  share: { label: "Share your details", View: ShareDetails },
  done: { label: "Done", View: Done },
} as const;
type Step = keyof typeof STATES;

/** The two flows, in order: the steps a person meets (and, for sign-up, the details page's two other cases). */
const FLOWS: Record<"signin" | "signup", { label: string; steps: Step[] }> = {
  signin: { label: "Sign-in flow", steps: ["signin", "code", "choose", "share", "done"] },
  signup: { label: "Sign-up flow", steps: ["signup", "code", "create", "taken", "imported", "share", "done"] },
};

export function AccountsSigninLab() {
  const [flow, setFlow] = useState<"signin" | "signup">("signin");
  const [state, setState] = useState<Step>("signin");
  const [layout, setLayout] = useState<Layout>("horizontal");
  const [look, setLook] = useState<Look>("painted");
  const [style, setStyle] = useState<Style>("default");
  // Random on every visit; the server's value never reaches the page (the canvas draws only in the browser).
  const [seed, setSeed] = useState(() => Math.random());
  const { View } = STATES[state];
  return (
    <>
      <div className={styles.lab} role="toolbar" aria-label="Accounts sign-in lab">
        <SegmentedControl size="sm" label="Flow" options={Object.entries(FLOWS).map(([value, entry]) => ({ value, label: entry.label }))} value={flow} onValueChange={value => { const next = value as "signin" | "signup"; setFlow(next); setState(FLOWS[next].steps[0]!); }} />
        <SegmentedControl size="sm" label="Step" options={FLOWS[flow].steps.map(step => ({ value: step, label: STATES[step].label }))} value={state} onValueChange={value => setState(value as Step)} />
        <SegmentedControl size="sm" label="Style" options={[{ value: "default", label: "Default (Accounts)" }, { value: "app", label: "App's own (Acme Notes)" }]} value={style} onValueChange={value => setStyle(value as Style)} />
        <SegmentedControl size="sm" label="Look" options={[{ value: "plain", label: "Plain" }, { value: "sky", label: "Sky" }, { value: "painted", label: "Painted" }, { value: "watercolour", label: "Watercolour" }, { value: "app", label: "App colour" }, { value: "columns", label: "Columns" }]} value={look} onValueChange={value => setLook(value as Look)} />
        {look === "watercolour" ? <Button size="sm" variant="secondary" onClick={() => setSeed(Math.random())}>New Painting · {paletteName(seed)}</Button> : null}
        <SegmentedControl size="sm" label="Layout" options={[{ value: "horizontal", label: "Horizontal" }, { value: "vertical", label: "Vertical" }]} value={layout} onValueChange={value => setLayout(value as Layout)} />
      </div>
      <main className={styles.page}>
        <FlowContext.Provider value={flow}>
          <GoContext.Provider value={setState}>
            <StyleContext.Provider value={style}><LookContext.Provider value={look}><SeedContext.Provider value={seed}>
              <LayoutContext.Provider value={layout}><View key={`${state}-${layout}-${style}`} /></LayoutContext.Provider>
            </SeedContext.Provider></LookContext.Provider></StyleContext.Provider>
          </GoContext.Provider>
        </FlowContext.Provider>
      </main>
    </>
  );
}
