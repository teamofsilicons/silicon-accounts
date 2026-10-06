"use client";

/**
 * Adding an email or a phone number: type it, get a 6-digit code (valid 10 minutes), type the code. The same checks
 * the server makes run first (shape, already on the account), and every refusal is explained where it happened: a
 * taken address, a wrong code with the tries left, a cooldown with its countdown, an expired code with a way to get
 * another one.
 */
import { useRef, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { OtpInput } from "@/components/arc/otp-input/otp-input";
import { PhoneInput } from "@/components/arc/phone-input/phone-input";
import { ApiError } from "@/lib/api/errors";
import type { ContactChallenge } from "@/lib/api/types";
import { formatCountdown, formatPhone } from "@/lib/format";
import { useAddEmail, useAddPhone } from "@/lib/query/account";
import { describeError, reportFailure, useNow } from "../parts/common";
import { HeightFrame } from "../parts/height-frame";
import { useVerifyContact } from "../parts/queries";
import styles from "./sign-in-methods.module.css";

type Channel = "email" | "phone";
type Step = { kind: "closed" } | { kind: "enter" } | { kind: "code"; challenge: ContactChallenge; value: string };

export interface ContactAdderProps {
  channel: Channel;
  /** What the account has now (to refuse duplicates before asking the server). */
  existing: string[];
  /** ISO country for local phone numbers. */
  defaultCountry?: string;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ContactAdder({ channel, existing, defaultCountry = "US" }: ContactAdderProps) {
  const now = useNow(1000);
  const [step, setStep] = useState<Step>({ kind: "closed" });
  const [value, setValue] = useState("");
  const [phoneValid, setPhoneValid] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [expired, setExpired] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const codeBox = useRef<HTMLDivElement>(null);
  const addEmail = useAddEmail();
  const addPhone = useAddPhone();
  const verify = useVerifyContact(channel);
  const sending = addEmail.isPending || addPhone.isPending;

  const noun = channel === "email" ? "email" : "phone number";
  const shown = (raw: string) => (channel === "phone" ? formatPhone(raw) : raw);
  const normalized = channel === "email" ? value.trim().toLowerCase() : value;
  const focusField = () => requestAnimationFrame(() => requestAnimationFrame(() => field.current?.focus()));

  const localProblem = (): string | null => {
    if (!normalized) return channel === "email" ? "Enter the email address to add." : "Enter the phone number to add.";
    if (channel === "email" && !EMAIL_SHAPE.test(normalized)) return `Enter an email like name@example.com; “${normalized}” is missing ${normalized.includes("@") ? "a domain such as example.com" : "an @"}.`;
    if (channel === "phone" && !phoneValid) return "That number is not complete for the country picked. Check the digits or pick the right country.";
    if (existing.some(item => item.toLowerCase() === normalized)) return `${shown(normalized)} is already on your account.`;
    return null;
  };

  const open = () => {
    setError(null);
    setStep({ kind: "enter" });
    focusField();
  };
  const close = () => {
    setStep({ kind: "closed" });
    setValue("");
    setCode("");
    setError(null);
    setExpired(false);
    setLockedUntil(0);
    requestAnimationFrame(() => requestAnimationFrame(() => opener.current?.focus()));
  };

  const send = async () => {
    const problem = localProblem();
    if (problem) {
      setError(problem);
      field.current?.focus();
      return;
    }
    setError(null);
    try {
      const target = normalized;
      // The add hooks toast a refusal with the server's words; the same words show beside the field.
      const challenge = channel === "email" ? await addEmail.mutateAsync(target) : await addPhone.mutateAsync({ phone: target });
      setCode("");
      setExpired(false);
      setLockedUntil(0);
      setStep({ kind: "code", challenge, value: target });
    } catch (raw) {
      setError(describeError(raw));
      if (step.kind === "enter") field.current?.focus();
    }
  };

  const check = async (entered: string) => {
    if (step.kind !== "code" || verify.isPending || Date.now() < lockedUntil) return;
    setError(null);
    try {
      await verify.mutateAsync({ challengeId: step.challenge.challenge_id, code: entered });
      close();
    } catch (raw) {
      const failure = ApiError.from(raw);
      setCode("");
      if (failure.code === "verification_locked" || failure.status === 423 || (failure.code === "invalid_code" && failure.remainingAttempts === 0)) {
        const until = failure.lockedUntil ? Date.parse(failure.lockedUntil) : Number.NaN;
        setLockedUntil(Number.isFinite(until) ? until : Date.now() + (failure.retryAfter ?? 60) * 1000);
      }
      if (failure.code === "code_expired" || failure.code === "code_already_used") setExpired(true);
      if (failure.code === "challenge_not_found" || failure.code === `${channel}_in_use`) {
        setStep({ kind: "enter" });
        focusField();
      }
      // A wrong code is answered next to the code; everything else (a cooldown, a taken address) is also toasted.
      setError(failure.code === "invalid_code" ? describeError(failure) : reportFailure(failure, `The ${noun} was not added`));
      // The code was cleared: the next try starts in the first slot.
      if (failure.code === "invalid_code" && failure.remainingAttempts !== 0) requestAnimationFrame(() => codeBox.current?.querySelector<HTMLInputElement>("input")?.focus());
    }
  };

  const resendIn = step.kind === "code" && step.challenge.resend_available_at ? Math.max(0, (Date.parse(step.challenge.resend_available_at) - now) / 1000) : 0;
  const lockLeft = Math.max(0, (lockedUntil - now) / 1000);
  const expiresIn = step.kind === "code" ? Math.max(0, (Date.parse(step.challenge.expires_at) - now) / 1000) : 0;
  const codeError = lockLeft > 0 ? `${error ?? "Too many wrong codes."} You can try again in ${formatCountdown(lockLeft)}.` : error ?? undefined;

  return (
    <HeightFrame morphKey={step.kind} className={styles.adderFrame}>
      {step.kind === "closed" ? (
        <button ref={opener} data-sq="surface" type="button" className={styles.addButton} onClick={open}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          Add {channel === "email" ? "an email" : "a phone number"}
        </button>
      ) : step.kind === "enter" ? (
        <form className={styles.adder} onSubmit={(event: FormEvent) => { event.preventDefault(); void send(); }} noValidate>
          {channel === "phone" ? (
            <PhoneInput
              ref={field}
              label="Phone number"
              value={value}
              defaultCountry={defaultCountry}
              onValueChange={(next, details) => { setValue(next); setPhoneValid(details.valid); setError(null); }}
              error={error ?? undefined}
              description="We text a 6-digit code to it. It signs you in once it is verified."
            />
          ) : (
            <Input
              ref={field}
              label="Email address"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="name@example.com"
              value={value}
              onChange={event => { setValue(event.target.value); setError(null); }}
              error={error ?? undefined}
              description="We send a 6-digit code to it. It signs you in once it is verified."
            />
          )}
          <div className={styles.adderActions}>
            <Button type="button" variant="ghost" onClick={close} disabled={sending}>Cancel</Button>
            <Button type="submit" loading={sending}>Send code</Button>
          </div>
        </form>
      ) : (
        <div className={styles.adder}>
          <p className={styles.sentTo}>
            Enter the 6-digit code sent to <strong>{step.challenge.destination || shown(step.value)}</strong>.
            {expiresIn > 0 && !expired ? <> It works for {formatCountdown(expiresIn)} more.</> : <> It has expired; send a new one.</>}
          </p>
          <div ref={codeBox}>
          <OtpInput
            label="Verification code"
            value={code}
            onChange={next => {
              setCode(next);
              if (error && !lockLeft) setError(null);
              if (next.length === 6) void check(next);
            }}
            autoFocus
            disabled={lockLeft > 0 || expired}
            error={codeError}
          />
          </div>
          <div className={styles.codeActions}>
            <button type="button" className={styles.linkButton} onClick={() => { setStep({ kind: "enter" }); setError(null); focusField(); }}>
              Use a different {noun}
            </button>
            <span className={styles.codeRight}>
              {resendIn > 0 && !expired ? <span className={styles.resendNote}>New code in {formatCountdown(resendIn)}</span> : null}
              <Button type="button" variant="ghost" size="sm" onClick={close}>Cancel</Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => void send()} loading={sending} disabled={resendIn > 0 && !expired}>Send a new code</Button>
            </span>
          </div>
          <span className="sr-only" role="status">{verify.isPending ? "Checking the code" : ""}</span>
        </div>
      )}
    </HeightFrame>
  );
}
