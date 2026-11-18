"use client";

/**
 * Creating a Silicon you are custodian of (POST /v1/me/silicons), as a three-step wizard on Silicon UI's Stepper (Anil,
 * 2026-11-07, a prototype): its name and si:id (checked as you type, suggested from the name until you edit it; its status
 * is the Input's own description or error), its timezone (this browser's to start with, picked on Sky bands), then its STK: made for it, or
 * your own. Continue checks the step it leaves; Create Silicon sends them all, and a refusal goes back to
 * the step with the field at fault. Silicon UI's MultiStepForm isn't in 0.4, so the steps are held here.
 *
 * The generated STK comes back exactly once; revealCreated keeps it for the new Silicon's page to show in a reveal card,
 * which holds the only copy (the mutation keeps none). A retry of the same request reuses its Idempotency-Key, so a lost
 * answer never creates the Silicon twice.
 */
import { useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Checkbox } from "@teamofsilicons/silicon-ui/checkbox";
import { Combobox } from "@teamofsilicons/silicon-ui/combobox";
import { Input } from "@teamofsilicons/silicon-ui/input";
import { Stepper } from "@teamofsilicons/silicon-ui/stepper";
import { ApiError } from "@/lib/api/errors";
import type { CarbonMe, SiliconCreated } from "@/lib/api/types";
import { browserTimezone, timezoneOptions } from "@/lib/timezones";
import { describeError } from "../parts/common";
import { normalizeHandle, useIdCheck } from "../parts/id-field";
import { useCreateSiliconOnce } from "../parts/queries";
import { addReveal } from "../parts/reveals";
import { normalizeStk, stkProblem, stkSecret } from "../parts/stk";
import { SkyBands } from "./sky-bands";
import styles from "./create-silicon.module.css";

const STEPS = [
  { id: "name", label: "Name and id" },
  { id: "timezone", label: "Timezone" },
  { id: "stk", label: "STK" },
];

/** How long after arriving on the last step a submit is ignored, in ms. */
const ARRIVAL_PAUSE = 600;

/** "Head of Growth" → "head_of_growth": a handle suggestion from a display name (3 to 30 of a-z, 0-9, _ and -). */
export function handleFromName(name: string): string {
  const handle = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30).replace(/_+$/, "");
  return handle.length >= 3 ? handle : "";
}

/**
 * The STK a new Silicon comes back with, kept as a reveal for its own page to show once (parts/reveals.ts): the only
 * copy there will ever be. Silicon webhooks were replaced by Ting, so there is no signing secret to show.
 */
export function revealCreated(created: SiliconCreated) {
  if (!created.stk) return;
  const item = created.silicon;
  const id = item.id ?? item.uuid;
  addReveal({
    silicon: item.uuid,
    origin: "created",
    title: `${id} is ready. Store its STK now`,
    description: `This is the password ${id} signs in with. Silicon Accounts keeps only its hash, so it can never be shown again; if it is lost, rotate it.`,
    secrets: [stkSecret(id, created.stk)],
  });
}

/** `stepsIn`, when given, is where the Stepper shows: the page's banner. */
export function CreateSiliconForm({ me, onCreated, onCancel, stepsIn }: { me: CarbonMe; onCreated: (created: SiliconCreated) => void; onCancel: () => void; stepsIn?: HTMLElement | null }) {
  const [step, setStep] = useState(0);
  const stepBody = useRef<HTMLDivElement>(null);
  const arrivedAt = useRef(0);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [timezone, setTimezone] = useState(() => browserTimezone() ?? me.timezone);
  const [own, setOwn] = useState(false);
  const [stk, setStk] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<{ message: string; suggestions: string[] } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const check = useIdCheck("si:", handle, null);
  const options = useMemo(() => timezoneOptions(undefined, [me.timezone, timezone]), [me.timezone, timezone]);
  const create = useCreateSiliconOnce();

  // Focus lands on the step itself: its first field may be a Combobox, which opens on focus.
  const go = (next: number) => {
    setStep(next);
    arrivedAt.current = Date.now();
    requestAnimationFrame(() => stepBody.current?.focus());
  };

  const onName = (value: string) => {
    setName(value);
    setFailure(null);
    setErrors(current => ({ ...current, display_name: "" }));
    if (!handleEdited) setHandle(handleFromName(value));
  };

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {};
    const display = name.trim();
    if (!display) next.display_name = "Give it a display name, for example Scout.";
    else if (display.length > 100) next.display_name = `A display name can be at most 100 characters (this one has ${display.length}).`;
    if (own) {
      const problem = stkProblem(stk);
      if (problem) next.stk = problem;
    }
    return next;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    // Continue and Create Silicon share a spot: the rest of a double-click or a held Enter never creates a Silicon.
    if (step === STEPS.length - 1 && Date.now() - arrivedAt.current < ARRIVAL_PAUSE) return;
    const found = validate();
    setErrors(found);
    if (check.status !== "available") {
      setFailure({
        message: check.status === "empty" ? "Pick an id for it, for example si:scout." : check.status === "checking" ? "Still checking the id; try again in a moment." : "message" in check ? check.message : "Pick another id.",
        suggestions: [],
      });
    }
    const nameReady = !found.display_name && check.status === "available";
    if (step === 0) {
      if (nameReady) go(1);
      return;
    }
    if (step === 1) return go(2);
    if (!nameReady) go(0);
    if (Object.values(found).some(Boolean) || check.status !== "available") return;
    setFailure(null);
    setFormError(null);
    try {
      // The hook keeps one Idempotency-Key per request body until it succeeds, and toasts a refusal.
      const created = await create.run({
        id: check.id,
        display_name: name.trim(),
        timezone: timezone || undefined,
        stk: own ? normalizeStk(stk) : undefined,
      });
      onCreated(created);
    } catch (raw) {
      const error = ApiError.from(raw);
      const fields = error.fields;
      if (error.code === "id_taken" || error.code === "id_reserved" || error.code === "invalid_id") {
        setFailure({ message: describeError(error), suggestions: error.suggestions.slice(0, 3) });
        go(0);
      } else if (Object.keys(fields).length) {
        setErrors(fields);
        if (fields.display_name || fields.id) go(0);
        else if (fields.timezone) go(1);
      } else {
        setFormError(describeError(error));
      }
    }
  };

  // The id's line: a failure or a broken rule as the field's error; otherwise where it stands, else where it came from.
  const idError = failure?.message ?? errors.id ?? (check.status === "invalid" || check.status === "unavailable" || check.status === "error" ? check.message : null);
  const idLine = check.status === "available" ? check.message : check.status === "checking" ? "Checking…" : "Suggested from the name. You can change it later.";
  const suggestions = failure?.suggestions.length ? failure.suggestions : check.status === "unavailable" ? check.suggestions : [];

  const stepper = <Stepper steps={STEPS} current={step} onStepSelect={go} label="Create a Silicon" compact className={styles.steps} />;

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {stepsIn ? createPortal(stepper, stepsIn) : stepper}
      {step === 0 ? (
        <div ref={stepBody} className={styles.group} tabIndex={-1}>
          <Input label="Name" value={name} onChange={event => onName(event.target.value)} placeholder="Scout" maxLength={100} error={errors.display_name || undefined} autoComplete="off" />
          <div className={check.status === "available" && !idError ? styles.available : undefined}>
            <Input
              label="Id"
              value={`si:${handle}`}
              onChange={event => { setHandle(normalizeHandle(event.target.value, "si:")); setHandleEdited(true); setFailure(null); }}
              error={idError || undefined}
              description={idError ? undefined : idLine}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={64}
            />
          </div>
          {suggestions.length ? (
            <div className={styles.suggestions}>
              {suggestions.map(id => (
                <Button key={id} type="button" variant="secondary" size="xs" onClick={() => { setHandle(normalizeHandle(id, "si:")); setHandleEdited(true); setFailure(null); }}>{id}</Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : step === 1 ? (
        <div ref={stepBody} className={styles.group} tabIndex={-1}>
          <SkyBands value={timezone} onChange={setTimezone} />
          <Combobox label="Timezone" options={options} value={timezone} onValueChange={setTimezone} description="Its local time. Yours to start with." />
          {errors.timezone ? <Alert tone="danger" title={errors.timezone} /> : null}
        </div>
      ) : (
        <div ref={stepBody} className={styles.group} tabIndex={-1}>
          <Checkbox label="Choose its STK yourself" description="Otherwise one is made for it and shown to you once." checked={own} onCheckedChange={value => { setOwn(value === true); setErrors(current => ({ ...current, stk: "" })); }} />
          {own ? (
            <Input label="STK" value={stk} onChange={event => { setStk(event.target.value); setErrors(current => ({ ...current, stk: "" })); }} placeholder="stk-0123456789abcdef" autoComplete="off" spellCheck={false} error={errors.stk || undefined} description="stk- followed by 8 to 32 hex digits. Silicon Accounts keeps only its hash." />
          ) : null}
        </div>
      )}

      {formError ? <Alert tone="danger" title="The Silicon was not created">{formError}</Alert> : null}
      <div className={styles.footer}>
        <Button type="submit" loading={create.isPending}>{step === STEPS.length - 1 ? "Create Silicon" : "Continue"}</Button>
        {step === 0 ? (
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        ) : (
          <Button type="button" variant="ghost" disabled={create.isPending} onClick={() => go(step - 1)}>Back</Button>
        )}
      </div>
    </form>
  );
}
