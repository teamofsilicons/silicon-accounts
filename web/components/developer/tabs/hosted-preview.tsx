"use client";

/**
 * A live picture of the hosted sign-in page as an app's draft paints it: the same branding runtime (BrandingScope,
 * BrandStage, BrandAside, BrandPanel), the same Arc controls, and "Powered by Silicon Accounts" outside the branded
 * subtree, as the hosted pages render them. A desktop page is laid out at 1024 px and scaled to fit (so the split
 * layout shows as it would); a phone page is 390 px wide. Nothing in it is interactive (inert).
 *
 * The split layout follows the hosted page's rules: the big copy beside the form is the hosted page's own (heroCopyFor in
 * components/auth/flow/model.ts, for a Carbon's first visit: the app's title and subtitle on the sign-in steps,
 * "Welcome to …" from setting up on), a short "Sign in" heads the form on the first step, and "Powered by" sits in the
 * form's half.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import { Lock, Mail } from "lucide-react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { OtpInput } from "@/components/arc/otp-input/otp-input";
import { Switch } from "@/components/arc/switch/switch";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import { heroCopyFor, type HeroCopy } from "@/components/auth/flow/model";
import { BrandAside, BrandPanel, BrandStage, BrandingScope, PoweredBy } from "@/components/foundation/branding/branding";
import type { ContactField, FlowStep } from "@/lib/api/types";
import { brandLogo, type PaintTheme } from "@/lib/branding/apply";
import { FIELD_LABELS } from "@/lib/format";
import type { EditableConfig } from "../lib/config";
import { AppleMark, GoogleMark } from "../parts/provider-marks";
import styles from "./preview.module.css";

export type PreviewStep = "methods" | "code" | "signup" | "consent";
export type PreviewDevice = "desktop" | "phone";

export const PREVIEW_STEPS: Array<{ value: PreviewStep; label: string }> = [
  { value: "methods", label: "Sign in" },
  { value: "code", label: "Code" },
  { value: "signup", label: "Set up" },
  { value: "consent", label: "Consent" },
];

const STEP_ORDER: PreviewStep[] = ["methods", "code", "signup", "consent"];
const SIZES: Record<PreviewDevice, { width: number; height: number }> = {
  desktop: { width: 1024, height: 700 },
  phone: { width: 390, height: 780 },
};

const FLOW_STEPS: Record<PreviewStep, FlowStep> = { methods: "choose_method", code: "verify_code", signup: "signup", consent: "consent" };

/** The split layout's copy beside the form at a step, by the hosted page's rules, for a Carbon's first visit. */
function heroAt(app: HostedPreviewProps["app"], config: EditableConfig, step: PreviewStep): HeroCopy {
  return heroCopyFor({ name: app.name, copy: config.copy, step: FLOW_STEPS[step], firstVisit: true });
}

/** Sample values for the what's-shared rows (never a real person). */
const SAMPLE: Record<ContactField, string> = { email: "ada@example.com", phone: "+44 7700 900123", dob: "Mar 14, 1998", timezone: "Europe/London" };

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

function StepHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className={styles.stepHeading}>
      <h2>{title}</h2>
      <p>{description}</p>
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

function MethodsStep({ config }: { config: EditableConfig }) {
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
                <Button className={styles.wide} tabIndex={-1}>Continue</Button>
                {first.methods.length > 1 ? <span className={styles.textLink}>{first.methods[0] === "email" ? "Use a phone number instead" : "Use an email instead"}</span> : null}
              </div>
            ) : (
              <div className={styles.providers}>
                {group.map(block => block.kind === "provider" ? (
                  <Button key={block.method} variant="secondary" className={styles.providerButton} tabIndex={-1}>
                    {block.method === "google" ? <GoogleMark size={16} /> : <AppleMark size={16} />}
                    {block.method === "google" ? "Continue with Google" : "Continue with Apple"}
                  </Button>
                ) : null)}
              </div>
            )}
          </div>
        );
      })}
      {!config.allow_signup ? <p className={styles.small}>Only existing accounts can sign in here.</p> : null}
    </>
  );
}

function CodeStep() {
  return (
    <>
      <StepHeading title="Check your email" description="We sent a 6 digit code to a***@example.com. It expires in 10 minutes." />
      <AccountRow name="ada@example.com" detail="Sign-in code sent" action="Change" />
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
        <Input label="Date of birth" value="Mar 14, 1998" readOnly tabIndex={-1} />
      </div>
      <Button className={styles.wide} tabIndex={-1}>Continue</Button>
    </>
  );
}

function ConsentStep({ appName, config }: { appName: string; config: EditableConfig }) {
  return (
    <>
      <StepHeading title={`${appName} would like to know`} description="It sees only what is listed here." />
      <AccountRow name="Ada Okafor" detail="c:ada" action="Switch" />
      <ul className={styles.shared} role="list">
        <li>
          <span className={styles.sharedText}><span>Name, id and profile photo</span><span className={styles.sharedValue}>Ada Okafor · c:ada</span></span>
          <Lock size={14} strokeWidth={1.75} aria-hidden="true" className={styles.lock} />
        </li>
        {config.required_fields.map(field => (
          <li key={`required-${field}`}>
            <span className={styles.sharedText}><span>{FIELD_LABELS[field]}</span><span className={styles.sharedValue}>{SAMPLE[field]}</span></span>
            <Lock size={14} strokeWidth={1.75} aria-hidden="true" className={styles.lock} />
          </li>
        ))}
        {config.optional_fields.map(field => (
          <li key={`optional-${field}`}>
            <span className={styles.sharedText}><span>{FIELD_LABELS[field]}</span><span className={styles.sharedValue}>{SAMPLE[field]}</span></span>
            <Switch aria-label={`Share ${FIELD_LABELS[field]}`} defaultChecked tabIndex={-1} />
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <Button className={styles.wide} tabIndex={-1}>Share and continue</Button>
        <Button variant="ghost" className={styles.wide} tabIndex={-1}>Cancel</Button>
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

export interface HostedPreviewProps {
  app: { name: string; logo_url: string | null; logo_dark_url?: string | null };
  config: EditableConfig;
  theme: PaintTheme;
  step: PreviewStep;
  device: PreviewDevice;
  /** Host shown in the desktop address bar. */
  host: string;
  /** The tallest the preview may get (the window minus the editor's chrome). */
  maxHeight?: number;
}

export function HostedPreview({ app, config, theme, step, device, host, maxHeight }: HostedPreviewProps) {
  const reduced = useReducedMotion();
  const size = SIZES[device];
  const branding = config.branding;
  const logo = brandLogo(branding, { logo_url: app.logo_url, logo_dark_url: app.logo_dark_url ?? null }, theme);
  const title = config.copy.title?.trim() || `Sign in to ${app.name}`;
  const subtitle = config.copy.subtitle?.trim() || null;
  const hero = heroAt(app, config, step);
  const header = (
    <div className="sa-brand-header">
      {/* eslint-disable-next-line @next/next/no-img-element -- app logos are arbitrary https or data URLs, shown as is. */}
      {logo ? <img className="sa-brand-logo" src={logo} alt="" /> : null}
      {branding.show_app_name || !logo ? <span className="sa-brand-name">{app.name}</span> : null}
    </div>
  );
  const label = `Preview of the ${app.name} sign-in page: ${theme} theme, ${device}, ${PREVIEW_STEPS.find(entry => entry.value === step)?.label.toLowerCase()} step`;
  const phoneScale = Math.min(1, maxHeight ? maxHeight / size.height : 1);
  // Later steps arrive from the right, earlier ones from the left, like the hosted card.
  const [shownStep, setShownStep] = useState(step);
  const [direction, setDirection] = useState(1);
  if (shownStep !== step) {
    setShownStep(step);
    setDirection(STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf(shownStep) ? 1 : -1);
  }
  const stepMotion: Variants = {
    enter: (dir: number) => (reduced ? { opacity: 0 } : { opacity: 0, x: dir * 24, filter: `blur(${motionTokens.blur.soft}px)` }),
    center: { opacity: 1, x: 0, filter: "blur(0px)" },
    exit: (dir: number) => (reduced
      ? { opacity: 0, transition: { duration: 0 } }
      : { opacity: 0, x: dir * -18, filter: `blur(${motionTokens.blur.soft}px)`, transition: { duration: motionTokens.duration.exit } }),
  };

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
          <span data-sq="surface" className={styles.address}>{host}/authorize?app_id=…</span>
        </div>
      ) : null}
      <Scaled width={size.width} height={size.height} maxHeight={maxHeight}>
        <div data-sq="clip" className={styles.page} data-layout={branding.layout} inert aria-hidden="true">
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
                {step === "methods" ? (
                  <>
                    <h1 className="sa-brand-title">{title}</h1>
                    {subtitle ? <p className="sa-brand-subtitle">{subtitle}</p> : null}
                    <p className={styles.splitLabel}>Sign in</p>
                  </>
                ) : null}
                <div className="sa-brand-body">
                  <div className={styles.stepTrack}>
                    <AnimatePresence mode="popLayout" initial={false} custom={direction}>
                      <motion.div
                        key={step}
                        className={styles.step}
                        custom={direction}
                        variants={stepMotion}
                        initial="enter"
                        animate="center"
                        exit="exit"
                        transition={reduced ? { duration: motionTokens.duration.instant } : { x: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, delay: 0.04 }, filter: { duration: motionTokens.duration.standard } }}
                      >
                        {step === "methods" ? <MethodsStep config={config} />
                          : step === "code" ? <CodeStep />
                            : step === "signup" ? <SignupStep />
                              : <ConsentStep appName={app.name} config={config} />}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>
                <Legal appName={app.name} config={config} />
              </BrandPanel>
            </BrandStage>
          </BrandingScope>
          <PoweredBy theme={theme} overlay className={styles.powered} />
        </div>
      </Scaled>
    </div>
  );
}
