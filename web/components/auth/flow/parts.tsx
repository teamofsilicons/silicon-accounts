"use client";

/**
 * Building blocks the hosted steps share: headings that take focus when their step arrives, field messages, the alert
 * for a flow's error, the account and destination rows, provider buttons, the code entry (OTP with resend and
 * cooldown) and the email/phone form. Everything uses Arc components and semantic tokens, so the app's branding
 * paints it.
 */
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition, type Variants } from "motion/react";
import { Check, Mail, Smartphone } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import { OtpInput } from "@/components/arc/otp-input/otp-input";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import type { ApiError } from "@/lib/api/errors";
import type { AccountSummary, FlowChallenge, SigninMethod } from "@/lib/api/types";
import { formatCountdown } from "@/lib/format";
import type { ActionResult } from "./controller";
import { carbonError, describe, type ErrorContext, type ErrorLike } from "./errors";
import { useFinePointer, useNow } from "./hooks";
import { PhoneField, type PhoneFieldValue } from "@/components/foundation/phone-field/phone-field";
import styles from "./flow.module.css";

const { blur, duration, ease, spring } = motionTokens;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Headings and messages                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Whether a step heading already rendered on this page. The first step does not steal focus (the page just loaded);
 * every later step moves focus to its heading so screen readers hear the new step. One per page (flow, device).
 */
export const ArrivalContext = createContext<RefObject<boolean> | null>(null);

export interface StepHeadingProps {
  title: ReactNode;
  description?: ReactNode;
  /** The step focuses a field itself; the heading does not take focus. */
  noFocus?: boolean;
  /** The app's own title: hidden visually in the split layout, where it already stands large beside the form. */
  appTitle?: boolean;
  /** What heads the form instead in the split layout ("Sign in", or "Sign up" on the sign-up page). */
  splitLabel?: string;
}

/** The step's h1. When a step arrives after the first, focus moves here so screen readers hear the new step. */
export function StepHeading({ title, description, noFocus, appTitle, splitLabel = "Sign in" }: StepHeadingProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const arrivalRef = useContext(ArrivalContext);
  const skipFocus = useRef(noFocus);
  useEffect(() => {
    if (!arrivalRef) return;
    const focus = arrivalRef.current && !skipFocus.current;
    arrivalRef.current = true;
    if (!focus) return;
    const node = heading.current;
    queueMicrotask(() => {
      if (node?.isConnected && !node.closest("[inert]")) node.focus({ preventScroll: true });
    });
  }, [arrivalRef]);
  return (
    <div className={[styles.heading, appTitle ? styles.appTitle : ""].filter(Boolean).join(" ")}>
      {appTitle ? <p className={styles.splitLabel} aria-hidden="true">{splitLabel}</p> : null}
      <h1 ref={heading} tabIndex={-1} className={styles.title}>{title}</h1>
      {description ? <p className={styles.description}>{description}</p> : null}
    </div>
  );
}

const noteRise: Variants = {
  enter: (reduce: boolean) => (reduce ? { opacity: 0 } : { opacity: 0, y: "0.35em", filter: `blur(${blur.soft}px)` }),
  center: { opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } },
  exit: (reduce: boolean) => (reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.3em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast, ease: [...ease.standard] } }),
};

/**
 * A line under a field: a hint, a status or an error. The row opens its height on a spring and the words rise in,
 * the way Arc's own field messages do; errors are announced.
 */
export function FieldNote({ id, text, tone = "hint", alert }: { id?: string; text: string | null | undefined; tone?: "hint" | "error" | "status"; alert?: boolean }) {
  const reduce = !!useReducedMotion();
  const open: Transition = reduce ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.fast } };
  return (
    <AnimatePresence initial={false}>
      {text ? (
        <motion.span key="note" className={styles.noteSlot} initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0, transition: reduce ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.instant } } }} transition={open}>
          <AnimatePresence mode="popLayout" initial={false} custom={reduce}>
            <motion.span key={text} id={id} className={styles.note} data-tone={tone} role={alert ? "alert" : tone === "status" ? "status" : undefined} custom={reduce} variants={noteRise} initial="enter" animate="center" exit="exit" transition={{ duration: reduce ? duration.instant : duration.standard, ease: [...ease.enter] }}>
              {text}
            </motion.span>
          </AnimatePresence>
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * "Locked. Try again in 0:59." while code entry is paused. The row opens once, as FieldNote's do, and the time then
 * changes in place: no new note, entrance or announcement every second. It is a timer, which screen readers read when
 * asked and never announce on each tick; the code field's error (an alert) says once that entry is paused.
 */
export function LockNote({ seconds }: { seconds: number | null }) {
  const reduce = !!useReducedMotion();
  const open: Transition = reduce ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.fast } };
  return (
    <AnimatePresence initial={false}>
      {seconds !== null ? (
        <motion.span key="lock" className={styles.noteSlot} initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0, transition: reduce ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.instant } } }} transition={open}>
          <span className={styles.note} data-tone="status" role="timer">{`Locked. Try again in ${formatCountdown(seconds)}.`}</span>
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * The signed-in moment: a ring draws around the photo, then a check pops in (the Arc sign-in block's success, with
 * the step's own h1 so the page keeps one heading).
 */
export function SuccessMark({ name, photo }: { name: string; photo?: string | null }) {
  const reduce = !!useReducedMotion();
  return (
    <div className={styles.success} aria-hidden="true">
      <svg className={styles.successRing} viewBox="0 0 96 96">
        <motion.circle cx="48" cy="48" r="47" fill="none" stroke="currentColor" strokeWidth="1.5" initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ pathLength: { duration: duration.considered, ease: [...ease.inOut], delay: 0.04 }, opacity: { duration: duration.instant, delay: 0.04 } }} />
      </svg>
      <span className={styles.successPhoto}><Avatar name={name} src={photo ?? undefined} size="xl" /></span>
      <motion.span className={styles.successBadge} initial={reduce ? false : { opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring.snappy, delay: 0.36 }}>
        <Check size={14} strokeWidth={2.25} />
      </motion.span>
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
export function FlowAlert({ error, app, onSwitch, title, tone }: FlowAlertProps) {
  const [busy, setBusy] = useState(false);
  if (!error) return null;
  const copy = carbonError(error, { app });
  const run = async () => {
    if (busy || !onSwitch) return;
    setBusy(true);
    try {
      await onSwitch();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert tone={tone ?? "danger"} title={title ?? copy.title} data-error-code={error.code}>
      {copy.action && onSwitch ? (
        <>
          {copy.text}
          <span className={styles.alertAction}>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void run()}>{copy.action.label}</Button>
          </span>
        </>
      ) : (
        copy.text
      )}
    </Alert>
  );
}

/**
 * The error a step shows is the newest one. An error the flow arrived with (or the page kept for it) stays until the
 * Carbon starts something new; a failure of that new action then takes its place instead of hiding behind it.
 */
export function useStepErrors(carried: ErrorLike | null | undefined) {
  const [problem, setProblem] = useState<ApiError | null>(null);
  /** The carried error that was on screen when the Carbon acted; a different one arriving later shows again. */
  const [seen, setSeen] = useState<string | null>(null);
  const keyOf = (error: ErrorLike) => `${error.code}\n${error.message}`;
  const shownCarried = carried && keyOf(carried) !== seen ? carried : null;
  return {
    /** The flow's own error, until the Carbon acts. */
    carried: shownCarried,
    /** The failure of the latest action. */
    problem,
    /** The newest of the two. */
    current: (problem ?? shownCarried) as ErrorLike | null,
    /** A new action starts: older errors step aside. */
    begin: () => {
      setProblem(null);
      if (carried) setSeen(keyOf(carried));
    },
    fail: (error: ApiError | null) => setProblem(error),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Rows and buttons                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The account this flow signs in as: photo, name and c:id, with an optional action (switch account). The name and id
 * are never cut short (the action moves under them when they need the room).
 */
export function AccountRow({ account, action, size = "md" }: { account: AccountSummary; action?: ReactNode; size?: "sm" | "md" }) {
  return (
    <div data-sq="surface" className={styles.accountRow} data-account={account.uuid} data-size={size}>
      <Avatar name={account.display_name} src={account.pfp_url || undefined} size={size === "sm" ? "md" : "lg"} />
      <span className={styles.accountText}>
        <span className={styles.accountName}>{account.display_name}</span>
        <span className={styles.accountId}>{account.id ?? account.uuid}</span>
      </span>
      {action ? <span className={styles.rowAction}>{action}</span> : null}
    </div>
  );
}

/**
 * An address that may break across lines where people expect it to: after the "@" (so the domain moves down whole),
 * else before a "." of the part before it. A part longer than the line still breaks anywhere (overflow-wrap).
 */
function breakable(address: string): ReactNode {
  const at = address.lastIndexOf("@");
  const local = at >= 0 ? address.slice(0, at + 1) : address;
  const nodes: ReactNode[] = local.split(/(?=\.)/).map((part, index) => (index ? [<wbr key={`dot-${index}`} />, part] : part));
  if (at >= 0 && at < address.length - 1) nodes.push(<wbr key="at" />, address.slice(at + 1));
  return nodes;
}

/**
 * Where a code went (or what was proven): the channel's icon, the address and "Change". The address is never cut
 * short: the action moves under it when it needs the room, and a very long one breaks after "@" or before a ".".
 */
export function DestinationRow({ channel, destination, action, icon, note }: { channel: "email" | "phone"; destination: string; action?: ReactNode; icon?: ReactNode; note?: string }) {
  return (
    <div data-sq="surface" className={styles.destination}>
      <span className={styles.destinationIcon} aria-hidden="true">
        {icon ?? (channel === "email" ? <Mail size={16} strokeWidth={1.75} /> : <Smartphone size={16} strokeWidth={1.75} />)}
      </span>
      {note ? (
        <span className={styles.accountText}>
          <span className={styles.accountName}>{breakable(destination)}</span>
          <span className={styles.provenNote}>{note}</span>
        </span>
      ) : (
        <span className={styles.destinationText}>{breakable(destination)}</span>
      )}
      {action ? <span className={styles.rowAction}>{action}</span> : null}
    </div>
  );
}

/** The official four-colour Google "G". */
export function GoogleMark({ size = 16 }: { size?: number }) {
  return (
    <svg className={styles.mark} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

/** The Apple mark, in the text colour. */
export function AppleMark({ size = 16 }: { size?: number }) {
  return (
    <svg className={styles.mark} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

/** "Continue with Google" / "Continue with Apple": neutral buttons with the provider's mark. */
export function ProviderButton({ provider, loading, disabled, onClick }: { provider: "google" | "apple"; loading?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="secondary" className={styles.wide} loading={loading} disabled={disabled} data-provider={provider} onClick={onClick}>
      <span className={styles.providerLabel}>
        {provider === "google" ? <GoogleMark /> : <AppleMark />}
        Continue with {provider === "google" ? "Google" : "Apple"}
      </span>
    </Button>
  );
}

export function OrDivider() {
  return (
    <div className={styles.divider} role="separator" aria-label="or">
      <span aria-hidden="true">or</span>
    </div>
  );
}

const roll: Variants = {
  enter: (direction: number) => ({ opacity: 0, y: `${-0.7 * direction}em`, filter: `blur(${blur.subtle}px)` }),
  center: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: (direction: number) => ({ opacity: 0, y: `${0.7 * direction}em`, filter: `blur(${blur.subtle}px)` }),
};

/** Seconds roll down while a timer runs and back up when a new one starts (the Arc sign-in block's timer). */
export function RollingTime({ seconds }: { seconds: number }) {
  const reduce = !!useReducedMotion();
  const [shown, setShown] = useState({ seconds, direction: 1 });
  if (shown.seconds !== seconds) setShown({ seconds, direction: seconds < shown.seconds ? 1 : -1 });
  const text = formatCountdown(seconds);
  const transition: Transition = reduce ? { duration: 0 } : { y: spring.snappy, opacity: { duration: duration.fast }, filter: { duration: duration.fast } };
  return (
    <span className={styles.time}>
      {text.split("").map((character, index) => (
        <span key={index} className={styles.timeColumn}>
          <AnimatePresence initial={false} mode="popLayout" custom={shown.direction}>
            <motion.span key={character} custom={shown.direction} variants={roll} initial="enter" animate="center" exit="exit" transition={transition}>{character}</motion.span>
          </AnimatePresence>
        </span>
      ))}
    </span>
  );
}

export interface ResendButtonProps {
  /** When a new code may be asked for (ISO time); 0 or null: now. */
  availableAt: string | number | null;
  onResend: () => Promise<unknown>;
  label?: string;
}

/**
 * "Resend code in 0:27", then "Resend code": a quiet text button that waits for the server's resend time. It is named
 * by exactly the words it shows (WCAG 2.5.3, Label in Name): the rolling label is drawn for the eyes only (a digit on
 * its way out stays in the DOM for a moment), and a visually hidden copy of the same words names the button. While it
 * waits it stays focusable (aria-disabled) and shows keyboard focus like any other control.
 */
export function ResendButton({ availableAt, onResend, label = "Resend code" }: ResendButtonProps) {
  const reduce = !!useReducedMotion();
  const now = useNow(250);
  const [busy, setBusy] = useState(false);
  const target = typeof availableAt === "string" ? Date.parse(availableAt) : availableAt ?? 0;
  const remaining = now && Number.isFinite(target) ? Math.max(0, Math.ceil((target - now) / 1000)) : 0;
  const waiting = remaining > 0;
  const state = waiting ? "wait" : busy ? "busy" : "ready";
  /** What the button says right now, as one string: its accessible name. */
  const words = state === "wait" ? `${label} in ${formatCountdown(remaining)}` : state === "busy" ? "Sending a new code" : label;
  const resend = async () => {
    if (waiting || busy) return;
    setBusy(true);
    try {
      await onResend();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className={styles.resend}
      aria-disabled={waiting || busy || undefined}
      aria-busy={busy || undefined}
      onClick={() => void resend()}
    >
      <span className="sr-only">{words}</span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={state}
          className={styles.resendLabel}
          aria-hidden="true"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${blur.soft}px)` }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast } }}
          transition={reduce ? { duration: duration.instant } : { duration: duration.standard, ease: [...ease.enter] }}
        >
          {state === "wait" ? <>{label} in <RollingTime seconds={remaining} /></> : state === "busy" ? "Sending a new code" : label}
        </motion.span>
      </AnimatePresence>
    </button>
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
 * shakes the row and says how many tries are left; the tenth locks entry with a countdown (LockNote); an expired code
 * asks for a new one, and says that it expired. "Resend code" waits for the server's resend time.
 */
export function CodeEntry({ challenge, verify, resend, label, submitLabel }: CodeEntryProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [challengeKey, setChallengeKey] = useState(challenge.expires_at);
  const form = useRef<HTMLFormElement>(null);
  const fine = useFinePointer();
  const now = useNow(250);
  // A new challenge (resend, or a new destination) starts clean.
  if (challengeKey !== challenge.expires_at) {
    setChallengeKey(challenge.expires_at);
    setExpired(false);
    setCode("");
  }
  const lockLeft = lockedUntil && now ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;
  const locked = lockLeft > 0;
  // A cooldown that ran out clears its message; the field is usable again.
  if (lockedUntil && now && !locked) {
    setLockedUntil(null);
    setError(null);
  }
  const at = Date.parse(challenge.expires_at);
  /** The code ran out (10 minutes), or the server said so: only a new code helps now. */
  const timeUp = !!now && Number.isFinite(at) && at <= now;
  const stale = expired || timeUp;
  /** Back to the first slot, ready for the next try (once the cells are enabled again, after the next render). */
  const [focusRequest, setFocusRequest] = useState(0);
  const refocus = () => setFocusRequest(count => count + 1);
  useEffect(() => {
    if (focusRequest) form.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus({ preventScroll: true });
  }, [focusRequest]);
  // A cooldown that ran out: the cells are usable again.
  const wasLocked = useRef(false);
  useEffect(() => {
    if (wasLocked.current && !locked) form.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus({ preventScroll: true });
    wasLocked.current = locked;
  }, [locked]);

  const submit = async (value: string) => {
    if (pending || locked) return;
    if (value.length < 6) {
      setError("Enter all 6 digits of the code.");
      return;
    }
    setPending(true);
    setError(null);
    const failure = await verify(value);
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

  const askAgain = async () => {
    setResendError(null);
    const failure = await resend();
    if (failure) {
      setResendError(failure.code === "rate_limited" && failure.retryAfter ? `${describe(failure)} Try again in ${formatCountdown(failure.retryAfter)}.` : describe(failure));
      return;
    }
    setResent(true);
    setError(null);
    setExpired(false);
  };

  /** The code ran out by the clock before the server said anything (a lock says more, and comes first). */
  const status = !locked && timeUp && !error ? "This code expired. Send a new one." : null;

  return (
    <div className={styles.codeEntry}>
      <form ref={form} className={styles.form} noValidate onSubmit={(event: FormEvent) => { event.preventDefault(); void submit(code); }}>
        <OtpInput
          className={styles.otp}
          label={label ?? "Verification code"}
          value={code}
          onChange={value => {
            setCode(value);
            if (error && value && !locked) setError(null);
            if (value.length === 6 && !pending && !locked) void submit(value);
          }}
          error={error ?? undefined}
          disabled={locked || pending}
          autoFocus={fine}
        />
        <LockNote seconds={locked ? lockLeft : null} />
        <FieldNote text={status} tone="status" />
        <Button type="submit" className={styles.wide} loading={pending} disabled={locked}>{submitLabel ?? "Verify"}</Button>
      </form>
      <div className={styles.resendRow}>
        <ResendButton availableAt={stale ? 0 : challenge.resend_available_at} onResend={askAgain} label={stale ? "Send a new code" : "Resend code"} />
        {resent && !resendError && !timeUp ? <span className={styles.resendNote} role="status">New code sent</span> : null}
      </div>
      <FieldNote text={resendError} tone="error" alert />
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
  /** Below the field (for example "We email a 6 digit code to this address."). */
  note?: string;
  /** Context for error copy. */
  errorContext?: ErrorContext;
  /** The Email | Phone switch's name ("Sign in with", "Sign up with", "Add"). */
  kindsLabel?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Email or phone, with client checks that mirror the server's and its own words when it refuses. A phone number from
 * any country goes through PhoneField, which never sends a number the Carbon did not type.
 */
export function ContactForm({ kinds, initialKind, initialEmail, initialPhone, submitLabel, onSubmit, autoFocus, note, errorContext, kindsLabel = "Sign in with" }: ContactFormProps) {
  const [kind, setKind] = useState<ContactKind>(() => (initialKind && kinds.includes(initialKind) ? initialKind : kinds[0] ?? "email"));
  const [email, setEmail] = useState(initialEmail ?? "");
  /** The phone as PhoneField last reported it; it is also where the field starts again after Email ⇄ Phone. */
  const [phone, setPhone] = useState<PhoneFieldValue>({ mode: "picker", phone: initialPhone ?? "", problem: null });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const now = useNow(500);
  const waiting = retryAt && now ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  const focusOnMount = useRef(autoFocus && kind === "email");
  useEffect(() => {
    if (focusOnMount.current) emailInput.current?.focus({ preventScroll: true });
  }, []);

  /** The same checks the server makes first, so an obvious slip never costs a request. */
  const problem = (): string | null => {
    if (kind === "email") {
      const value = email.trim();
      if (!value) return "Enter your email address.";
      if (!EMAIL.test(value)) return "Enter a full email address, like name@example.com.";
      return null;
    }
    // Only what is certainly wrong stops here; whether a number exists is the server's call (it knows every country).
    return phone.problem;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const local = problem();
    if (local) {
      setError(local);
      return;
    }
    setError(null);
    setPending(true);
    const failure = kind === "email" ? await onSubmit("email", email.trim()) : await onSubmit("phone", phone.phone, phone.country);
    setPending(false);
    if (!failure) return;
    if (failure.code === "rate_limited" && failure.retryAfter) setRetryAt(Date.now() + failure.retryAfter * 1000);
    setError(describe(failure, errorContext));
  };

  const options = kinds.map(value => ({ value, label: value === "email" ? "Email" : "Phone" }));
  const several = kinds.length > 1;

  return (
    <form className={styles.form} noValidate onSubmit={event => void submit(event)}>
      {several ? (
        <SegmentedControl
          label={kindsLabel}
          options={options}
          value={kind}
          onValueChange={value => {
            setKind(value as ContactKind);
            setError(null);
            setRetryAt(null);
          }}
          className={styles.segments}
        />
      ) : null}
      {kind === "email" ? (
        <div className={several ? styles.quietLabel : undefined}>
          <Input
            ref={emailInput}
            label="Email"
            type="email"
            name="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="name@example.com"
            value={email}
            onChange={event => {
              setEmail(event.currentTarget.value);
              // The send limit is per address: another address may go now.
              setRetryAt(null);
              if (error) setError(null);
            }}
            error={error ?? undefined}
            description={error ? undefined : note}
          />
        </div>
      ) : (
        <PhoneField
          label="Phone number"
          hideLabel={several}
          initial={phone.phone}
          onChange={value => {
            if (value.phone !== phone.phone) {
              // The send limit is per number: another number may go now.
              setRetryAt(null);
              setError(null);
            }
            setPhone(value);
          }}
          error={error}
          description={note}
        />
      )}
      <Button type="submit" className={styles.wide} loading={pending} disabled={waiting > 0}>
        {waiting > 0 ? `Try again in ${formatCountdown(waiting)}` : submitLabel}
      </Button>
    </form>
  );
}

/** Email or phone as the kinds a list of methods offers, in the app's order. */
export function contactKinds(methods: readonly SigninMethod[]): ContactKind[] {
  return methods.filter((method): method is ContactKind => method === "email" || method === "phone");
}
