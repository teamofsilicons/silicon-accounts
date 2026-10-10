"use client";

/**
 * A live picture of every page a Carbon sees while signing into an app, painted with the app's draft: the same
 * branding runtime as the hosted pages (BrandingScope, BrandStage, BrandAside, BrandPanel), the same Arc controls, and
 * "Powered by Silicon Accounts" outside the branded subtree, linking to accounts.teamofsilicons.com, on every page.
 *
 * Pages (06-v2 §6): the method choice in its sign-in and sign-up versions (intent), the Opening page before Google or
 * Apple, the email and phone code pages, the sign-up details page, each page of the app's flow (a details step, with
 * its own title, subtitle, continue label and layout), the review page, and the embed buttons on the app's own site.
 * Only pages a Carbon can meet with the draft's methods are offered (no Opening Apple without Apple). Each page says
 * what the hosted page says (web/components/auth: steps/*.tsx, flow-page.tsx's footer), word for word, with the sample
 * Carbon below; when those words change there, change them here.
 *
 * A desktop page is laid out at 1024 px and scaled to fit (so the split layout shows as it would); a phone page is
 * 390 px wide. Nothing in it is interactive (inert). Sample values are never a real person.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import { Lock, Mail, Phone, Smartphone } from "lucide-react";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { Button } from "@/components/silicon-ui/button/button";
import { Checkbox } from "@/components/silicon-ui/checkbox/checkbox";
import { Input } from "@/components/silicon-ui/input/input";
import { OtpInput } from "@/components/silicon-ui/otp-input/otp-input";
import { motionTokens } from "@/components/silicon-ui/lib/motion-tokens";
import { BrandAside, BrandPanel, BrandStage, BrandingScope, PoweredBy } from "@/components/foundation/branding/branding";
import type { Branding, ContactField } from "@/lib/api/types";
import { brandLogo, type PaintTheme } from "@/lib/branding/apply";
import { FIELD_LABELS, formatDate } from "@/lib/format";
import { timezoneLabel, utcOffset } from "@/lib/timezones";
import type { EditableConfig } from "../lib/config";
import { effectiveSteps, enabledMethods, pageKey, previewPages, type PreviewPage } from "../lib/preview-pages";
import { AppleMark, GoogleMark } from "../parts/provider-marks";
import styles from "./preview.module.css";

export type PreviewDevice = "desktop" | "phone";

export type { PreviewPage, PreviewPageOption } from "../lib/preview-pages";
export { effectiveSteps, pageKey, previewPages } from "../lib/preview-pages";

const SIZES: Record<PreviewDevice, { width: number; height: number }> = {
  desktop: { width: 1024, height: 700 },
  phone: { width: 390, height: 780 },
};

/**
 * Sample values for the details pages (never a real person), as the hosted pages show them (contact details masked, the
 * date and the timezone in words, with today's offset). The sample Carbon has an email but no phone yet.
 */
function sample(field: ContactField): string | null {
  switch (field) {
    case "email": return "a***@example.com";
    case "phone": return null;
    case "dob": return formatDate("1998-03-14");
    case "timezone": return `${timezoneLabel("Europe/London")} (UTC${utcOffset("Europe/London")})`;
  }
}
/** A phone number the sample Carbon added on an earlier page (a required phone is there by the review). */
const ADDED_PHONE = "+44 7700 ••• 123";
/** The profile row's value, as the hosted pages write it: "Name (id)". */
const PROFILE_VALUE = "Ada Okafor (c:ada)";
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
      return { title: `Almost in to ${app}`, subtitle: `Check what ${app} sees. Nothing is shared until you continue.` };
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

/** Who is signing in, with an action (details.tsx's AccountRow: the photo, the name, the id, "Switch account"). */
function AccountRow({ name, detail, action }: { name: string; detail: string; action: string }) {
  return (
    <div data-sq="surface" className={styles.account}>
      <Avatar name={name} size="md" />
      <span className={styles.accountText}>
        <span className={styles.accountName}>{name}</span>
        <span className={styles.accountDetail}>{detail}</span>
      </span>
      <span className={styles.rowAction}><Button variant="ghost" size="sm" tabIndex={-1}>{action}</Button></span>
    </div>
  );
}

/** Where a code went, with "Change" (parts.tsx's DestinationRow). */
function DestinationRow({ channel, destination }: { channel: "email" | "phone"; destination: string }) {
  return (
    <div data-sq="surface" className={styles.destination}>
      <span className={styles.destinationIcon} aria-hidden="true">{channel === "email" ? <Mail size={16} strokeWidth={1.75} /> : <Smartphone size={16} strokeWidth={1.75} />}</span>
      <span className={styles.destinationText}>{destination}</span>
      <span className={styles.rowAction}><Button variant="ghost" size="sm" tabIndex={-1}>Change</Button></span>
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

/** The Opening page before Google or Apple (steps/opening.tsx, while it moves on by itself). */
function OpeningStep({ appName, config, provider }: { appName: string; config: EditableConfig; provider: "google" | "apple" }) {
  const name = PROVIDER_NAME[provider];
  const title = fill(config.copy.opening_title?.trim() || "Opening {provider} to sign you in to {app}…", appName, name);
  // "Other ways to sign in" leaves for the app's other methods, when it has any.
  const otherWays = enabledMethods(config).length > 1;
  return (
    <div className={styles.opening}>
      <div className={styles.openingMark} aria-hidden="true">
        <span data-sq="surface" className={styles.openingTile}>{provider === "google" ? <GoogleMark size={28} /> : <AppleMark size={28} />}</span>
        <span className={styles.openingDots}><i /><i /><i /></span>
      </div>
      <StepHeading title={title} description={`${name} checks it is you, then brings you back to ${appName}.`} />
      <span className={styles.openingBar} aria-hidden="true"><i /></span>
      <div className={styles.actions}>
        <Button variant="secondary" className={styles.wide} tabIndex={-1}>{provider === "google" ? <GoogleMark size={16} /> : <AppleMark size={16} />}{`Continue to ${name}`}</Button>
        {otherWays ? <button type="button" className={styles.textButton} tabIndex={-1}>Other ways to sign in</button> : null}
      </div>
    </div>
  );
}

/** The 6 digit code page (steps/verify-code.tsx), a code half typed. */
function CodeStep({ channel }: { channel: "email" | "phone" }) {
  const email = channel === "email";
  return (
    <>
      <StepHeading
        title={email ? "Check your email" : "Check your phone"}
        description={`Enter the 6 digit code we ${email ? "emailed" : "texted"} you. It works for 10 minutes.`}
      />
      <DestinationRow channel={channel} destination={email ? "ada@example.com" : "+44 7700 900123"} />
      <OtpInput label={email ? "Code from the email" : "Code from the text message"} value="481" />
      <Button className={styles.wide} tabIndex={-1}>Verify</Button>
      <span className={styles.resend}>Resend code in 0:27</span>
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

/** "Step 1 of 3" with a dot per page (details.tsx's PageProgress). */
function PageProgress({ index, count }: { index: number; count: number }) {
  return (
    <div className={styles.pageProgress}>
      <span className={styles.pageDots} aria-hidden="true">
        {Array.from({ length: count }, (_, position) => <span key={position} data-state={position < index ? "done" : position === index ? "current" : "next"} />)}
      </span>
      <span>{`Step ${Math.min(index + 1, count)} of ${count}`}</span>
    </div>
  );
}

/** Lower-case names for sentences ("Add your phone number"). */
const DETAIL_NAME: Record<ContactField, string> = { email: "email address", phone: "phone number", dob: "date of birth", timezone: "timezone" };
const isContactField = (field: ContactField) => field === "email" || field === "phone";

/** The profile every app sees, first on the first page and on the review. */
function ProfileRow() {
  return (
    <li className={styles.shareRow} data-field="profile">
      <span className={styles.sharedText}>
        <span className={styles.sharedLabel}>Name, id and profile photo</span>
        <span className={styles.sharedValue}>{PROFILE_VALUE}</span>
      </span>
      <span className={styles.shareLock}><Lock size={14} strokeWidth={1.75} aria-hidden="true" /><span>Always</span></span>
    </li>
  );
}

/**
 * One requested detail on a details page (details.tsx's DetailRow): a required one is locked ("Required"), and added
 * below the list first when the account lacks it; an optional one has a checkbox, unticked, and "Add" when it is missing.
 */
function DetailRow({ field, required, adding }: { field: ContactField; required: boolean; adding: boolean }) {
  const value = sample(field);
  const missingText = required ? "Not added yet. Add it below to continue." : "You have not added one, so nothing is shared.";
  const shown = value ?? (adding ? "Adding it below." : missingText);
  if (required) {
    return (
      <li className={styles.shareRow} data-field={field} data-missing={value ? undefined : ""}>
        <span className={styles.sharedText}>
          <span className={styles.sharedLabel}>{FIELD_LABELS[field]}</span>
          <span className={styles.sharedValue}>{shown}</span>
        </span>
        <span className={styles.shareLock}><Lock size={14} strokeWidth={1.75} aria-hidden="true" /><span>Required</span></span>
      </li>
    );
  }
  return (
    <li className={styles.shareRow} data-field={field} data-missing={value ? undefined : ""}>
      <span className={styles.shareCheck}><Checkbox aria-label={`Share ${FIELD_LABELS[field]}`} checked={false} disabled={!value} tabIndex={-1} /></span>
      <span className={styles.sharedText}>
        <span className={styles.sharedLabel}>{FIELD_LABELS[field]}<span className={styles.shareOptional}>Optional</span></span>
        <span className={styles.sharedValue}>{shown}</span>
      </span>
      {!value && isContactField(field) ? <Button variant="ghost" size="sm" tabIndex={-1}>Add</Button> : null}
    </li>
  );
}

/** Adding a missing required email or phone under the list (details.tsx's adder), before the page can continue. */
function Adder({ appName, field }: { appName: string; field: "email" | "phone" }) {
  const phone = field === "phone";
  return (
    <div className={styles.adder}>
      <div className={styles.adderHead}>
        <p className={styles.adderTitle}>{`Add your ${DETAIL_NAME[field]}`}</p>
        <p className={styles.adderText}>{`${appName} needs ${phone ? "a phone number" : "an email address"} on your account. We ${phone ? "text" : "email"} a 6 digit code to make sure it is yours.`}</p>
      </div>
      <div className={styles.form}>
        <Input label={phone ? "Phone number" : "Email"} type={phone ? "tel" : "email"} placeholder={phone ? "+44 7700 900123" : "name@example.com"} description={phone ? "We text a 6 digit code to this number." : "We email a 6 digit code to this address."} readOnly tabIndex={-1} />
        <Button className={styles.wide} tabIndex={-1}>Send code</Button>
      </div>
    </div>
  );
}

/** One page of the app's flow, or the what's-shared page (steps/details.tsx), for the sample Carbon's first visit. */
function DetailsStep({ appName, config, index }: { appName: string; config: EditableConfig; index: number }) {
  const steps = effectiveSteps(config);
  const step = steps[index] ?? steps[0];
  if (!step) return null;
  const first = index === 0;
  const title = step.title?.trim() || defaultStepTitle(appName, step.fields, steps.length);
  const subtitle = step.subtitle?.trim() || defaultStepSubtitle(appName);
  // A required email or phone the sample Carbon lacks opens the adder by itself; the page's main action waits for it.
  const adding = step.fields.find((field): field is "email" | "phone" => isContactField(field) && config.required_fields.includes(field) && !sample(field)) ?? null;
  return (
    <>
      {steps.length > 1 ? <PageProgress index={index} count={steps.length} /> : null}
      <StepHeading title={title} description={subtitle} />
      {first ? <AccountRow name="Ada Okafor" detail="c:ada" action="Switch account" /> : null}
      <ul data-sq="surface" className={styles.shareList} role="list" aria-label={`Details shared with ${appName}`}>
        {first ? <ProfileRow /> : null}
        {step.fields.map(field => <DetailRow key={field} field={field} required={config.required_fields.includes(field)} adding={field === adding} />)}
      </ul>
      {adding ? <Adder appName={appName} field={adding} /> : null}
      <div className={styles.actions}>
        <Button variant={adding ? "secondary" : "primary"} className={styles.wide} tabIndex={-1}>{step.continue_label?.trim() || defaultContinueLabel(index, steps.length, !!config.flow?.review)}</Button>
        {first ? (
          <Button variant="secondary" className={styles.wide} tabIndex={-1}>Cancel</Button>
        ) : (
          <>
            <Button variant="secondary" className={styles.wide} tabIndex={-1}>Back</Button>
            <button type="button" className={styles.textButton} tabIndex={-1}>Cancel signing in</button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * The review page (steps/review.tsx): what the app will see, the profile first, then apart what the Carbon keeps. The
 * sample Carbon shares the required details and leaves every optional one unticked, as the pages start them.
 */
function ReviewStep({ appName, config }: { appName: string; config: EditableConfig }) {
  const fields = effectiveSteps(config).flatMap(step => step.fields);
  const shared = fields.filter(field => config.required_fields.includes(field));
  const kept = fields.filter(field => !config.required_fields.includes(field));
  return (
    <>
      <StepHeading title={`Check what ${appName} sees`} description={defaultStepSubtitle(appName)} />
      <ul data-sq="surface" className={styles.shareList} role="list" aria-label={`Shared with ${appName}`}>
        <ProfileRow />
        {shared.map(field => (
          <li key={field} className={styles.shareRow} data-field={field}>
            <span className={styles.sharedText}>
              <span className={styles.sharedLabel}>{FIELD_LABELS[field]}</span>
              <span className={styles.sharedValue}>{sample(field) ?? ADDED_PHONE}</span>
            </span>
            <span className={styles.shareLock}><Lock size={14} strokeWidth={1.75} aria-hidden="true" /><span>Required</span></span>
          </li>
        ))}
      </ul>
      {kept.length ? (
        <div className={styles.keptBack}>
          <p className={styles.keptTitle}>{`Not shared with ${appName}`}</p>
          <ul data-sq="surface" className={`${styles.shareList} ${styles.quietList}`} role="list" aria-label={`Not shared with ${appName}`}>
            {kept.map(field => (
              <li key={field} className={styles.shareRow} data-field={field}>
                <span className={styles.sharedText}>
                  <span className={styles.sharedLabel}>{FIELD_LABELS[field]}</span>
                  <span className={styles.sharedValue}>{sample(field) === null ? "You have not added one" : "You left it unticked. Go back to share it."}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button className={styles.wide} tabIndex={-1}>Share and continue</Button>
        <Button variant="secondary" className={styles.wide} tabIndex={-1}>Back</Button>
        <button type="button" className={styles.textButton} tabIndex={-1}>Cancel signing in</button>
      </div>
    </>
  );
}

/** The pages' footer (flow-page.tsx's FlowFooter): terms and privacy where the Carbon commits, and the support address. */
function Legal({ appName, config, legal }: { appName: string; config: EditableConfig; legal: boolean }) {
  const copy = config.copy;
  const terms = legal && !!(copy.terms_url || copy.privacy_url);
  if (!terms && !copy.support_email) return null;
  return (
    <div className={styles.footer}>
      {terms ? (
        <p className="sa-brand-legal">
          By continuing, you agree to the{" "}
          {copy.terms_url ? <a href={copy.terms_url} tabIndex={-1}>terms</a> : null}
          {copy.terms_url && copy.privacy_url ? " and " : null}
          {copy.privacy_url ? <a href={copy.privacy_url} tabIndex={-1}>privacy policy</a> : null}
          {" "}of {appName}.
        </p>
      ) : null}
      {copy.support_email ? (
        <p className="sa-brand-legal">Need help? Write to <a href={`mailto:${copy.support_email}`} tabIndex={-1}>{copy.support_email}</a>.</p>
      ) : null}
    </div>
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
            <section data-sq="surface" className={styles.siteCard}>
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
            <section data-sq="surface" className={styles.siteCard}>
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
                  <Legal appName={app.name} config={config} legal={page.kind !== "code"} />
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
