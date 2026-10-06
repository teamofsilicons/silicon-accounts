/**
 * Building blocks the hosted steps share: headings that take focus when their step arrives, the alert for a flow's
 * error, the account and destination rows, the code entry (OTP with resend and cooldown) and the email/phone form.
 * Everything uses Arc components and semantic tokens, so the app's branding paints it.
 */
import { Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type Accessor, type JSX } from "solid-js";
import { Check, Mail, Smartphone } from "lucide-solid";
import { animate, motionTokens, prefersReducedMotion, spring } from "../../../arc/lib/motion";
import { ApiError, type FlowChallenge, type SigninMethod } from "../../../api";
import { Alert } from "../../../arc/alert/alert";
import { Avatar } from "../../../arc/avatar/avatar";
import { Button } from "../../../arc/button/button";
import { Input } from "../../../arc/input/input";
import { OtpInput } from "../../../arc/otp-input/otp-input";
import { SegmentedControl } from "../../../arc/segmented-control/segmented-control";
import { ResendButton } from "../../../arc/blocks/sign-in/sign-in";
import { FieldMessage } from "../../../arc/lib/FieldMessage";
import { useSquircle } from "../../../arc/lib/squircle";
import { formatCountdown } from "../../../lib/format";
import type { ActionResult } from "./controller";
import { carbonError, type ErrorContext, type ErrorLike } from "./errors";
import type { AccountSummary } from "./model";
import { PhoneField, type PhoneFieldValue } from "./PhoneField";
import styles from "./flow.module.css";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Time                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The current time, ticking every `ms` while mounted. */
export function createNow(ms = 250): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  const timer = window.setInterval(() => setNow(Date.now()), ms);
  onCleanup(() => window.clearInterval(timer));
  return now;
}

/** Keeps the last value that was not null/undefined (a leaving step keeps rendering what it showed). */
export function latest<T>(read: () => T | null | undefined): Accessor<T | null> {
  return createMemo<T | null>(previous => read() ?? previous, null);
}

/** True on devices with a precise pointer, where focusing a field does not throw up a keyboard. */
export const finePointer = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: fine)").matches;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Headings and messages                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Set by the flow page: true once the first step rendered, so later steps move focus to their heading. */
let arrivedOnce = false;
export function resetArrival(): void {
  arrivedOnce = false;
}

export interface StepHeadingProps {
  title: JSX.Element;
  description?: JSX.Element;
  /** The step focuses a field itself; the heading does not take focus. */
  noFocus?: boolean;
  /** The app's own title: hidden visually in the split layout, where it already stands large beside the form. */
  appTitle?: boolean;
}

/** The step's h1. When a step arrives after the first, focus moves here so screen readers hear the new step. */
export function StepHeading(props: StepHeadingProps) {
  let heading: HTMLHeadingElement | undefined;
  onMount(() => {
    const focus = arrivedOnce && !props.noFocus;
    arrivedOnce = true;
    if (focus) queueMicrotask(() => heading?.isConnected && heading.focus({ preventScroll: true }));
  });
  return (
    <div class={`${styles.heading} ${props.appTitle ? styles.appTitle : ""}`}>
      <Show when={props.appTitle}><p class={styles.splitLabel} aria-hidden="true">Sign in</p></Show>
      <h1 ref={heading} tabIndex={-1} class={styles.title}>{props.title}</h1>
      <Show when={props.description}><p class={styles.description}>{props.description}</p></Show>
    </div>
  );
}

/**
 * The signed-in moment: a ring draws around the photo, then a check pops in (the Arc sign-in block's success, with
 * the step's own h1 so the page keeps one heading).
 */
export function SuccessMark(props: { name: string; photo?: string | null; kind?: "carbon" | "silicon" }) {
  let ring: SVGCircleElement | undefined;
  let badge: HTMLSpanElement | undefined;
  onMount(() => {
    if (prefersReducedMotion() || !ring || !badge) return;
    animate(ring, { strokeDashoffset: [1, 0], opacity: [0, 1] }, { strokeDashoffset: { duration: motionTokens.duration.considered * 1.25, ease: [...motionTokens.ease.inOut] as [number, number, number, number], delay: 0.18 }, opacity: { duration: motionTokens.duration.instant, delay: 0.18 } });
    animate(badge, { opacity: [0, 1], scale: [0.4, 1] }, { ...spring.snappy, delay: 0.72 });
  });
  return (
    <div class={styles.success} aria-hidden="true">
      <svg class={styles.successRing} viewBox="0 0 96 96">
        <circle ref={ring} cx="48" cy="48" r="47" fill="none" stroke="currentColor" stroke-width="1.5" pathLength="1" style={{ "stroke-dasharray": "1", "stroke-dashoffset": prefersReducedMotion() ? "0" : "1" }} />
      </svg>
      <span class={styles.successPhoto}><Avatar name={props.name} src={props.photo} kind={props.kind} size="xl" /></span>
      <span ref={badge} class={styles.successBadge}><Check size={14} stroke-width={2.25} /></span>
    </div>
  );
}

export interface FlowAlertProps {
  /** A flow's error (a cancelled Google sign-in, an expired sign-up), or a failure this step kept. */
  error: ErrorLike | null | undefined;
  /** The app being signed into, for copy such as "Briefcase asks everyone to sign in each time". */
  app?: string;
  /**
   * The one-click fix some errors offer ("Sign in again" after a sign-out elsewhere): forget this flow's account and
   * choose again. Without it the alert only explains.
   */
  onSwitch?: () => Promise<unknown>;
  /** Replaces the title (the step's own words for what did not happen). */
  title?: string;
  tone?: "danger" | "warning" | "info";
}

/** An error in the Carbon's words (flow/errors.ts), with its fix as a button when there is one. */
export function FlowAlert(props: FlowAlertProps) {
  const [busy, setBusy] = createSignal(false);
  const run = async () => {
    if (busy() || !props.onSwitch) return;
    setBusy(true);
    try {
      await props.onSwitch();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={props.error}>
      {error => {
        const copy = createMemo(() => carbonError(error(), { app: props.app }));
        return (
          <Alert
            tone={props.tone ?? "danger"}
            title={props.title ?? copy().title}
            data-error-code={error().code}
            action={copy().action && props.onSwitch ? <Button size="sm" variant="secondary" loading={busy()} onClick={() => void run()}>{copy().action?.label}</Button> : undefined}
          >
            {copy().text}
          </Alert>
        );
      }}
    </Show>
  );
}

/** An error as one line in the Carbon's words (field errors, step alerts). */
export const describe = (error: ErrorLike | null | undefined, context?: ErrorContext): string | null => (error ? carbonError(error, context).text : null);

/**
 * The error a step shows is the newest one. An error the flow arrived with (or the page kept for it) stays until the
 * Carbon starts something new; a failure of that new action then takes its place instead of hiding behind it.
 */
export function createStepErrors(carried: () => ErrorLike | null | undefined) {
  const [problem, setProblem] = createSignal<ApiError | null>(null);
  /** The carried error that was on screen when the Carbon acted; a different one arriving later shows again. */
  const [seen, setSeen] = createSignal<string | null>(null);
  const keyOf = (error: ErrorLike) => `${error.code}\n${error.message}`;
  const shownCarried = (): ErrorLike | null => {
    const error = carried();
    return error && keyOf(error) !== seen() ? error : null;
  };
  return {
    /** The flow's own error, until the Carbon acts. */
    carried: shownCarried,
    /** The failure of the latest action. */
    problem,
    /** The newest of the two. */
    current: (): ErrorLike | null => problem() ?? shownCarried(),
    /** A new action starts: older errors step aside. */
    begin: () => {
      const error = carried();
      batch(() => {
        setProblem(null);
        if (error) setSeen(keyOf(error));
      });
    },
    fail: (error: ApiError | null) => setProblem(error),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Rows                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The account this flow signs in as: photo, name and c:id, with an optional action (switch account). */
export function AccountRow(props: { account: AccountSummary; action?: JSX.Element; size?: "sm" | "md" }) {
  return (
    <div ref={el => useSquircle(el)} class={styles.accountRow} data-account={props.account.uuid}>
      <Avatar name={props.account.display_name} src={props.account.pfp_url} kind={props.account.kind} size={props.size ?? "md"} />
      <span class={styles.accountText}>
        <span class={styles.accountName}>{props.account.display_name}</span>
        <span class={styles.accountId}>{props.account.id ?? props.account.uuid}</span>
      </span>
      <Show when={props.action}><span class={styles.rowAction}>{props.action}</span></Show>
    </div>
  );
}

/** Where a code went: the channel's icon, the masked address and "Change". */
export function DestinationRow(props: { channel: "email" | "phone"; destination: string; action?: JSX.Element }) {
  return (
    <div ref={el => useSquircle(el)} class={styles.destination}>
      <span class={styles.destinationIcon} aria-hidden="true">
        {props.channel === "email" ? <Mail size={16} stroke-width={1.75} /> : <Smartphone size={16} stroke-width={1.75} />}
      </span>
      <span class={styles.destinationText}>{props.destination}</span>
      <Show when={props.action}><span class={styles.rowAction}>{props.action}</span></Show>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Code entry                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface CodeEntryProps {
  challenge: FlowChallenge;
  verify: (code: string) => Promise<ActionResult>;
  resend: () => Promise<ActionResult>;
  /** Accessible name of the code field. */
  label?: string;
  submitLabel?: string;
}

/**
 * The 6 digit code: digits pop into their slots and the code is checked as soon as the last one lands. A wrong code
 * shakes the row and says how many tries are left; the tenth locks entry with a live countdown; an expired code asks
 * for a new one. "Resend code" waits for the server's resend time.
 */
export function CodeEntry(props: CodeEntryProps) {
  const [code, setCode] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [lockedUntil, setLockedUntil] = createSignal<number | null>(null);
  const [expired, setExpired] = createSignal(false);
  const [resendError, setResendError] = createSignal<string | null>(null);
  const [resent, setResent] = createSignal(false);
  let form: HTMLFormElement | undefined;
  const now = createNow(250);
  const lockLeft = () => {
    const until = lockedUntil();
    return until ? Math.max(0, Math.ceil((until - now()) / 1000)) : 0;
  };
  const locked = () => lockLeft() > 0;
  /** The code ran out (10 minutes), or the server said so: only a new code helps now. */
  const timeUp = () => {
    const at = Date.parse(props.challenge.expires_at);
    return Number.isFinite(at) && at <= now();
  };
  const stale = () => expired() || timeUp();
  /** Back to the first slot, ready for the next try. */
  const refocus = () => queueMicrotask(() => form?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus({ preventScroll: true }));
  // A cooldown that ran out clears its message; the field is usable again.
  createEffect(on(locked, (isLocked, wasLocked) => {
    if (wasLocked && !isLocked) {
      setLockedUntil(null);
      setError(null);
      refocus();
    }
  }, { defer: true }));
  // A new challenge (resend, or a new destination) starts clean.
  createEffect(on(() => props.challenge.expires_at, () => {
    setExpired(false);
    setCode("");
  }, { defer: true }));

  const submit = async (value: string) => {
    if (pending() || locked()) return;
    if (value.length < 6) {
      setError("Enter all 6 digits of the code.");
      return;
    }
    setPending(true);
    setError(null);
    const failure = await props.verify(value);
    setPending(false);
    if (!failure) return;
    setCode("");
    if (failure.code === "verification_locked" || (failure.code === "invalid_code" && failure.remainingAttempts === 0)) {
      const seconds = failure.retryAfter ?? 60;
      setLockedUntil(Date.now() + seconds * 1000);
      setError(describe(failure));
      return;
    }
    if (failure.code === "code_expired") setExpired(true);
    setError(describe(failure));
    refocus();
  };

  const resend = async () => {
    setResendError(null);
    const failure = await props.resend();
    if (failure) {
      setResendError(failure.code === "rate_limited" && failure.retryAfter ? `${describe(failure)} Try again in ${formatCountdown(failure.retryAfter)}.` : describe(failure));
      return;
    }
    setResent(true);
    setError(null);
    setExpired(false);
  };

  const status = () => {
    if (locked()) return `Locked. Try again in ${formatCountdown(lockLeft())}.`;
    if (timeUp() && !error()) return "This code expired. Send a new one.";
    return null;
  };

  return (
    <div class={styles.codeEntry}>
      <form ref={form} class={styles.form} novalidate onSubmit={event => { event.preventDefault(); void submit(code()); }}>
        <OtpInput
          class={styles.otp}
          label={props.label ?? "Verification code"}
          value={code()}
          onChange={value => {
            setCode(value);
            if (error() && value && !locked()) setError(null);
          }}
          onComplete={value => void submit(value)}
          error={error()}
          disabled={locked() || pending()}
          autoFocus={finePointer()}
        />
        <FieldMessage text={status()} />
        <Button type="submit" class={styles.wide} loading={pending()} disabled={locked()}>
          {props.submitLabel ?? "Verify"}
        </Button>
      </form>
      <div class={styles.resendRow}>
        <ResendButton availableAt={stale() ? 0 : props.challenge.resend_available_at} onResend={resend} label={stale() ? "Send a new code" : "Resend code"} />
        <Show when={resent() && !resendError() && !timeUp()}><span class={styles.resendNote} role="status">New code sent</span></Show>
      </div>
      <FieldMessage text={resendError()} tone="error" alert />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Email or phone                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ContactKind = "email" | "phone";

export interface ContactFormProps {
  /** Which kinds to offer, in order (a segmented control appears when there are two). */
  kinds: ContactKind[];
  initialKind?: ContactKind;
  initialEmail?: string;
  initialPhone?: string;
  submitLabel: string;
  /** Sends the code. Field-level failures come back to show under the field. */
  onSubmit: (kind: ContactKind, value: string, country?: string) => Promise<ActionResult>;
  autoFocus?: boolean;
  /** The primary action of the step (filled); false renders a secondary button. */
  primary?: boolean;
  /** Below the field (for example "We will send a 6 digit code"). */
  note?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Email or phone, with client checks that mirror the server's and its own words when it refuses. A phone number from
 * any country goes through PhoneField, which never sends a number the Carbon did not type.
 */
export function ContactForm(props: ContactFormProps) {
  const [kind, setKind] = createSignal<ContactKind>(untrack(() => props.initialKind && props.kinds.includes(props.initialKind) ? props.initialKind : props.kinds[0] ?? "email"));
  const [email, setEmail] = createSignal(untrack(() => props.initialEmail ?? ""));
  /** The phone as PhoneField last reported it; it is also where the field starts again after Email ⇄ Phone. */
  const [phone, setPhone] = createSignal<PhoneFieldValue>({ mode: "picker", phone: untrack(() => props.initialPhone ?? ""), problem: null });
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [retryAt, setRetryAt] = createSignal<number | null>(null);
  let emailInput: HTMLInputElement | undefined;
  const now = createNow(500);
  const waiting = () => {
    const at = retryAt();
    return at ? Math.max(0, Math.ceil((at - now()) / 1000)) : 0;
  };

  onMount(() => {
    if (props.autoFocus && kind() === "email") queueMicrotask(() => emailInput?.focus({ preventScroll: true }));
  });

  /** The same checks the server makes first, so an obvious slip never costs a request. */
  const problem = (): string | null => {
    if (kind() === "email") {
      const value = email().trim();
      if (!value) return "Enter your email address.";
      if (!EMAIL.test(value)) return "Enter a full email address, like name@example.com.";
      return null;
    }
    // Only what is certainly wrong stops here; whether a number exists is the server's call (it knows every country).
    return phone().problem;
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending()) return;
    const current = kind();
    const local = problem();
    if (local) {
      setError(local);
      return;
    }
    setError(null);
    setPending(true);
    const number = phone();
    const failure = current === "email" ? await props.onSubmit("email", email().trim()) : await props.onSubmit("phone", number.phone, number.country);
    setPending(false);
    if (!failure) return;
    if (failure.code === "rate_limited" && failure.retryAfter) setRetryAt(Date.now() + failure.retryAfter * 1000);
    setError(describe(failure));
  };

  const options = () => props.kinds.map(value => ({ value, label: value === "email" ? "Email" : "Phone" }));

  return (
    <form class={styles.form} novalidate onSubmit={submit}>
      <Show when={props.kinds.length > 1}>
        <SegmentedControl<ContactKind> label="Sign in with" options={options()} value={kind()} onValueChange={value => { setKind(value); setError(null); setRetryAt(null); }} class={styles.segments} />
      </Show>
      <Show when={kind() === "email"} fallback={
        <PhoneField
          label="Phone number"
          hideLabel={props.kinds.length > 1}
          initial={untrack(() => phone().phone)}
          onChange={value => {
            if (value.phone !== phone().phone) {
              // The send limit is per number: another number may go now.
              setRetryAt(null);
              if (error()) setError(null);
            }
            setPhone(value);
          }}
          error={error()}
          description={props.note}
        />
      }>
        <Input
          ref={el => { emailInput = el; }}
          label="Email"
          hideLabel={props.kinds.length > 1}
          type="email"
          name="email"
          inputMode="email"
          autocomplete="email"
          autocapitalize="off"
          spellcheck={false}
          placeholder="name@example.com"
          value={email()}
          onInput={event => {
            setEmail(event.currentTarget.value);
            // The send limit is per address: another address may go now.
            setRetryAt(null);
            if (error()) setError(null);
          }}
          error={error()}
          description={props.note}
        />
      </Show>
      <Button type="submit" variant={props.primary === false ? "secondary" : "primary"} class={styles.wide} loading={pending()} disabled={waiting() > 0}>
        {waiting() > 0 ? `Try again in ${formatCountdown(waiting())}` : props.submitLabel}
      </Button>
    </form>
  );
}

/** Email or phone as the kinds a list of methods offers, in the app's order. */
export function contactKinds(methods: readonly SigninMethod[]): ContactKind[] {
  return methods.filter((method): method is ContactKind => method === "email" || method === "phone");
}
