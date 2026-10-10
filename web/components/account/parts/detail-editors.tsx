"use client";

/**
 * Editors for one detail at a time: the timezone (a searchable list of every IANA zone), the date of birth (the year,
 * then the day in a calendar) and a Silicon's photo by link. Each saves with one press; a failure stays in the editor
 * with the server's reason (the save hooks also toast it).
 *
 * On a page they open in a popover from a small "Change" button (TimezoneEditor, DobEditor). Inside a modal drawer they
 * are shown inline instead (InlineEditor with TimezoneForm or PhotoUrlForm): a phone-wide drawer has no room beside the
 * row, and a layer opened from a modal layer is easy to lose. Escape in an open timezone list or calendar closes just
 * that list or calendar; the next Escape closes the popover (components/silicon-ui/lib/escape.ts).
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { Button } from "@/components/silicon-ui/button/button";
import { Combobox } from "@/components/silicon-ui/combobox/combobox";
import { DatePicker } from "@/components/silicon-ui/date-picker/date-picker";
import { Input } from "@/components/silicon-ui/input/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/silicon-ui/popover/popover";
import { Select } from "@/components/silicon-ui/select/select";
import { timezoneOptions } from "@/lib/timezones";
import { describeError } from "./common";
import partStyles from "./parts.module.css";
import styles from "./editors.module.css";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Frames                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

interface EditorShellProps {
  title: string;
  description: ReactNode;
  /** Visible trigger text, for example "Change". */
  trigger: string;
  /** Accessible name of the trigger, for example "Change your timezone". */
  triggerLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

function EditorShell({ title, description, trigger, triggerLabel, open, onOpenChange, children }: EditorShellProps) {
  const titleId = useId();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger data-sq="surface" className={partStyles.textAction} aria-label={triggerLabel}>{trigger}</PopoverTrigger>
      <PopoverContent
        className={styles.popover}
        side="bottom"
        align="start"
        sideOffset={8}
        aria-labelledby={titleId}
      >
        <p id={titleId} className={styles.title}>{title}</p>
        <p className={styles.description}>{description}</p>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** An inline editor's frame: a heading, one line of context, and the form. */
export function InlineEditor({ id, title, description, autoFocus, children }: { id?: string; title: string; description: ReactNode; autoFocus?: boolean; children: ReactNode }) {
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  // Focus moves to the editor (it is announced by its heading); Tab moves into its fields.
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => root.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  return (
    <section ref={root} id={id} data-sq="surface" className={styles.inline} aria-labelledby={titleId} tabIndex={-1}>
      <h4 id={titleId} className={styles.title}>{title}</h4>
      <p className={styles.description}>{description}</p>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Timezone                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface TimezoneFormProps {
  value: string;
  onSave: (timezone: string) => Promise<unknown>;
  /** Saved, or cancelled. */
  onDone: () => void;
  autoFocus?: boolean;
}

/** The timezone search and its actions (in a popover or inline). */
export function TimezoneForm({ value, onSave, onDone, autoFocus }: TimezoneFormProps) {
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => timezoneOptions(undefined, [value]), [value]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  const save = async () => {
    if (!draft || draft === value) return onDone();
    setPending(true);
    setError(null);
    try {
      await onSave(draft);
      onDone();
    } catch (raw) {
      setError(describeError(raw));
    } finally {
      setPending(false);
    }
  };
  return (
    <div ref={root} className={styles.form}>
      <Combobox label="Timezone" options={options} value={draft} onValueChange={next => { setDraft(next); setError(null); }} placeholder="Search a city or an offset" />
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={pending}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} loading={pending} disabled={!draft || draft === value}>Save timezone</Button>
      </div>
    </div>
  );
}

/** What the timezone sets, for the editor's line of context. */
export function timezoneDescription(owner = "your"): string {
  return owner === "your" ? "Sets your local time here, and apps you let see your timezone get it." : `Sets ${owner}'s local time, and apps it lets see its timezone get it.`;
}

/** The timezone in a popover, for pages (inside a modal drawer use InlineEditor + TimezoneForm). */
export function TimezoneEditor({ value, onSave, owner = "your" }: { value: string; onSave: (timezone: string) => Promise<unknown>; owner?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <EditorShell
      title="Timezone"
      description={timezoneDescription(owner)}
      trigger="Change"
      triggerLabel={owner === "your" ? "Change your timezone" : `Change ${owner}'s timezone`}
      open={open}
      onOpenChange={setOpen}
    >
      {/* The panel's content mounts each time it opens, so the form starts from the current timezone. */}
      <TimezoneForm value={value} onSave={onSave} onDone={() => setOpen(false)} />
    </EditorShell>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Date of birth                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** "1998-03-14" → a local Date at midnight; undefined for anything else. */
function fromDateKey(value: string | null | undefined): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** A local Date → "YYYY-MM-DD". */
function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The same day in another year (February 29 becomes the 28th in a common year). */
function withYear(date: Date, year: number): Date {
  const last = new Date(year, date.getMonth() + 1, 0).getDate();
  return new Date(year, date.getMonth(), Math.min(date.getDate(), last));
}

/** The API accepts dates after 1900-01-01 and before today. */
const MIN_DOB = new Date(1900, 0, 2);

function DobForm({ value, onSave, onDone }: { value: string; onSave: (dob: string) => Promise<unknown>; onDone: () => void }) {
  const [bounds] = useState(() => {
    const today = new Date();
    return { max: new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1), year: today.getFullYear() };
  });
  const [draft, setDraft] = useState<Date | undefined>(() => fromDateKey(value));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const years = useMemo(() => Array.from({ length: bounds.year - 1900 }, (_, index) => {
    const year = String(bounds.year - 1 - index);
    return { value: year, label: year };
  }), [bounds.year]);
  const changed = !!draft && dateKey(draft) !== value;
  const save = async () => {
    if (!draft || !changed) return onDone();
    setPending(true);
    setError(null);
    try {
      await onSave(dateKey(draft));
      onDone();
    } catch (raw) {
      setError(describeError(raw));
    } finally {
      setPending(false);
    }
  };
  const pickYear = (raw: string) => {
    const year = Number(raw);
    if (!Number.isFinite(year)) return;
    let next = withYear(draft ?? new Date(year, 0, 1), year);
    if (next > bounds.max) next = bounds.max;
    if (next < MIN_DOB) next = MIN_DOB;
    setDraft(next);
    setError(null);
  };
  return (
    <div className={styles.form}>
      <div className={styles.dobRow}>
        <Select label="Year" options={years} value={draft ? String(draft.getFullYear()) : ""} onValueChange={pickYear} placeholder="Year" />
        <DatePicker label="Day" value={draft} onChange={date => { setDraft(date); setError(null); }} minDate={MIN_DOB} maxDate={bounds.max} />
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : draft && !changed ? <span className={styles.hint}>Pick a different date to save it.</span> : null}
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={pending}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} loading={pending} disabled={!changed}>Save date</Button>
      </div>
    </div>
  );
}

/** Your date of birth in a popover: the year from a list, then the day in the calendar it opens on. */
export function DobEditor({ value, onSave }: { value: string; onSave: (dob: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <EditorShell
      title="Date of birth"
      description="Apps you let see your date of birth get it. Pick the year first, then the day."
      trigger="Change"
      triggerLabel="Change your date of birth"
      open={open}
      onOpenChange={setOpen}
    >
      <DobForm value={value} onSave={onSave} onDone={() => setOpen(false)} />
    </EditorShell>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A photo from a link                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

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
  const ownPhoto = typeof window !== "undefined" && url.origin === window.location.origin && url.pathname.startsWith("/v1/photos/");
  if (url.protocol !== "https:" && !ownPhoto) return `A photo link must start with https:// (this one starts with ${url.protocol}//).`;
  if (url.username || url.password) return "Remove the name and password before the @ from the link; photo links cannot carry credentials.";
  return null;
}

/** What a photo link does, for the editor's line of context. */
export function photoUrlDescription(owner: string): ReactNode {
  return <>An https link to an image. Every app {owner} signs into sees it. To use a file instead, choose <strong>Upload a photo</strong>.</>;
}

export interface PhotoUrlFormProps {
  /** The photo now (null for the default photo: none of its own). */
  value: string | null;
  /** Display name, for the preview's initials. */
  name: string;
  onSave: (url: string) => Promise<unknown>;
  /** Saved, or cancelled. */
  onDone: () => void;
  autoFocus?: boolean;
}

type Probe = { url: string; state: "loading" | "ok" | "failed" };

/** A Silicon's photo from a link (PATCH /v1/me/silicons/{uuid} pfp_url), with a preview that says whether it loads. */
export function PhotoUrlForm({ value, name, onSave, onDone, autoFocus }: PhotoUrlFormProps) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  // A preview once typing pauses: one image request per pause, not one per keystroke.
  const url = draft.trim();
  const valid = !!url && !photoUrlProblem(url);
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      setProbe({ url, state: "loading" });
      const image = new Image();
      image.referrerPolicy = "no-referrer";
      image.onload = () => { if (alive) setProbe(current => (current?.url === url ? { url, state: "ok" } : current)); };
      image.onerror = () => { if (alive) setProbe(current => (current?.url === url ? { url, state: "failed" } : current)); };
      image.src = url;
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [url, valid]);
  const shown = valid && probe?.url === url ? probe : null;
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = photoUrlProblem(url);
    if (problem) return setError(problem);
    setPending(true);
    setError(null);
    try {
      await onSave(url);
      onDone();
    } catch (raw) {
      setError(describeError(raw));
    } finally {
      setPending(false);
    }
  };
  return (
    <form className={styles.form} onSubmit={save} noValidate>
      <Input ref={input} label="Image link" type="url" inputMode="url" placeholder="https://example.com/scout.png" value={draft} onChange={event => { setDraft(event.target.value); setError(null); }} error={error ?? undefined} autoComplete="off" spellCheck={false} />
      {shown ? (
        <div className={styles.preview} aria-live="polite">
          <Avatar name={name} src={shown.state === "failed" ? undefined : shown.url} size="md" />
          <span className={styles.previewText} data-tone={shown.state === "failed" ? "warning" : undefined}>
            {shown.state === "loading" ? "Loading the image…"
              : shown.state === "ok" ? "This is how it will look."
                : "That link did not load as an image. Check that it points straight at an image file; apps would show the same broken photo."}
          </span>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={pending}>Cancel</Button>
        <Button type="submit" size="sm" loading={pending} disabled={!url || url === value}>Save photo</Button>
      </div>
    </form>
  );
}
