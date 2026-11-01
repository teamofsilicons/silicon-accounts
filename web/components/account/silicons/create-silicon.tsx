"use client";

/**
 * Creating a Silicon you are custodian of (POST /v1/me/silicons): a display name, its si:id (checked as you type, and
 * suggested from the name until you edit it), its timezone (yours by default), an optional webhook, and an optional
 * STK of your own. It is the form of the /silicons/new page (new-silicon-page.tsx; Anil, 2026-11-01: a page, not a side
 * panel). The generated STK comes back exactly once; revealCreated keeps it for the new Silicon's page to show in a
 * reveal card, which holds the only copy (the mutation keeps none). A retry of the same request reuses its
 * Idempotency-Key, so a lost answer never creates the Silicon twice.
 */
import { useMemo, useState, type FormEvent } from "react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Checkbox } from "@teamofsilicons/silicon-ui/checkbox";
import { Combobox } from "@teamofsilicons/silicon-ui/combobox";
import { Input } from "@teamofsilicons/silicon-ui/input";
import { ApiError } from "@/lib/api/errors";
import type { CarbonMe, SiliconCreated } from "@/lib/api/types";
import { timezoneOptions } from "@/lib/timezones";
import { describeError } from "../parts/common";
import { IdField, useIdCheck } from "../parts/id-field";
import { useCreateSiliconOnce } from "../parts/queries";
import { addReveal } from "../parts/reveals";
import { normalizeStk, stkProblem, stkSecret } from "../parts/stk";
import styles from "./create-silicon.module.css";

/** "Head of Growth" → "head_of_growth": a handle suggestion from a display name (3 to 30 of a-z, 0-9, _ and -). */
export function handleFromName(name: string): string {
  const handle = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30).replace(/_+$/, "");
  return handle.length >= 3 ? handle : "";
}

/**
 * The secrets a new Silicon comes back with (its generated STK, its webhook signing secret), kept as a reveal for its
 * own page to show once (parts/reveals.ts): the only copy there will ever be.
 */
export function revealCreated(created: SiliconCreated) {
  const item = created.silicon;
  const id = item.id ?? item.uuid;
  const secrets = [
    ...(created.stk ? [stkSecret(id, created.stk)] : []),
    ...(created.webhook_secret ? [{ label: "Webhook signing secret", value: created.webhook_secret, note: `Verifies the events sent to ${item.webhook_url ?? "its webhook"}.` }] : []),
  ];
  if (!secrets.length) return;
  addReveal({
    silicon: item.uuid,
    origin: "created",
    title: created.stk ? `${id} is ready. Store its STK now` : `${id} is ready. Store its webhook secret now`,
    description: created.stk
      ? `This is the password ${id} signs in with. Silicon Accounts keeps only its hash, so it can never be shown again; if it is lost, rotate it.`
      : "Silicon Accounts cannot show it again. Setting the webhook URL again makes a new one.",
    secrets,
  });
}

export function CreateSiliconForm({ me, onCreated, onCancel }: { me: CarbonMe; onCreated: (created: SiliconCreated) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [timezone, setTimezone] = useState(me.timezone);
  const [webhook, setWebhook] = useState("");
  const [own, setOwn] = useState(false);
  const [stk, setStk] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<{ message: string; suggestions: string[] } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const check = useIdCheck("si:", handle, null);
  const options = useMemo(() => timezoneOptions(undefined, [me.timezone]), [me.timezone]);
  const create = useCreateSiliconOnce();

  const onName = (value: string) => {
    setName(value);
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
    const url = webhook.trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") next.webhook_url = "A webhook URL must start with https://.";
      } catch {
        next.webhook_url = `“${url}” is not a full URL. Start it with https://.`;
      }
    }
    return next;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validate();
    setErrors(found);
    if (check.status !== "available") {
      setFailure({
        message: check.status === "empty" ? "Pick an id for it, for example si:scout." : check.status === "checking" ? "Still checking the id; try again in a moment." : "message" in check ? check.message : "Pick another id.",
        suggestions: [],
      });
    }
    if (Object.values(found).some(Boolean) || check.status !== "available") return;
    setFailure(null);
    setFormError(null);
    try {
      // The hook keeps one Idempotency-Key per request body until it succeeds, and toasts a refusal.
      const created = await create.run({
        id: check.id,
        display_name: name.trim(),
        timezone: timezone || undefined,
        webhook_url: webhook.trim() || undefined,
        stk: own ? normalizeStk(stk) : undefined,
      });
      onCreated(created);
    } catch (raw) {
      const error = ApiError.from(raw);
      const fields = error.fields;
      if (error.code === "id_taken" || error.code === "id_reserved" || error.code === "invalid_id") {
        setFailure({ message: describeError(error), suggestions: error.suggestions.slice(0, 3) });
      } else if (Object.keys(fields).length) {
        setErrors(fields);
      } else {
        setFormError(describeError(error));
      }
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Input label="Display name" value={name} onChange={event => onName(event.target.value)} placeholder="Scout" maxLength={100} error={errors.display_name || undefined} autoComplete="off" />
      <IdField
        prefix="si:"
        label="Id"
        value={handle}
        onValueChange={value => { setHandle(value); setHandleEdited(true); setFailure(null); }}
        check={check}
        error={failure?.message ?? errors.id ?? null}
        suggestions={failure?.suggestions}
        description="What Carbons, Silicons and apps type to find it. 3 to 30 of a to z, 0 to 9, - and _."
      />
      <div className={styles.field}>
        <Combobox label="Timezone" options={options} value={timezone} onValueChange={setTimezone} description="Its local time. Yours to start with." />
        {errors.timezone ? <p className={styles.error} role="alert">{errors.timezone}</p> : null}
      </div>
      <Input
        label="Webhook URL (optional)"
        type="url"
        inputMode="url"
        placeholder="https://scout.example/hooks/accounts"
        value={webhook}
        onChange={event => { setWebhook(event.target.value); setErrors(current => ({ ...current, webhook_url: "" })); }}
        error={errors.webhook_url || undefined}
        description="Where it hears about its own account (id changes, STK rotations, custodian changes). You get its signing secret once."
        autoComplete="off"
        spellCheck={false}
      />
      <div className={styles.stk}>
        <Checkbox label="Choose its STK yourself" description="Otherwise one is generated (stk- and 12 hex digits) and shown to you once." checked={own} onCheckedChange={value => { setOwn(value === true); setErrors(current => ({ ...current, stk: "" })); }} />
        {own ? (
          <Input label="STK" className={styles.mono} value={stk} onChange={event => { setStk(event.target.value); setErrors(current => ({ ...current, stk: "" })); }} placeholder="stk-0123456789abcdef" autoComplete="off" spellCheck={false} error={errors.stk || undefined} description="stk- followed by 8 to 32 hex digits. Silicon Accounts keeps only its hash." />
        ) : null}
      </div>
      {formError ? <Alert tone="danger" title="The Silicon was not created">{formError}</Alert> : null}
      <div className={styles.footer}>
        <Button type="button" variant="ghost" disabled={create.isPending} onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={create.isPending}>Create Silicon</Button>
      </div>
    </form>
  );
}
