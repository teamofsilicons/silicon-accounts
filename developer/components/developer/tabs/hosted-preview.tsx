"use client";

/**
 * A live picture of every page a Carbon sees while signing into an app, painted with the app's draft: the same
 * branding runtime as the hosted pages (BrandingScope, BrandStage, BrandAside, BrandPanel), the same Arc controls, and
 * "Powered by Silicon Accounts" outside the branded subtree, linking to accounts.teamofsilicons.com, on every page.
 *
 * Pages (06-v2 §6): the method choice in its sign-in and sign-up versions (intent), the Opening page before Google or
 * Apple, the email and phone code pages, the sign-up details page, each page of the app's flow (a details step, with
 * its own title, subtitle, continue label and layout), the review page, and the embed buttons on the app's own site.
 *
 * A desktop page is laid out at 1024 px and scaled to fit (so the split layout shows as it would); a phone page is
 * 390 px wide. Nothing in it is interactive (inert). Sample values are never a real person.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import { Lock, Mail, Phone } from "lucide-react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Button } from "@/components/arc/button/button";
import { Checkbox } from "@/components/arc/checkbox/checkbox";
import { Input } from "@/components/arc/input/input";
import { OtpInput } from "@/components/arc/otp-input/otp-input";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import { BrandAside, BrandPanel, BrandStage, BrandingScope, PoweredBy } from "@/components/foundation/branding/branding";
import type { Branding, ContactField, SigninFlowStep } from "@/lib/api/types";
import { brandLogo, type PaintTheme } from "@/lib/branding/apply";
import { FIELD_LABELS } from "@/lib/format";
import { defaultFlowOf, requestedFields, type EditableConfig } from "../lib/config";
import { AppleMark, GoogleMark } from "../parts/provider-marks";
import styles from "./preview.module.css";

export type PreviewDevice = "desktop" | "phone";

export type PreviewPage =
  | { kind: "methods"; intent: "signin" | "signup" }
  | { kind: "opening"; provider: "google" | "apple" }
  | { kind: "code"; channel: "email" | "phone" }
  | { kind: "signup" }
  | { kind: "details"; index: number }
  | { kind: "review" }
  | { kind: "buttons" };

export interface PreviewPageOption {
  key: string;
  label: string;
  group: string;
  page: PreviewPage;
}

export function pageKey(page: PreviewPage): string {
  switch (page.kind) {
    case "methods": return `methods-${page.intent}`;
    case "opening": return `opening-${page.provider}`;
    case "code": return `code-${page.channel}`;
    case "details": return `details-${page.index}`;
    default: return page.kind;
  }
}

/**
 * The pages a Carbon walks through, as a flow step list: the app's own flow, else the default (one page with every
 * requested detail), else the what's-shared page with only the profile (an app that asks for no details).
 */
export function effectiveSteps(config: EditableConfig): SigninFlowStep[] {
  if (config.flow?.steps.length) return config.flow.steps;
  if (requestedFields(config).length) return defaultFlowOf(config).steps;
  return [{ id: "profile", fields: [], title: null, subtitle: null, continue_label: null, layout: null }];
}

/** Every page of the sign-in, in the order a Carbon meets them. */
export function previewPages(config: EditableConfig): PreviewPageOption[] {
  const out: PreviewPageOption[] = [
    { key: "methods-signin", label: "Sign in", group: "Start", page: { kind: "methods", intent: "signin" } },
    { key: "methods-signup", label: "Sign up", group: "Start", page: { kind: "methods", intent: "signup" } },
    { key: "opening-google", label: "Opening Google", group: "Start", page: { kind: "opening", provider: "google" } },
    { key: "opening-apple", label: "Opening Apple", group: "Start", page: { kind: "opening", provider: "apple" } },
    { key: "code-email", label: "Email code", group: "Verify", page: { kind: "code", channel: "email" } },
    { key: "code-phone", label: "Phone code", group: "Verify", page: { kind: "code", channel: "phone" } },
    { key: "signup", label: "Set up account", group: "Verify", page: { kind: "signup" } },
  ];
  const steps = effectiveSteps(config);
  steps.forEach((step, index) => {
    out.push({
      key: `details-${index}`,
      label: steps.length > 1 ? `Details ${index + 1}${step.title ? `: ${step.title}` : ""}` : step.fields.length ? "What's shared" : "What's shared (profile)",
      group: "Flow",
      page: { kind: "details", index },
    });
  });
  if (config.flow?.review) out.push({ key: "review", label: "Review", group: "Flow", page: { kind: "review" } });
  out.push({ key: "buttons", label: "Embed buttons", group: "Your site", page: { kind: "buttons" } });
  return out;
}

const SIZES: Record<PreviewDevice, { width: number; height: number }> = {
  desktop: { width: 1024, height: 700 },
  phone: { width: 390, height: 780 },
};

/** Sample values for the details pages (never a real person). The sample Carbon has an email but no phone yet. */
const SAMPLE: Record<ContactField, string | null> = { email: "a***@example.com", phone: null, dob: "14 Mar 1998", timezone: "Europe/London" };
const PROVIDER_NAME = { google: "Google", apple: "Apple" } as const;

const fill = (text: string, app: string, provider?: string) => text.replaceAll("{app}", app).replaceAll("{provider}", provider ?? "Google");

const isContact = (field: ContactField) => field === "email" || field === "phone";

/** The title of a details page when the app gave none (the hosted page's own rule, web/components/auth/steps/details.tsx). */
export function defaultStepTitle(app: string, fields: readonly ContactField[], count: number): string {
  if (count <= 1) return `Share your details with ${app}`;
  if (fields.length && fields.every(isContact)) return `How ${app} can reach you`;
  if (fields.length && fields.every(field => !isContact(field))) return "A little about you";
  return `Share your details with ${app}`;
}

/** The subtitle of a details page when the app gave none. */
export function defaultStepSubtitle(app: string): string {
  return `${app} sees these now and whenever they change. You can remove its access at any time in your account.`;
}

/** The continue label of a details page when the app gave none (the hosted pages' rule: the last page says "Review" when a review page follows). */
export function defaultContinueLabel(index: number, count: number, review = false): string {
  if (index < count - 1) return "Continue";
  return review ? "Review" : "Share and continue";
}

/** The split layout's copy beside the form for each page (the hosted pages' rules for a Carbon's first visit). */
function heroFor(app: string, config: EditableConfig, page: PreviewPage): { title: string; subtitle: string | null } {
  const signIn = { title: config.copy.title?.trim() || `Sign in to ${app}`, subtitle: config.copy.subtitle?.trim() || null };
  switch (page.kind) {
    case "methods":
      return page.intent === "signup"
        ? { title: config.copy.signup_title?.trim() || `Create your ${app} account`, subtitle: config.copy.signup_subtitle?.trim() || "One account for every app that signs in with Silicon Accounts." }
        : signIn;
    case "signup":
      return { title: `Welcome to ${app}`, subtitle: "Your account works here and in every other app that signs in with Silicon Accounts." };
    case "details":
      return { title: `Welcome to ${app}`, subtitle: `You choose what ${app} sees, and you can change it any time in your account.` };
    case "review":
      return { title: `Welcome to ${app}`, subtitle: `Check what ${app} sees, then continue.` };
    default:
      return signIn;
  }
}

/** Lays content out at a fixed size and scales it to the available width (and height) without reflowing it. */
function Scaled({ width, height, maxHeight, children }: { width: number; height: number; maxHeight?: number; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = outer.current;
    if (!node) return;
    const apply = () => {
      const available = node.clientWidth || width;
      const scale = Math.min(1, available / width, maxHeight ? maxHeight / height : 1);
      node.style.setProperty("--scale", String(scale));
      node.style.setProperty("--offset", `${Math.max(0, (available - width * scale) / 2)}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, [width, height, maxHeight]);
  return (
    <div ref={outer} className={styles.scaledOuter} style={{ "--w": `${width}px`, "--h": `${height}px` } as CSSProperties}>
      <div className={styles.scaledInner}>{children}</div>
    </div>
  );
}

function StepHeading({ title, description }: { title: string; description?: string | null }) {
  return (
    <div className={styles.stepHeading}>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

function AccountRow({ name, detail, action }: { name: string; detail: string; action: string }) {
  return (
    <div data-sq="surface" className={styles.account}>
      <Avatar name={name} size="sm" />
      <span className={styles.accountText}>
        <span className={styles.accountName}>{name}</span>
        <span className={styles.accountDetail}>{detail}</span>
      </span>
      <span className={styles.textLink}>{action}</span>
    </div>
  );
}

type Block = { kind: "provider"; method: "google" | "apple" } | { kind: "form"; methods: Array<"email" | "phone"> };

function MethodsStep({ config, intent }: { config: EditableConfig; intent: "signin" | "signup" }) {
  const blocks: Block[] = [];
  let form: { kind: "form"; methods: Array<"email" | "phone"> } | null = null;
  for (const method of config.method_order) {
    if (!config.methods[method]) continue;
    if (method === "google" || method === "apple") blocks.push({ kind: "provider", method });
    else if (form) form.methods.push(method);
    else {
      form = { kind: "form", methods: [method] };
      blocks.push(form);
    }
  }
  // Providers next to each other form one group; a divider separates a group from the code form.
  const groups: Block[][] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (last && block.kind === "provider" && last[0]?.kind === "provider") last.push(block);
    else groups.push([block]);
  }
  if (!blocks.length) return <p className={styles.empty}>No sign-in method is on. Turn one on in the Sign-in tab.</p>;
  const verb = intent === "signup" ? "Sign up with" : "Continue with";
  return (
    <>
      {groups.map((group, index) => {
        const first = group[0];
        return (
          <div key={index} className={styles.step}>
            {index > 0 ? <div className={styles.divider}>or</div> : null}
            {first?.kind === "form" ? (
              <div className={styles.form}>
                {first.methods[0] === "email"
                  ? <Input label="Email" type="email" placeholder="name@example.com" readOnly tabIndex={-1} />
                  : <Input label="Phone number" type="tel" placeholder="+1 202 555 0142" readOnly tabIndex={-1} />}
                <Button className={styles.wide} tabIndex={-1}>{intent === "signup" ? "Create account" : "Continue"}</Button>
                {first.methods.length > 1 ? <span className={styles.textLink}>{first.methods[0] === "email" ? "Use a phone number instead" : "Use an email instead"}</span> : null}
              </div>
            ) : (
              <div className={styles.providers}>
                {group.map(block => block.kind === "provider" ? (
                  <Button key={block.method} variant="secondary" className={styles.providerButton} tabIndex={-1}>
                    {block.method === "google" ? <GoogleMark size={16} /> : <AppleMark size={16} />}
                    {`${verb} ${PROVIDER_NAME[block.method]}`}
                  </Button>
                ) : null)}
              </div>
            )}
          </div>
        );
      })}
      {intent === "signin" ? (
        <p className={styles.small}>{config.allow_signup ? "New here? Your account is created as you sign in." : "Only existing accounts can sign in here."}</p>
      ) : (
        <p className={styles.small}>{config.allow_signup ? "Already have an account? Sign in instead." : "This app only lets existing accounts in; new accounts can't be created here."}</p>
      )}
    </>
  );
}

function OpeningStep({ appName, config, provider }: { appName: string; config: EditableConfig; provider: "google" | "apple" }) {
  const name = PROVIDER_NAME[provider];
  const title = fill(config.copy.opening_title?.trim() || "Opening {provider} to sign you in to {app}…", appName, name);
  return (
    <div className={styles.opening}>
      <span className={styles.openingMark} aria-hidden="true">{provider === "google" ? <GoogleMark size={28} /> : <AppleMark size={28} />}</span>
      <StepHeading title={title} description={`${name} asks you to choose an account, then you come straight back.`} />
      <span className={styles.openingBar} aria-hidden="true"><i /></span>
      <Button variant="secondary" className={styles.wide} tabIndex={-1}>{provider === "google" ? <GoogleMark size={16} /> : <AppleMark size={16} />}{`Continue to ${name}`}</Button>
    </div>
  );
}

function CodeStep({ channel }: { channel: "email" | "phone" }) {
  const email = channel === "email";
  return (
    <>
      <StepHeading
        title={email ? "Check your email" : "Check your messages"}
        description={email ? "We sent a 6 digit code to a***@example.com. It expires in 10 minutes." : "We sent a 6 digit code by SMS to +44 7700 ••• 123. It expires in 10 minutes."}
      />
      <AccountRow name={email ? "ada@example.com" : "+44 7700 900123"} detail="Sign-in code sent" action="Change" />
      <OtpInput label="Verification code" value="481" />
      <Button className={styles.wide} tabIndex={-1}>Verify</Button>
      <span className={styles.resend}>Send a new code in 0:27</span>
    </>
  );
}

function SignupStep() {
  return (
    <>
      <StepHeading title="Set up your account" description="Everything is filled in from your sign-in. Change anything you like." />
      <div className={styles.signupPhoto}>
        <Avatar name="Ada Okafor" size="lg" />
        <span className={styles.textLink}>Change photo</span>
      </div>
      <Input label="Display name" value="Ada Okafor" readOnly tabIndex={-1} />
      <Input label="Id" value="c:ada" description="c:ada is available." readOnly tabIndex={-1} />
      <div className={styles.pair}>
        <Input label="Timezone" value="Europe/London" readOnly tabIndex={-1} />
        <Input label="Date of birth" value="14 Mar 1998" readOnly tabIndex={-1} />
      </div>
      <Button className={styles.wide} tabIndex={-1}>Continue</Button>
    </>
  );
}

/** One requested detail on a details page: required ones are shared (or added first when missing), optional ones unticked. */
function DetailRow({ field, required }: { field: ContactField; required: boolean }) {
  const value = SAMPLE[field];
  if (required && !value) {
    return (
      <li className={styles.missing}>
        <span className={styles.sharedText}><span>{FIELD_LABELS[field]}</span><span className={styles.sharedValue}>Required: add it to continue</span></span>
        <div className={styles.addRow}>
          <Input label={field === "phone" ? "Phone number" : "Email"} type={field === "phone" ? "tel" : "email"} placeholder={field === "phone" ? "+44 7700 900123" : "name@example.com"} readOnly tabIndex={-1} />
          <Button variant="secondary" size="sm" tabIndex={-1}>Send code</Button>
        </div>
      </li>
    );
  }
  return (
    <li>
      <span className={styles.sharedText}><span>{FIELD_LABELS[field]}</span><span className={styles.sharedValue}>{value ?? "Not on your account yet"}</span></span>
      {required ? <Lock size={14} strokeWidth={1.75} aria-hidden="true" className={styles.lock} /> : <Checkbox aria-label={`Share ${FIELD_LABELS[field]}`} checked={false} tabIndex={-1} />}
    </li>
  );
}

function DetailsStep({ appName, config, index }: { appName: string; config: EditableConfig; index: number }) {
  const steps = effectiveSteps(config);
  const step = steps[index] ?? steps[0];
  if (!step) return null;
  const title = step.title?.trim() || defaultStepTitle(appName, step.fields, steps.length);
  const subtitle = step.subtitle?.trim() || defaultStepSubtitle(appName);
  return (
    <>
      <StepHeading title={title} description={subtitle} />
      {index === 0 ? <AccountRow name="Ada Okafor" detail="c:ada" action="Switch" /> : null}
      <ul className={styles.shared} role="list">
        {index === 0 ? (
          <li>
            <span className={styles.sharedText}><span>Name, id and profile photo</span><span className={styles.sharedValue}>Ada Okafor · c:ada</span></span>
            <Lock size={14} strokeWidth={1.75} aria-hidden="true" className={styles.lock} />
          </li>
        ) : null}
        {step.fields.map(field => <DetailRow key={field} field={field} required={config.required_fields.includes(field)} />)}
      </ul>
      <div className={styles.actions}>
        <Button className={styles.wide} tabIndex={-1}>{step.continue_label?.trim() || defaultContinueLabel(index, steps.length, !!config.flow?.review)}</Button>
        <Button variant="ghost" className={styles.wide} tabIndex={-1}>{index > 0 ? "Back" : "Cancel"}</Button>
      </div>
    </>
  );
}

function ReviewStep({ appName, config }: { appName: string; config: EditableConfig }) {
  const fields = requestedFields(config);
  return (
    <>
      <StepHeading title={`Check what ${appName} sees`} description={defaultStepSubtitle(appName)} />
      <ul className={styles.shared} role="list">
        <li>
          <span className={styles.sharedText}><span>Name, id and profile photo</span><span className={styles.sharedValue}>Ada Okafor · c:ada</span></span>
          <Lock size={14} strokeWidth={1.75} aria-hidden="true" className={styles.lock} />
        </li>
        {fields.map(field => {
          const required = config.required_fields.includes(field);
          return (
            <li key={field}>
              <span className={styles.sharedText}><span>{FIELD_LABELS[field]}</span><span className={styles.sharedValue}>{required ? SAMPLE[field] ?? "+44 7700 900123 (just added)" : "Not shared (you left it unticked)"}</span></span>
              {required ? <Lock size={14} strokeWidth={1.75} aria-hidden="true" className={styles.lock} /> : null}
            </li>
          );
        })}
      </ul>
      <div className={styles.actions}>
        <Button className={styles.wide} tabIndex={-1}>Share and continue</Button>
        <Button variant="ghost" className={styles.wide} tabIndex={-1}>Back</Button>
      </div>
    </>
  );
}

function Legal({ appName, config }: { appName: string; config: EditableConfig }) {
  const copy = config.copy;
  return (
    <>
      {copy.terms_url || copy.privacy_url ? (
        <p className="sa-brand-legal">
          By continuing you accept the{" "}
          {copy.terms_url ? <a href={copy.terms_url} tabIndex={-1}>terms</a> : null}
          {copy.terms_url && copy.privacy_url ? " and " : null}
          {copy.privacy_url ? <a href={copy.privacy_url} tabIndex={-1}>privacy policy</a> : null}
          {" "}of {appName}.
        </p>
      ) : null}
      {copy.support_email ? (
        <p className="sa-brand-legal"><Mail size={12} strokeWidth={1.75} aria-hidden="true" className={styles.inlineIcon} />Need help? {copy.support_email}</p>
      ) : null}
    </>
  );
}

/** The app's own site with the buttons the SDK and the embed render: direct method buttons, and Sign in / Sign up. */
function ButtonsPage({ appName, config, theme }: { appName: string; config: EditableConfig; theme: PaintTheme }) {
  const methods = config.method_order.filter(method => config.methods[method]);
  const label = { google: "Continue with Google", apple: "Continue with Apple", email: "Continue with email", phone: "Continue with phone number" } as const;
  return (
    <div className={styles.site} data-theme={theme}>
      <div className={styles.siteBar}><b>{appName}</b><span>Pricing</span><span>Docs</span><span className={styles.siteSpacer} /><span>Log in</span></div>
      <div className={styles.siteBody}>
        <BrandingScope branding={config.branding} theme={theme} className={styles.siteScope}>
          <div className={styles.siteColumns}>
            <section className={styles.siteCard}>
              <p className={styles.siteEyebrow}>Direct buttons</p>
              <h2 className={styles.siteTitle}>{`Welcome to ${appName}`}</h2>
              <div className={styles.siteButtons}>
                {methods.length ? methods.map(method => (
                  <Button key={method} variant={method === "email" ? "primary" : "secondary"} className={styles.wide} tabIndex={-1}>
                    {method === "google" ? <GoogleMark size={16} /> : method === "apple" ? <AppleMark size={16} /> : method === "email" ? <Mail size={16} strokeWidth={1.75} aria-hidden="true" /> : <Phone size={16} strokeWidth={1.75} aria-hidden="true" />}
                    {label[method]}
                  </Button>
                )) : <p className={styles.empty}>No sign-in method is on.</p>}
              </div>
            </section>
            <section className={styles.siteCard}>
              <p className={styles.siteEyebrow}>Sign in and Sign up</p>
              <h2 className={styles.siteTitle}>Two buttons, the rest on our pages</h2>
              <div className={styles.siteButtons}>
                <Button className={styles.wide} tabIndex={-1}>Sign up</Button>
                <Button variant="secondary" className={styles.wide} tabIndex={-1}>Sign in</Button>
              </div>
            </section>
          </div>
        </BrandingScope>
        <PoweredBy theme={theme} className={styles.sitePowered} />
      </div>
    </div>
  );
}

export interface HostedPreviewProps {
  app: { name: string; logo_url: string | null; logo_dark_url?: string | null };
  config: EditableConfig;
  theme: PaintTheme;
  page: PreviewPage;
  device: PreviewDevice;
  /** Host shown in the desktop address bar (the accounts site). */
  host: string;
  /** The tallest the preview may get (the window minus the editor's chrome). */
  maxHeight?: number;
}

const ORDER: PreviewPage["kind"][] = ["methods", "opening", "code", "signup", "details", "review", "buttons"];
const rank = (page: PreviewPage) => ORDER.indexOf(page.kind) * 10 + (page.kind === "details" ? page.index : 0);

export function HostedPreview({ app, config, theme, page, device, host, maxHeight }: HostedPreviewProps) {
  const reduced = useReducedMotion();
  const size = SIZES[device];
  const steps = effectiveSteps(config);
  const stepLayout = page.kind === "details" ? steps[page.index]?.layout ?? null : null;
  const branding: Branding = stepLayout ? { ...config.branding, layout: stepLayout } : config.branding;
  const logo = brandLogo(branding, { logo_url: app.logo_url, logo_dark_url: app.logo_dark_url ?? null }, theme);
  const hero = heroFor(app.name, config, page);
  const header = (
    <div className="sa-brand-header">
      {/* eslint-disable-next-line @next/next/no-img-element -- app logos are arbitrary https or data URLs, shown as is. */}
      {logo ? <img className="sa-brand-logo" src={logo} alt="" /> : null}
      {branding.show_app_name || !logo ? <span className="sa-brand-name">{app.name}</span> : null}
    </div>
  );
  const key = pageKey(page);
  const label = `Preview of the ${app.name} sign-in: ${previewPages(config).find(option => option.key === key)?.label ?? key}, ${theme} theme, ${device}`;
  const phoneScale = Math.min(1, maxHeight ? maxHeight / size.height : 1);
  // Later pages arrive from the right, earlier ones from the left, like the hosted card.
  const [shown, setShown] = useState(page);
  const [direction, setDirection] = useState(1);
  if (pageKey(shown) !== key) {
    setShown(page);
    setDirection(rank(page) >= rank(shown) ? 1 : -1);
  }
  const stepMotion: Variants = {
    enter: (dir: number) => (reduced ? { opacity: 0 } : { opacity: 0, x: dir * 24, filter: `blur(${motionTokens.blur.soft}px)` }),
    center: { opacity: 1, x: 0, filter: "blur(0px)" },
    exit: (dir: number) => (reduced
      ? { opacity: 0, transition: { duration: 0 } }
      : { opacity: 0, x: dir * -18, filter: `blur(${motionTokens.blur.soft}px)`, transition: { duration: motionTokens.duration.exit } }),
  };
  const showsTitle = page.kind === "methods";
  const address = page.kind === "buttons" ? `${app.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example` : page.kind === "opening" ? `${host}/authorize?app_id=…&method=${page.provider}` : `${host}/authorize?app_id=…${page.kind === "methods" && page.intent === "signup" ? "&intent=signup" : ""}`;

  let body: ReactNode;
  switch (page.kind) {
    case "methods": body = <MethodsStep config={config} intent={page.intent} />; break;
    case "opening": body = <OpeningStep appName={app.name} config={config} provider={page.provider} />; break;
    case "code": body = <CodeStep channel={page.channel} />; break;
    case "signup": body = <SignupStep />; break;
    case "details": body = <DetailsStep appName={app.name} config={config} index={page.index} />; break;
    case "review": body = <ReviewStep appName={app.name} config={config} />; break;
    default: body = null;
  }
  const title = page.kind === "methods" && page.intent === "signup"
    ? config.copy.signup_title?.trim() || `Create your ${app.name} account`
    : config.copy.title?.trim() || `Sign in to ${app.name}`;
  const subtitle = page.kind === "methods" && page.intent === "signup" ? config.copy.signup_subtitle?.trim() || null : config.copy.subtitle?.trim() || null;

  return (
    <div
      data-sq="surface"
      className={styles.frame}
      data-device={device}
      role="img"
      aria-label={label}
      style={device === "phone" ? ({ "--phone-width": `${Math.round(size.width * phoneScale) + 20}px` } as CSSProperties) : undefined}
    >
      {device === "desktop" ? (
        <div className={styles.chrome} aria-hidden="true">
          <span className={styles.dots}><i /><i /><i /></span>
          <span data-sq="surface" className={styles.address}>{address}</span>
        </div>
      ) : null}
      <Scaled width={size.width} height={size.height} maxHeight={maxHeight}>
        {page.kind === "buttons" ? (
          <div data-sq="clip" className={styles.page} inert aria-hidden="true">
            <ButtonsPage appName={app.name} config={config} theme={theme} />
          </div>
        ) : (
          <div data-sq="clip" className={styles.page} data-layout={branding.layout} data-opening={page.kind === "opening" || undefined} inert aria-hidden="true">
            <BrandingScope branding={branding} theme={theme} className={styles.scope}>
              <BrandStage>
                <BrandAside>
                  {header}
                  <div>
                    <h2 className="sa-brand-title">{hero.title}</h2>
                    {hero.subtitle ? <p className="sa-brand-subtitle">{hero.subtitle}</p> : null}
                  </div>
                </BrandAside>
                <BrandPanel as="section">
                  {header}
                  {showsTitle ? (
                    <>
                      <h1 className="sa-brand-title">{title}</h1>
                      {subtitle ? <p className="sa-brand-subtitle">{subtitle}</p> : null}
                      <p className={styles.splitLabel}>{page.intent === "signup" ? "Create account" : "Sign in"}</p>
                    </>
                  ) : null}
                  <div className="sa-brand-body">
                    <div className={styles.stepTrack}>
                      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
                        <motion.div
                          key={key}
                          className={styles.step}
                          custom={direction}
                          variants={stepMotion}
                          initial="enter"
                          animate="center"
                          exit="exit"
                          transition={reduced ? { duration: motionTokens.duration.instant } : { x: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, delay: 0.04 }, filter: { duration: motionTokens.duration.standard } }}
                        >
                          {body}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  </div>
                  {page.kind === "opening" ? null : <Legal appName={app.name} config={config} />}
                </BrandPanel>
              </BrandStage>
            </BrandingScope>
            <PoweredBy theme={theme} overlay className={styles.powered} />
          </div>
        )}
      </Scaled>
    </div>
  );
}
