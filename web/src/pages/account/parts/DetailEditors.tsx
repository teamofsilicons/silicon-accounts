/**
 * Editors for one detail at a time: the timezone (a searchable list of every IANA zone), the date of birth (a calendar
 * with a year grid) and a Silicon's photo by link. Each saves with one press; a failure stays in the editor with the
 * server's reason.
 *
 * On a page they open in a popover from a small "Change" button (TimezoneEditor, DobEditor). Inside a modal drawer they
 * are shown inline instead (TimezoneForm, PhotoUrlForm): a popover opened from a modal dialog is portaled outside it,
 * where the dialog's "hide everything outside me" (Kobalte) sets aria-hidden on it, so screen readers could not use it.
 */
import { Match, Show, Switch, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, type JSX } from "solid-js";
import { Avatar } from "../../../arc/avatar/avatar";
import { Button } from "../../../arc/button/button";
import { addDays, dateKey, fromDateKey, startOfDay } from "../../../arc/calendar/calendar";
import { Combobox } from "../../../arc/combobox/combobox";
import { DatePicker } from "../../../arc/date-picker/date-picker";
import { Input } from "../../../arc/input/input";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "../../../arc/popover/popover";
import { useSquircle } from "../../../arc/lib/squircle";
import { timezoneOptions } from "../../../lib/timezones";
import { reportFailure } from "./common";
import styles from "./editors.module.css";

/** The small "Change" trigger's look, for inline editors that open below their row. */
export const editorTriggerClass = styles.trigger;

interface EditorShellProps {
  title: string;
  description: JSX.Element;
  /** Visible trigger text, for example "Change". */
  trigger: string;
  /** Accessible name of the trigger, for example "Change your timezone". */
  triggerLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: JSX.Element;
}

function EditorShell(props: EditorShellProps) {
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange} placement="bottom-start" gutter={8}>
      <PopoverTrigger ref={(el: HTMLElement) => useSquircle(el)} class={styles.trigger} aria-label={props.triggerLabel}>{props.trigger}</PopoverTrigger>
      <PopoverContent class={styles.popover}>
        <PopoverTitle class={styles.title}>{props.title}</PopoverTitle>
        <PopoverDescription class={styles.description}>{props.description}</PopoverDescription>
        {props.children}
      </PopoverContent>
    </Popover>
  );
}

/** An inline editor's frame: a heading, one line of context, and the form. */
export function InlineEditor(props: { title: string; description: JSX.Element; children: JSX.Element }) {
  const titleId = `editor-${createUniqueId()}`;
  return (
    <section ref={el => useSquircle(el)} class={styles.inline} aria-labelledby={titleId}>
      <h4 id={titleId} class={styles.title}>{props.title}</h4>
      <p class={styles.description}>{props.description}</p>
      {props.children}
    </section>
  );
}

/* --------------------------------------------------- timezone --------------------------------------------------- */

export interface TimezoneFormProps {
  value: string;
  onSave: (timezone: string) => Promise<unknown>;
  /** Saved, or cancelled. */
  onDone: () => void;
  autofocus?: boolean;
}

/** The timezone search and its actions (in a popover or inline). */
export function TimezoneForm(props: TimezoneFormProps) {
  const [draft, setDraft] = createSignal(props.value);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const options = createMemo(() => timezoneOptions(new Date(), [props.value]));
  let root: HTMLDivElement | undefined;
  onMount(() => { if (props.autofocus) queueMicrotask(() => root?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true })); });
  const save = async () => {
    if (!draft() || draft() === props.value) return props.onDone();
    setPending(true);
    setError(null);
    try {
      await props.onSave(draft());
      props.onDone();
    } catch (raw) {
      setError(reportFailure(raw, "The timezone did not change"));
    } finally {
      setPending(false);
    }
  };
  return (
    <div ref={root} class={styles.form}>
      <Combobox label="Timezone" hideLabel options={options()} value={draft()} onValueChange={value => { setDraft(value); setError(null); }} placeholder="Search a city or an offset" error={error()} />
      <div class={styles.actions}>
        <Button variant="ghost" size="sm" onClick={() => props.onDone()} disabled={pending()}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} loading={pending()} disabled={!draft() || draft() === props.value}>Save timezone</Button>
      </div>
    </div>
  );
}

/** What the timezone sets, for the editor's line of context. */
export function timezoneDescription(owner = "your"): string {
  return owner === "your" ? "Sets your local time here, and apps you let see your timezone get it." : `Sets ${owner}'s local time, and apps it lets see its timezone get it.`;
}

export interface TimezoneEditorProps {
  value: string;
  onSave: (timezone: string) => Promise<unknown>;
  /** Whose timezone, for the copy: "your" or a Silicon's id. */
  owner?: string;
}

/** The timezone in a popover, for pages (not for modal drawers: see the module comment). */
export function TimezoneEditor(props: TimezoneEditorProps) {
  const [open, setOpen] = createSignal(false);
  const owner = () => props.owner ?? "your";
  return (
    <EditorShell
      title="Timezone"
      description={timezoneDescription(owner())}
      trigger="Change"
      triggerLabel={owner() === "your" ? "Change your timezone" : `Change ${owner()}'s timezone`}
      open={open()}
      onOpenChange={setOpen}
    >
      {/* The panel's content is created each time it opens, so the form starts from the current timezone. */}
      <TimezoneForm value={props.value} onSave={props.onSave} onDone={() => setOpen(false)} />
    </EditorShell>
  );
}

/* ------------------------------------------------- date of birth ------------------------------------------------- */

export interface DobEditorProps {
  value: string;
  onSave: (dob: string) => Promise<unknown>;
}

/** Earliest and latest dates the API accepts: after 1900-01-01 and before today. */
const MIN_DOB = new Date(1900, 0, 2);
const maxDob = () => addDays(startOfDay(new Date()), -1);

export function DobEditor(props: DobEditorProps) {
  const [open, setOpen] = createSignal(false);
  const [draft, setDraft] = createSignal<Date | undefined>(fromDateKey(props.value));
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const changed = () => !!draft() && dateKey(draft() as Date) !== props.value;
  const onOpenChange = (next: boolean) => {
    if (next) {
      setDraft(fromDateKey(props.value));
      setError(null);
    }
    setOpen(next);
  };
  const save = async () => {
    const date = draft();
    if (!date || !changed()) return setOpen(false);
    setPending(true);
    setError(null);
    try {
      await props.onSave(dateKey(date));
      setOpen(false);
    } catch (raw) {
      setError(reportFailure(raw, "Your date of birth did not change"));
    } finally {
      setPending(false);
    }
  };
  return (
    <EditorShell
      title="Date of birth"
      description="Apps you let see your date of birth get it. Pick the year from the calendar's title."
      trigger="Change"
      triggerLabel="Change your date of birth"
      open={open()}
      onOpenChange={onOpenChange}
    >
      <DatePicker label="Date of birth" value={draft()} onChange={date => { setDraft(date); setError(null); }} minDate={MIN_DOB} maxDate={maxDob()} yearPicker required error={error()} />
      <Show when={draft() && !changed() && !error()}>
        <span class={styles.hint}>Pick a different date to save it.</span>
      </Show>
      <div class={styles.actions}>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending()}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} loading={pending()} disabled={!changed()}>Save date</Button>
      </div>
    </EditorShell>
  );
}

/* ----------------------------------------------- photo from a link ----------------------------------------------- */

/** The longest photo link the service stores (core normalize::MAX_URL_LEN). */
const MAX_PHOTO_URL = 2048;

/**
 * Why `raw` cannot be a profile photo link, before sending it; null when it can. The service takes an https link, or a
 * photo it serves itself (`{its origin}/v1/photos/{id}`, which is http in development).
 */
export function photoUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Paste the https link of an image, for example https://example.com/scout.png.";
  if (value.length > MAX_PHOTO_URL) return `A photo link can be at most ${MAX_PHOTO_URL} characters (this one has ${value.length}).`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `“${value}” is not a full link. Start it with https://, for example https://example.com/scout.png.`;
  }
  const ownPhoto = url.origin === location.origin && url.pathname.startsWith("/v1/photos/");
  if (url.protocol !== "https:" && !ownPhoto) return `A photo link must start with https:// (this one starts with ${url.protocol}//).`;
  if (url.username || url.password) return "Remove the user name and password from the link; photo links cannot carry credentials.";
  return null;
}

/** What a photo link does, for the editor's line of context. */
export function photoUrlDescription(owner: string): JSX.Element {
  return <>An https link to an image. Every app {owner} signs into sees it. To upload a file instead, {owner} can run <code class={styles.code}>accounts profile set --photo &lt;file&gt;</code>.</>;
}

export interface PhotoUrlFormProps {
  /** The photo now (null for the default photo: none of its own). */
  value: string | null;
  /** Display name, for the preview's initials. */
  name: string;
  onSave: (url: string) => Promise<unknown>;
  /** Saved, or cancelled. */
  onDone: () => void;
  autofocus?: boolean;
}

/** A Silicon's photo from a link (PATCH /v1/me/silicons/{uuid} pfp_url), with a preview that says whether it loads. */
export function PhotoUrlForm(props: PhotoUrlFormProps) {
  const [draft, setDraft] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<{ url: string; state: "loading" | "ok" | "failed" } | null>(null);
  let input: HTMLInputElement | undefined;
  let timer = 0;
  onMount(() => { if (props.autofocus) queueMicrotask(() => input?.focus({ preventScroll: true })); });
  onCleanup(() => window.clearTimeout(timer));
  // A preview once typing pauses: one image request per pause, not one per keystroke.
  createEffect(on(draft, value => {
    window.clearTimeout(timer);
    const url = value.trim();
    if (photoUrlProblem(url)) return setPreview(null);
    timer = window.setTimeout(() => {
      setPreview({ url, state: "loading" });
      const image = new Image();
      image.referrerPolicy = "no-referrer";
      image.onload = () => setPreview(current => (current?.url === url ? { url, state: "ok" } : current));
      image.onerror = () => setPreview(current => (current?.url === url ? { url, state: "failed" } : current));
      image.src = url;
    }, 400);
  }, { defer: true }));
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const url = draft().trim();
    const problem = photoUrlProblem(url);
    if (problem) return setError(problem);
    setPending(true);
    setError(null);
    try {
      await props.onSave(url);
      props.onDone();
    } catch (raw) {
      setError(reportFailure(raw, "The photo did not change"));
    } finally {
      setPending(false);
    }
  };
  return (
    <form class={styles.form} onSubmit={save} novalidate>
      <Input ref={el => (input = el)} label="Image link" type="url" inputmode="url" placeholder="https://example.com/scout.png" value={draft()} onInput={event => { setDraft(event.currentTarget.value); setError(null); }} error={error()} autocomplete="off" spellcheck={false} />
      <Show when={preview()}>
        {current => (
          <div class={styles.preview} aria-live="polite">
            <Avatar name={props.name} src={current().state === "failed" ? null : current().url} size="md" kind="silicon" />
            <span class={styles.previewText} data-tone={current().state === "failed" ? "warning" : undefined}>
              <Switch>
                <Match when={current().state === "loading"}>Loading the image…</Match>
                <Match when={current().state === "ok"}>This is how it will look.</Match>
                <Match when={current().state === "failed"}>That link did not load as an image. Check that it points straight at an image file; apps would show the same broken photo.</Match>
              </Switch>
            </span>
          </div>
        )}
      </Show>
      <div class={styles.actions}>
        <Button type="button" variant="ghost" size="sm" onClick={() => props.onDone()} disabled={pending()}>Cancel</Button>
        <Button type="submit" size="sm" loading={pending()} disabled={!draft().trim() || draft().trim() === props.value}>Save photo</Button>
      </div>
    </form>
  );
}
