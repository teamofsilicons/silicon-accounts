/**
 * Creating a Silicon you are custodian of (POST /v1/me/silicons): a display name, its si:id (checked as you type, and
 * suggested from the name until you edit it), its timezone (yours by default), an optional webhook, and an optional
 * STK of your own. The generated STK comes back exactly once; the page shows it in a reveal card.
 */
import { Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { api, ApiError, newIdempotencyKey, type CarbonMe, type SiliconCreated } from "../../../api";
import { Alert } from "../../../arc/alert/alert";
import { Button } from "../../../arc/button/button";
import { Checkbox } from "../../../arc/checkbox/checkbox";
import { Combobox } from "../../../arc/combobox/combobox";
import { Drawer, DrawerClose, DrawerContent } from "../../../arc/drawer/drawer";
import { Input } from "../../../arc/input/input";
import { timezoneOptions } from "../../../lib/timezones";
import { createIdCheck, IdField } from "./IdField";
import { normalizeStk, stkProblem } from "./stk";
import { reportFailure } from "./common";
import styles from "./create.module.css";

export interface CreateSiliconProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  me: CarbonMe;
  onCreated: (created: SiliconCreated) => void;
}

/** "Head of Growth" → "head_of_growth": a handle suggestion from a display name (3 to 30 of a-z, 0-9, _ and -). */
export function handleFromName(name: string): string {
  const handle = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30).replace(/_+$/, "");
  return handle.length >= 3 ? handle : "";
}

export function CreateSilicon(props: CreateSiliconProps) {
  const formId = `create-silicon-${createUniqueId()}`;
  const [name, setName] = createSignal("");
  const [handle, setHandle] = createSignal("");
  const [handleEdited, setHandleEdited] = createSignal(false);
  const [timezone, setTimezone] = createSignal(props.me.timezone);
  const [webhook, setWebhook] = createSignal("");
  const [own, setOwn] = createSignal(false);
  const [stk, setStk] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [failure, setFailure] = createSignal<{ message: string; suggestions: string[] } | null>(null);
  const [formError, setFormError] = createSignal<string | null>(null);
  let key = newIdempotencyKey();
  let keyFor = "";
  const check = createIdCheck(() => "si:", handle, () => null);
  const options = createMemo(() => timezoneOptions(new Date(), [props.me.timezone]));

  const reset = () => {
    setName("");
    setHandle("");
    setHandleEdited(false);
    setTimezone(props.me.timezone);
    setWebhook("");
    setOwn(false);
    setStk("");
    setErrors({});
    setFailure(null);
    setFormError(null);
    key = newIdempotencyKey();
    keyFor = "";
  };

  const onName = (value: string) => {
    setName(value);
    setErrors(current => ({ ...current, display_name: "" }));
    if (!handleEdited()) setHandle(handleFromName(value));
  };

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {};
    const display = name().trim();
    if (!display) next.display_name = "Give it a display name, for example Scout.";
    else if (display.length > 100) next.display_name = `A display name can be at most 100 characters (this one has ${display.length}).`;
    if (own()) {
      const problem = stkProblem(stk());
      if (problem) next.stk = problem;
    }
    const url = webhook().trim();
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

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending()) return;
    const found = validate();
    setErrors(found);
    const idCheck = check();
    if (idCheck.status !== "available") {
      setFailure({ message: idCheck.status === "empty" ? "Pick an id for it, for example si:scout." : idCheck.status === "checking" ? "Still checking the id; try again in a moment." : "message" in idCheck ? idCheck.message : "Pick another id.", suggestions: [] });
    }
    if (Object.values(found).some(Boolean) || idCheck.status !== "available") return;
    const body = {
      id: idCheck.id,
      display_name: name().trim(),
      timezone: timezone() || undefined,
      webhook_url: webhook().trim() || undefined,
      stk: own() ? normalizeStk(stk()) : undefined,
    };
    // A retry of the same request reuses its Idempotency-Key (so a lost answer never creates the Silicon twice); a
    // changed request gets a new one.
    const fingerprint = JSON.stringify(body);
    if (fingerprint !== keyFor) {
      key = newIdempotencyKey();
      keyFor = fingerprint;
    }
    setPending(true);
    setFailure(null);
    setFormError(null);
    try {
      const created = await api.me.silicons.create(body, { idempotencyKey: key });
      props.onCreated(created);
      props.onOpenChange(false);
      reset();
    } catch (raw) {
      const error = ApiError.from(raw);
      const fields = error.fields;
      if (error.code === "id_taken" || error.code === "id_reserved" || error.code === "invalid_id") {
        setFailure({ message: reportFailure(error, "The Silicon was not created"), suggestions: error.suggestions.slice(0, 3) });
      } else if (Object.keys(fields).length) {
        setErrors(fields);
      } else {
        setFormError(reportFailure(error, "The Silicon was not created"));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer open={props.open} onOpenChange={open => { props.onOpenChange(open); }}>
      <DrawerContent
        title="Create a Silicon"
        description="You become its custodian. It signs in with its si:id and an STK that is shown to you once."
        footer={
          // display: contents keeps the drawer footer's layout; the class only restores the buttons' squircle corners.
          <div class={styles.footer}>
            <DrawerClose variant="ghost" disabled={pending()}>Cancel</DrawerClose>
            <Button type="submit" form={formId} loading={pending()}>Create Silicon</Button>
          </div>
        }
      >
        <form id={formId} class={styles.form} onSubmit={submit} novalidate>
          <Input label="Display name" value={name()} onInput={event => onName(event.currentTarget.value)} placeholder="Scout" maxLength={100} error={errors().display_name || null} autocomplete="off" />
          <IdField
            prefix="si:"
            label="Id"
            value={handle()}
            onValueChange={value => { setHandle(value); setHandleEdited(true); setFailure(null); }}
            check={check()}
            error={failure()?.message ?? errors().id ?? null}
            suggestions={failure()?.suggestions}
            description="What people and apps type to find it. 3 to 30 of a to z, 0 to 9, - and _."
          />
          <Combobox label="Timezone" options={options()} value={timezone()} onValueChange={value => setTimezone(value)} description="Its local time. Yours to start with." error={errors().timezone || null} />
          <Input
            label="Webhook URL (optional)"
            type="url"
            inputmode="url"
            placeholder="https://scout.example/hooks/accounts"
            value={webhook()}
            onInput={event => { setWebhook(event.currentTarget.value); setErrors(current => ({ ...current, webhook_url: "" })); }}
            error={errors().webhook_url || null}
            description="Where it hears about its own account (id changes, STK rotations, custodian changes). You get its signing secret once."
            autocomplete="off"
            spellcheck={false}
          />
          <div class={styles.stk}>
            <Checkbox label="Choose its STK yourself" description="Otherwise one is generated (stk- and 12 hex digits) and shown to you once." checked={own()} onChange={value => { setOwn(value); setErrors(current => ({ ...current, stk: "" })); }} />
            <Show when={own()}>
              <Input label="STK" mono value={stk()} onInput={event => { setStk(event.currentTarget.value); setErrors(current => ({ ...current, stk: "" })); }} placeholder="stk-0123456789abcdef" autocomplete="off" spellcheck={false} error={errors().stk || null} description="stk- followed by 8 to 32 hex digits. Silicon Accounts keeps only its hash." />
            </Show>
          </div>
          <Show when={formError()}>
            <Alert tone="danger" title="The Silicon was not created">{formError()}</Alert>
          </Show>
        </form>
      </DrawerContent>
    </Drawer>
  );
}
