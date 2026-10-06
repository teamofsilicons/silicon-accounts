/**
 * Arc sign-in block, ported to Solid as the parts the hosted sign-in is built from:
 *   SignInCard        a card whose content morphs between steps (old step slides out blurred, new one in, height springs)
 *   SignInHeading     the step's title (display face) and one line of context
 *   ProviderButton    "Continue with Google / Apple" with the real marks (Google's four colours, Apple in currentColor)
 *   SignInDivider     "or" between hairlines
 *   AccountRow        the account being signed in to (photo, address, Change)
 *   ResendButton      "Resend code in 0:27" with rolling digits, then "Resend code"
 *   SignInSuccess     the signed-in moment: a ring draws around the photo and a check pops in
 *   SignInDemo        the whole block with simulated timings (style guide only)
 * Everything follows the Arc tokens, so inside BrandingScope it takes the app's branding.
 */
import { Index, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { Check } from "lucide-solid";
import { Avatar } from "../../avatar/avatar";
import { Button } from "../../button/button";
import { Input } from "../../input/input";
import { OtpInput } from "../../otp-input/otp-input";
import { HeightFrame } from "../../lib/HeightFrame";
import { Swap, SwapText } from "../../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../../lib/motion";
import { cx } from "../../lib/cx";
import { useSquircle } from "../../lib/squircle";
import styles from "./sign-in.module.css";

const enterEase = [...motionTokens.ease.enter] as [number, number, number, number];
const standardEase = [...motionTokens.ease.standard] as [number, number, number, number];

/* ------------------------------------------------------------------------------------------------------------------ */
/* Card with step morph                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface SignInCardProps<S extends string> {
  /** The current step. A new step morphs the card. */
  step: S;
  /** +1 moves forward (new content from the right), -1 back. Defaults to +1. */
  direction?: number;
  /** Renders a step. Kept mounted while its step leaves, so render from the step you are given. */
  children: (step: S) => JSX.Element;
  /** A footer line under the card's content (status, "No account? Sign up"). */
  footer?: JSX.Element;
  /** Accessible name of the region. */
  label?: string;
  class?: string;
  /** Draw no card chrome (border, background): for branded layouts that provide their own panel. */
  bare?: boolean;
}

export function SignInCard<S extends string>(props: SignInCardProps<S>) {
  const direction = () => props.direction ?? 1;
  return (
    <section ref={el => { if (!props.bare) useSquircle(el); }} class={cx(styles.card, props.bare && styles.bare, props.class)} aria-label={props.label ?? "Sign in"}>
      <HeightFrame morphKey={props.step} class={styles.viewport} contentClass={styles.track}>
        <Swap
          value={props.step}
          as="div"
          class={styles.step}
          enter={el => {
            if (prefersReducedMotion()) return animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant));
            return animate(
              el,
              { opacity: [0, 1], x: [direction() * 28, 0], filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"] },
              { x: spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: enterEase, delay: 0.05 }, filter: { duration: motionTokens.duration.standard, ease: enterEase } },
            );
          }}
          exit={el => {
            el.setAttribute("inert", "");
            if (prefersReducedMotion()) return animate(el, { opacity: 0 }, { duration: 0 });
            return animate(
              el,
              { opacity: 0, x: direction() * -20, filter: `blur(${motionTokens.blur.soft}px)` },
              { x: spring.smooth, opacity: { duration: motionTokens.duration.exit, ease: standardEase }, filter: { duration: motionTokens.duration.exit } },
            );
          }}
        >
          {step => props.children(step)}
        </Swap>
      </HeightFrame>
      <Show when={props.footer}><footer class={styles.footer}>{props.footer}</footer></Show>
    </section>
  );
}

export function SignInHeading(props: { title: JSX.Element; description?: JSX.Element; level?: 1 | 2; titleRef?: (el: HTMLHeadingElement) => void }) {
  return (
    <div class={styles.heading}>
      <Show when={props.level === 1} fallback={<h2 ref={props.titleRef} tabIndex={-1}>{props.title}</h2>}>
        <h1 ref={props.titleRef} tabIndex={-1}>{props.title}</h1>
      </Show>
      <Show when={props.description}><p>{props.description}</p></Show>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Providers                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ProviderName = "google" | "apple";

/** The official four-colour Google "G" (never recoloured). */
export function GoogleMark(props: { size?: number }) {
  return (
    <svg class={styles.mark} width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

/** Apple's mark, drawn in the text colour as Apple's guidelines ask. */
export function AppleMark(props: { size?: number }) {
  return (
    <svg class={styles.mark} width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

export interface ProviderButtonProps {
  provider: ProviderName;
  /** Defaults to "Continue with Google" / "Continue with Apple". */
  label?: string;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  class?: string;
  /** Icon-only compact button (the label becomes the accessible name). */
  compact?: boolean;
}

export function ProviderButton(props: ProviderButtonProps) {
  const name = () => (props.provider === "google" ? "Google" : "Apple");
  const label = () => props.label ?? `Continue with ${name()}`;
  return (
    <Button
      type="button"
      variant="secondary"
      class={cx(styles.provider, props.compact && styles.providerCompact, props.class)}
      loading={props.loading}
      disabled={props.disabled}
      aria-label={props.compact ? label() : undefined}
      data-provider={props.provider}
      onClick={() => props.onClick?.()}
    >
      {props.provider === "google" ? <GoogleMark /> : <AppleMark />}
      <Show when={!props.compact}>{label()}</Show>
    </Button>
  );
}

export function SignInDivider(props: { label?: string }) {
  return <div class={styles.divider} role="separator" aria-label={props.label ?? "or"}><span aria-hidden="true">{props.label ?? "or"}</span></div>;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The account being signed in to                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

export function AccountRow(props: { name: string; detail: string; photo?: string | null; kind?: "carbon" | "silicon"; action?: JSX.Element; class?: string }) {
  return (
    <div ref={el => useSquircle(el)} class={cx(styles.account, props.class)}>
      <Avatar name={props.name} src={props.photo} kind={props.kind} size="sm" />
      <span class={styles.accountText}>
        <span class={styles.accountName}>{props.name}</span>
        <span class={styles.accountDetail}>{props.detail}</span>
      </span>
      <Show when={props.action}><span class={styles.accountAction}>{props.action}</span></Show>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Resend with a rolling countdown                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

/** "0:27" whose digits roll down as time passes and back up when the timer restarts. */
export function RollingTime(props: { seconds: number }) {
  const text = () => `${Math.floor(Math.max(0, props.seconds) / 60)}:${String(Math.max(0, props.seconds) % 60).padStart(2, "0")}`;
  const [direction, setDirection] = createSignal(1);
  createEffect(on(() => props.seconds, (next, previous) => { if (previous !== undefined) setDirection(next < previous ? 1 : -1); }, { defer: true }));
  const characters = createMemo(() => text().split(""));
  return (
    <span class={styles.time} aria-hidden="true">
      <Index each={characters()}>
        {character => (
          <span class={styles.timeColumn}>
            <Swap
              value={character()}
              enter={el => (prefersReducedMotion() ? undefined : animate(el, { opacity: [0, 1], y: [`${-0.7 * direction()}em`, "0em"], filter: [`blur(${motionTokens.blur.subtle}px)`, "blur(0px)"] }, { y: spring.snappy, opacity: tween(motionTokens.duration.fast), filter: tween(motionTokens.duration.fast) }))}
              exit={el => (prefersReducedMotion() ? animate(el, { opacity: 0 }, { duration: 0 }) : animate(el, { opacity: 0, y: `${0.7 * direction()}em`, filter: `blur(${motionTokens.blur.subtle}px)` }, tween(motionTokens.duration.fast)))}
            >
              {value => value}
            </Swap>
          </span>
        )}
      </Index>
    </span>
  );
}

export interface ResendButtonProps {
  /** When resending becomes possible (ISO timestamp or epoch ms). */
  availableAt: string | number | Date | null | undefined;
  /** Resend; return a promise to show progress. */
  onResend: () => void | Promise<unknown>;
  label?: string;
}

export function ResendButton(props: ResendButtonProps) {
  const target = () => (props.availableAt ? new Date(props.availableAt).getTime() : 0);
  const [now, setNow] = createSignal(Date.now());
  const [busy, setBusy] = createSignal(false);
  const timer = window.setInterval(() => setNow(Date.now()), 250);
  onCleanup(() => window.clearInterval(timer));
  const remaining = () => Math.max(0, Math.ceil((target() - now()) / 1000));
  const waiting = () => remaining() > 0;
  const resend = async () => {
    if (waiting() || busy()) return;
    setBusy(true);
    try {
      await props.onResend();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      class={styles.resend}
      aria-disabled={waiting() || busy() || undefined}
      aria-busy={busy() || undefined}
      aria-label={waiting() ? `${props.label ?? "Resend code"}, available in ${remaining()} seconds` : props.label ?? "Resend code"}
      onClick={() => void resend()}
    >
      <Swap
        value={waiting() ? "wait" : busy() ? "busy" : "ready"}
        class={styles.resendLabel}
        enter={el => (prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant)) : animate(el, { opacity: [0, 1], y: [6, 0], filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"] }, tween(motionTokens.duration.standard, motionTokens.ease.enter)))}
        exit={el => animate(el, { opacity: 0 }, tween(prefersReducedMotion() ? 0 : motionTokens.duration.fast))}
      >
        {state => (state === "wait" ? <>{props.label ?? "Resend code"} in <RollingTime seconds={remaining()} /></> : state === "busy" ? "Sending a new code" : props.label ?? "Resend code")}
      </Swap>
    </button>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Success                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export function SignInSuccess(props: { name: string; photo?: string | null; kind?: "carbon" | "silicon"; title: JSX.Element; detail?: JSX.Element; children?: JSX.Element }) {
  let ring: SVGCircleElement | undefined;
  let badge: HTMLSpanElement | undefined;
  onMount(() => {
    if (prefersReducedMotion() || !ring || !badge) return;
    animate(ring, { strokeDashoffset: [1, 0], opacity: [0, 1] }, { strokeDashoffset: { duration: motionTokens.duration.considered * 1.25, ease: [...motionTokens.ease.inOut] as [number, number, number, number], delay: 0.22 }, opacity: { duration: motionTokens.duration.instant, delay: 0.22 } });
    animate(badge, { opacity: [0, 1], scale: [0.4, 1] }, { ...spring.snappy, delay: 0.78 });
  });
  return (
    <div class={styles.success}>
      <div class={styles.avatarStage}>
        <svg class={styles.ring} viewBox="0 0 96 96" aria-hidden="true">
          <circle ref={ring} cx="48" cy="48" r="47" fill="none" stroke="currentColor" stroke-width="1.5" pathLength="1" style={{ "stroke-dasharray": "1", "stroke-dashoffset": prefersReducedMotion() ? "0" : "1" }} />
        </svg>
        <span class={styles.avatarFill}><Avatar name={props.name} src={props.photo} kind={props.kind} size="xl" /></span>
        <span ref={badge} class={styles.badge} aria-hidden="true"><Check size={14} stroke-width={2.25} /></span>
      </div>
      <SignInHeading title={props.title} description={props.detail} />
      {props.children}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Demo (style guide)                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

type DemoStep = "email" | "code" | "done";
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());

/** The full block with simulated timings: email, code (123456), signed in. Sample only; nothing is sent. */
export function SignInDemo(props: { demoCode?: string }) {
  const code = () => props.demoCode ?? "123456";
  const [step, setStep] = createSignal<DemoStep>("email");
  const [direction, setDirection] = createSignal(1);
  const [email, setEmail] = createSignal("");
  const [attempted, setAttempted] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [otp, setOtp] = createSignal("");
  const [otpError, setOtpError] = createSignal<string | null>(null);
  const [resendAt, setResendAt] = createSignal(Date.now() + 30_000);
  const [status, setStatus] = createSignal("");
  const go = (next: DemoStep, towards: number) => { setDirection(towards); setStep(next); };
  const later = (run: () => void, ms: number) => { const timer = window.setTimeout(run, ms); onCleanup(() => window.clearTimeout(timer)); };
  const emailError = () => (attempted() && !isEmail(email()) ? (email().trim() ? "Enter a full address, like name@example.com." : "Enter your email address.") : null);
  const submitEmail = (event: SubmitEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!isEmail(email()) || busy()) return;
    setBusy("email");
    setStatus("Sending a code");
    later(() => { setBusy(null); setOtp(""); setOtpError(null); setResendAt(Date.now() + 30_000); go("code", 1); setStatus("Code sent"); }, 800);
  };
  const verify = (value: string) => {
    if (busy()) return;
    if (value.length < 6) { setOtpError("Enter all 6 digits."); return; }
    setBusy("code");
    setStatus("Checking code");
    later(() => {
      setBusy(null);
      if (value === code()) { go("done", 1); setStatus("Signed in with an email code"); return; }
      setOtp("");
      setOtpError("That code did not match. Check the latest email and try again.");
      setStatus("Code did not match");
    }, 700);
  };
  const name = () => {
    const local = email().split("@")[0] ?? "";
    const parts = local.split(/[._+-]+/).filter(Boolean);
    return parts.slice(0, 2).map(part => part[0]!.toUpperCase() + part.slice(1)).join(" ") || "Ada Okafor";
  };
  return (
    <SignInCard
      step={step()}
      direction={direction()}
      label="Sign in (sample)"
      footer={<><span class={styles.status} role="status"><SwapText text={status() || "Sample: nothing is sent"} /></span><span class={styles.switch}>No account? <button type="button" class={styles.textButton} onClick={() => setStatus("Signing up starts the same way")}>Sign up</button></span></>}
    >
      {current => (
        <Show when={current === "email"} fallback={
          <Show when={current === "code"} fallback={
            <SignInSuccess name={name()} title={`Welcome, ${name().split(" ")[0]}`} detail={email()}>
              <Button variant="secondary" class={styles.wide} onClick={() => { setAttempted(false); go("email", -1); setStatus("Signed out"); }}>Sign out</Button>
            </SignInSuccess>
          }>
            <SignInHeading title="Check your email" description="Enter the 6 digit code we sent. It expires in 10 minutes." />
            <AccountRow name={name()} detail={email()} action={<Button variant="ghost" size="sm" onClick={() => { go("email", -1); setStatus("Edit your email"); }}>Change</Button>} />
            <form class={styles.form} onSubmit={event => { event.preventDefault(); verify(otp()); }} novalidate>
              <OtpInput label="Verification code" description={`Sample code: ${code()}.`} value={otp()} onChange={value => { setOtp(value); if (otpError() && value) setOtpError(null); }} onComplete={verify} error={otpError()} autoFocus />
              <Button type="submit" class={styles.wide} loading={busy() === "code"}>Verify</Button>
            </form>
            <ResendButton availableAt={resendAt()} onResend={() => { setResendAt(Date.now() + 30_000); setStatus("New code sent"); }} />
          </Show>
        }>
          <SignInHeading title="Sign in to Briefcase" description="Enter your email and we will send you a 6 digit code." />
          <form class={styles.form} onSubmit={submitEmail} novalidate>
            <Input label="Email" type="email" inputMode="email" autocomplete="email" placeholder="name@example.com" value={email()} onInput={event => setEmail(event.currentTarget.value)} error={emailError()} />
            <Button type="submit" class={styles.wide} loading={busy() === "email"}>Continue</Button>
          </form>
          <SignInDivider />
          <div class={styles.providers}>
            <ProviderButton provider="google" onClick={() => setStatus("Opening Google (sample)")} />
            <ProviderButton provider="apple" onClick={() => setStatus("Opening Apple (sample)")} />
          </div>
        </Show>
      )}
    </SignInCard>
  );
}

/** For page code that wants the morph's step direction from an ordered list of steps. */
export function stepDirection<S extends string>(order: readonly S[], from: S | undefined, to: S): number {
  if (from === undefined) return 1;
  return Math.sign(order.indexOf(to) - order.indexOf(from)) || 1;
}

/** Keeps `fn` from firing twice for the same step (for example to autofocus once per step). */
export function onStepChange<S>(step: () => S, fn: (step: S) => void): void {
  createEffect(on(step, value => untrack(() => fn(value)), { defer: true }));
}
