/**
 * Adding an email or a phone number: type it, get a 6-digit code (valid 10 minutes), type the code. The same checks the
 * server makes run first (shape, already on the account), and every refusal is explained where it happened: a taken
 * address, a wrong code with the tries left, a cooldown with its countdown, an expired code with a way to get another.
 */
import { Match, Show, Switch, createMemo, createSignal, onCleanup } from "solid-js";
import { Plus } from "lucide-solid";
import { api, ApiError, type ContactChallenge, type EmailView, type PhoneView } from "../../../api";
import { Button } from "../../../arc/button/button";
import { Input } from "../../../arc/input/input";
import { OtpInput } from "../../../arc/otp-input/otp-input";
import { PhoneInput } from "../../../arc/phone-input/phone-input";
import { HeightFrame } from "../../../arc/lib/HeightFrame";
import { useSquircle } from "../../../arc/lib/squircle";
import { formatCountdown, formatPhone } from "../../../lib/format";
import { createNow, describeError, reportFailure } from "./common";
import styles from "./contact.module.css";

type Channel = "email" | "phone";
type Challenge = ContactChallenge & { destination?: string; resend_available_at?: string };
type Step = { kind: "closed" } | { kind: "enter" } | { kind: "code"; challenge: Challenge; value: string };

export interface ContactAdderProps<C extends Channel> {
  channel: C;
  /** What the account has now (to refuse duplicates before asking the server). */
  existing: string[];
  /** The updated list from the server once the code is verified. */
  onAdded: (list: C extends "email" ? EmailView[] : PhoneView[], added: string) => void;
  /** ISO country for local phone numbers. */
  defaultCountry?: string;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ContactAdder<C extends Channel>(props: ContactAdderProps<C>) {
  const now = createNow(1000);
  const [step, setStep] = createSignal<Step>({ kind: "closed" });
  const [value, setValue] = createSignal("");
  const [phoneValid, setPhoneValid] = createSignal(false);
  const [code, setCode] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  const [verifying, setVerifying] = createSignal(false);
  const [lockedUntil, setLockedUntil] = createSignal(0);
  const [expired, setExpired] = createSignal(false);
  let field: HTMLInputElement | undefined;
  let opener: HTMLButtonElement | undefined;
  onCleanup(() => setStep({ kind: "closed" }));

  const noun = () => (props.channel === "email" ? "email" : "phone number");
  const shown = (raw: string) => (props.channel === "phone" ? formatPhone(raw) : raw);
  const normalized = () => (props.channel === "email" ? value().trim().toLowerCase() : value());

  const localProblem = (): string | null => {
    const next = normalized();
    if (!next) return props.channel === "email" ? "Enter the email address to add." : "Enter the phone number to add.";
    if (props.channel === "email" && !EMAIL_SHAPE.test(next)) return `Enter an email like name@example.com; “${next}” is missing ${next.includes("@") ? "a domain such as example.com" : "an @"}.`;
    if (props.channel === "phone" && !phoneValid()) return "That number is not complete for the country picked. Check the digits or pick the right country.";
    if (props.existing.some(item => item.toLowerCase() === next)) return `${shown(next)} is already on your account.`;
    return null;
  };

  const open = () => {
    setError(null);
    setStep({ kind: "enter" });
    queueMicrotask(() => field?.focus());
  };
  const close = () => {
    setStep({ kind: "closed" });
    setValue("");
    setCode("");
    setError(null);
    setExpired(false);
    setLockedUntil(0);
    queueMicrotask(() => opener?.focus());
  };

  const send = async () => {
    const problem = localProblem();
    if (problem) {
      setError(problem);
      field?.focus();
      return;
    }
    setSending(true);
    setError(null);
    try {
      const target = normalized();
      const challenge = (props.channel === "email" ? await api.me.emails.add(target) : await api.me.phones.add(target)) as Challenge;
      setCode("");
      setExpired(false);
      setLockedUntil(0);
      setStep({ kind: "code", challenge, value: target });
    } catch (raw) {
      const failure = ApiError.from(raw);
      setError(reportFailure(failure, "No code was sent"));
      if (step().kind === "enter") field?.focus();
    } finally {
      setSending(false);
    }
  };

  const verify = async (entered: string) => {
    const current = step();
    if (current.kind !== "code" || verifying() || now() < lockedUntil()) return;
    setVerifying(true);
    setError(null);
    try {
      const list = props.channel === "email" ? await api.me.emails.verify(current.challenge.challenge_id, entered) : await api.me.phones.verify(current.challenge.challenge_id, entered);
      props.onAdded(list as C extends "email" ? EmailView[] : PhoneView[], current.value);
      close();
    } catch (raw) {
      const failure = ApiError.from(raw);
      setCode("");
      if (failure.code === "verification_locked" || failure.status === 423 || (failure.code === "invalid_code" && failure.remainingAttempts === 0)) {
        setLockedUntil(Date.now() + (failure.retryAfter ?? 60) * 1000);
      }
      if (failure.code === "code_expired" || failure.code === "code_already_used") setExpired(true);
      if (failure.code === "challenge_not_found" || failure.code === `${props.channel}_in_use`) {
        setStep({ kind: "enter" });
      }
      // A wrong code is answered next to the code; everything else (a cooldown, a taken address) is also toasted.
      setError(failure.code === "invalid_code" ? describeError(failure) : reportFailure(failure, `The ${noun()} was not added`));
    } finally {
      setVerifying(false);
    }
  };

  const resendIn = createMemo(() => {
    const current = step();
    if (current.kind !== "code" || !current.challenge.resend_available_at) return 0;
    return Math.max(0, (Date.parse(current.challenge.resend_available_at) - now()) / 1000);
  });
  const lockLeft = () => Math.max(0, (lockedUntil() - now()) / 1000);
  const expiresIn = () => {
    const current = step();
    return current.kind === "code" ? Math.max(0, (Date.parse(current.challenge.expires_at) - now()) / 1000) : 0;
  };

  return (
    <HeightFrame morphKey={step().kind} class={styles.adderFrame}>
      <Switch>
        <Match when={step().kind === "closed"}>
          <button ref={el => { opener = el; useSquircle(el); }} type="button" class={styles.addButton} onClick={open}>
            <Plus size={16} stroke-width={1.75} aria-hidden="true" />
            Add {props.channel === "email" ? "an email" : "a phone number"}
          </button>
        </Match>
        <Match when={step().kind === "enter"}>
          <form class={styles.adder} onSubmit={event => { event.preventDefault(); void send(); }} novalidate>
            <Show
              when={props.channel === "phone"}
              fallback={
                <Input
                  ref={el => (field = el)}
                  label="Email address"
                  type="email"
                  autocomplete="email"
                  inputmode="email"
                  placeholder="name@example.com"
                  value={value()}
                  onInput={event => { setValue(event.currentTarget.value); setError(null); }}
                  error={error()}
                  description="We send a 6-digit code to it. It signs you in once it is verified."
                />
              }
            >
              <PhoneInput
                ref={el => (field = el)}
                label="Phone number"
                value={value()}
                defaultCountry={props.defaultCountry ?? "US"}
                onValueChange={(next, details) => { setValue(next); setPhoneValid(details.valid); setError(null); }}
                error={error()}
                description="We text a 6-digit code to it. It signs you in once it is verified."
              />
            </Show>
            <div class={styles.adderActions}>
              <Button type="button" variant="ghost" onClick={close} disabled={sending()}>Cancel</Button>
              <Button type="submit" loading={sending()}>Send code</Button>
            </div>
          </form>
        </Match>
        <Match when={step().kind === "code" ? (step() as Extract<Step, { kind: "code" }>) : null}>
          {current => (
            <div class={styles.adder}>
              <p class={styles.sentTo}>
                Enter the 6-digit code sent to <strong>{current().challenge.destination ?? shown(current().value)}</strong>.
                <Show when={expiresIn() > 0} fallback={<> It has expired; send a new one.</>}> It works for {formatCountdown(expiresIn())} more.</Show>
              </p>
              <OtpInput
                label="Verification code"
                value={code()}
                onChange={next => { setCode(next); if (error() && !lockLeft()) setError(null); }}
                onComplete={entered => void verify(entered)}
                autoFocus
                disabled={verifying() || lockLeft() > 0 || expired()}
                error={lockLeft() > 0 ? `${error() ?? "Too many wrong codes."} You can try again in ${formatCountdown(lockLeft())}.` : error()}
              />
              <div class={styles.codeActions}>
                <button type="button" class={styles.linkButton} onClick={() => { setStep({ kind: "enter" }); setError(null); queueMicrotask(() => field?.focus()); }}>
                  Use a different {noun()}
                </button>
                <span class={styles.codeRight}>
                  <Show when={resendIn() > 0 && !expired()}>
                    <span class={styles.resendNote}>New code in {formatCountdown(resendIn())}</span>
                  </Show>
                  <Button type="button" variant="ghost" size="sm" onClick={close}>Cancel</Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => void send()} loading={sending()} disabled={resendIn() > 0 && !expired()}>Send a new code</Button>
                </span>
              </div>
              <span class="sr-only" role="status">{verifying() ? "Checking the code" : ""}</span>
            </div>
          )}
        </Match>
      </Switch>
    </HeightFrame>
  );
}
