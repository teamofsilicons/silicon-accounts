"use client";

/**
 * Personal info (/personal), built to the lead designer's prototype (redesign/prototype-v7.html: personal, .scard,
 * .srow): the page title, then two bordered boxes of rows. Each whole row opens its editor in a dialog: a row is a
 * link to `?edit=<field>`, and the dialog follows the address (closing it drops the parameter, and focus goes back to
 * the row), so an editor can be linked to, as from the palette's "Change your id".
 *
 * - Profile: photo, name, public id (the old one stays reserved for 10 days), date of birth, timezone.
 * - Contact (a Carbon's): every email, then every phone number, the primary one marked when there are several; the
 *   dialog makes one primary, removes one or adds one with a code. A Carbon without a phone gets "Add a phone".
 *
 * A Silicon sees Profile only: it has no emails or phone numbers.
 */
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AtSign, ChevronRight } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Calendar } from "@teamofsilicons/silicon-ui/calendar";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { Input } from "@teamofsilicons/silicon-ui/input";
import { Select } from "@teamofsilicons/silicon-ui/select";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import type { CarbonMe, Me } from "@/lib/api/types";
import { useCarbonPicture } from "@/lib/carbon-avatar";
import { useRegisterCommands } from "@/lib/commands";
import { paths } from "@/lib/navigation";
import { formatDate, formatPhone } from "@/lib/format";
import { useRemovePhoto, useUpdateProfile, useUploadPhoto } from "@/lib/query/account";
import { useMe } from "@/lib/query/session";
import { asCarbon, describeError } from "../parts/common";
import { TimezoneForm } from "../parts/detail-editors";
import { IdChangeForm } from "../parts/id-change-form";
import { PhotoControl } from "../parts/photo-control";
import { useChangeOwnId } from "../parts/queries";
import { ContactList } from "../sign-in-methods/sign-in-methods";
import { AvatarEditor } from "./avatar-editor";
import styles from "./identity.module.css";

const RESERVED_DAYS = 10;

const EDITORS = ["photo", "name", "id", "dob", "timezone", "emails", "phones"] as const;
type Editor = (typeof EDITORS)[number];
const editorOf = (value: string | null): Editor | null => (EDITORS as readonly string[]).includes(value ?? "") ? value as Editor : null;
const editHref = (editor: Editor) => `${paths.personal}?edit=${editor}`;

function validateName(next: string): string | null {
  if (!next) return "Enter a name.";
  if (next.length > 100) return `A name can be at most 100 characters (this one has ${next.length}).`;
  if (/[\u0000-\u001f\u007f]/.test(next)) return "Remove tabs, line breaks and other control characters.";
  return null;
}

export function Identity() {
  const me = useMe();
  const router = useRouter();
  const editing = editorOf(useSearchParams().get("edit"));
  const [reserved, setReserved] = useState<{ id: string; until: number } | null>(null);

  useRegisterCommands(() => [
    { id: "identity.change-id", label: "Change your id", description: "Pick a new id; the old one stays reserved for you for 10 days", group: "Identity", icon: <AtSign size={16} strokeWidth={1.75} />, keywords: ["id", "handle", "username", "rename"], run: () => router.push(editHref("id"), { scroll: false }) },
  ], [router]);

  const account = me.data;
  const carbon = asCarbon(account);
  const picture = useCarbonPicture(account);
  const close = () => router.replace(paths.personal, { scroll: false });

  return (
    <Page>
      <PageHeader title="Personal info" />
      {me.error && !account ? (
        <Alert tone="danger" title="Your account did not load">
          {describeError(me.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
        </Alert>
      ) : !account ? (
        <PageSkeleton />
      ) : (
        <>
          <Box title="Profile">
            <Row label="Photo" edit="photo"><Avatar name={account.display_name} src={picture?.src ?? account.pfp_url} size="md" /></Row>
            <Row label="Name" edit="name">{account.display_name}</Row>
            <Row
              label="Public id"
              edit="id"
              detail={reserved ? <><span className="mono">{reserved.id}</span> stays reserved for you until {formatDate(reserved.until)}.</> : undefined}
            >
              <span className={styles.mono}>{account.id ?? account.uuid}</span>
            </Row>
            <Row label="Date of birth" edit="dob">{account.dob ? formatDate(`${account.dob}T12:00:00Z`) : <span className={styles.muted}>Not added</span>}</Row>
            <Row label="Timezone" edit="timezone">{account.timezone}</Row>
          </Box>
          {carbon ? <ContactBox carbon={carbon} /> : null}
          <Editors me={account} editing={editing} onClose={close} onReserved={setReserved} />
        </>
      )}
    </Page>
  );
}

function ContactBox({ carbon }: { carbon: CarbonMe }) {
  const emails = [...carbon.emails].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  const phones = [...carbon.phones].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  const primary = <Badge size="sm" tone="neutral">Primary</Badge>;
  return (
    <Box title="Contact">
      {emails.map((item, index) => (
        <Row key={item.email} label={index === 0 ? "Email" : ""} edit="emails" end={item.is_primary && emails.length > 1 ? primary : null}>{item.email}</Row>
      ))}
      {phones.length ? phones.map((item, index) => (
        <Row key={item.phone} label={index === 0 ? "Phone" : ""} edit="phones" end={item.is_primary && phones.length > 1 ? primary : null}>{formatPhone(item.phone)}</Row>
      )) : (
        <Row label="Phone" edit="phones"><span className={styles.muted}>Add a phone</span></Row>
      )}
    </Box>
  );
}

/** The prototype's .scard: a bordered box with its title inside, then its rows. */
function Box({ title, children }: { title: string; children: ReactNode }) {
  const id = `personal-${title.toLowerCase()}`;
  return (
    <section data-sq="surface" className={styles.box} aria-labelledby={id}>
      <div className={styles.boxHead}><h2 id={id} className={styles.boxTitle}>{title}</h2></div>
      {children}
    </section>
  );
}

/** The prototype's .srow: the whole row opens its editor (a link to ?edit=…), label, value, chevron. */
function Row({ label, edit, detail, end, children }: { label: string; edit: Editor; detail?: ReactNode; end?: ReactNode; children: ReactNode }) {
  return (
    <Link href={editHref(edit)} replace scroll={false} className={styles.row} data-edit={edit}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>
        {children}
        {detail ? <span className={styles.detail}>{detail}</span> : null}
      </span>
      {end}
      <ChevronRight className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
    </Link>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The editors, one dialog each, with the prototype's words                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

interface EditorsProps {
  me: Me;
  editing: Editor | null;
  onClose: () => void;
  onReserved: (reserved: { id: string; until: number }) => void;
}

function Editors({ me, editing, onClose, onReserved }: EditorsProps) {
  const update = useUpdateProfile();
  const upload = useUploadPhoto();
  const removePhoto = useRemovePhoto();
  const changeId = useChangeOwnId();
  const idInput = useRef<HTMLInputElement>(null);
  const carbon = asCarbon(me);
  const dialog = (editor: Editor) => ({ open: editing === editor, onOpenChange: (next: boolean) => { if (!next) onClose(); } });
  /** Closing hands focus back to the row that opened the editor (the rows open it by address, not as a trigger). */
  const backToRow = (editor: Editor) => (event: Event) => {
    const row = document.querySelector<HTMLElement>(`[data-edit="${editor}"]`);
    if (!row) return;
    event.preventDefault();
    row.focus({ preventScroll: true });
  };

  return (
    <>
      <Dialog {...dialog("photo")}>
        <DialogContent title="Photo" description={carbon ? "Apps show this next to your name. Make your avatar, or use a photo." : "Apps show this next to your name. Upload a PNG, JPEG, WebP or GIF."} onCloseAutoFocus={backToRow("photo")}>
          {carbon ? (editing === "photo" ? <AvatarEditor me={carbon} onDone={onClose} /> : null) : (
            <>
              <div className={styles.photo}>
                <PhotoControl
                  name={me.display_name}
                  src={me.pfp_url}
                  size={96}
                  upload={file => upload.mutateAsync(file)}
                  remove={() => removePhoto.mutateAsync()}
                  audience="Every app this Silicon signs into sees it."
                />
              </div>
              <div className={styles.actions}><Button variant="secondary" onClick={onClose}>Done</Button></div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog {...dialog("name")}>
        <DialogContent title="Name" onCloseAutoFocus={backToRow("name")} description="Shown in every app next to your files and messages. Up to 100 characters.">
          {editing === "name" ? <NameForm value={me.display_name} onSave={display_name => update.mutateAsync({ display_name })} onDone={onClose} /> : null}
        </DialogContent>
      </Dialog>

      <Dialog {...dialog("id")}>
        <DialogContent
          title="Public id"
          onCloseAutoFocus={backToRow("id")}
          description={me.id ? `Your id now is ${me.id}. Others find you by it.` : "Pick the id Carbons and Silicons will type to find you."}
          onOpenAutoFocus={event => {
            event.preventDefault();
            requestAnimationFrame(() => idInput.current?.focus());
          }}
        >
          <IdChangeForm
            prefix={me.kind === "carbon" ? "c:" : "si:"}
            currentId={me.id}
            uuid={me.uuid}
            subject="self"
            inputRef={idInput}
            submit={id => changeId.mutateAsync(id)}
            onChanged={(_, previous) => {
              onClose();
              if (previous) onReserved({ id: previous, until: Date.now() + RESERVED_DAYS * 86_400_000 });
            }}
            onCancel={onClose}
          />
        </DialogContent>
      </Dialog>

      <Dialog {...dialog("dob")}>
        <DialogContent title="Date of birth" onCloseAutoFocus={backToRow("dob")} description="Only apps you allow can see it. Some apps need it to check your age.">
          {editing === "dob" ? <DobCalendarForm value={me.dob} onSave={dob => update.mutateAsync({ dob })} onDone={onClose} /> : null}
        </DialogContent>
      </Dialog>

      <Dialog {...dialog("timezone")}>
        <DialogContent title="Timezone" onCloseAutoFocus={backToRow("timezone")} description="Apps show times to you in this timezone.">
          {editing === "timezone" ? <TimezoneForm value={me.timezone} onSave={timezone => update.mutateAsync({ timezone })} onDone={onClose} autoFocus /> : null}
        </DialogContent>
      </Dialog>

      {carbon ? (
        <>
          <Dialog {...dialog("emails")}>
            <DialogContent title="Email addresses" onCloseAutoFocus={backToRow("emails")} description="Once verified, an email can sign you in with a code. The primary one can't be removed; make another primary first.">
              <ContactList channel="email" carbon={carbon} />
              <div className={styles.actions}><Button variant="secondary" onClick={onClose}>Close</Button></div>
            </DialogContent>
          </Dialog>
          <Dialog {...dialog("phones")}>
            <DialogContent title={carbon.phones.length ? "Phone numbers" : "Add a phone number"} onCloseAutoFocus={backToRow("phones")} description="Once verified, a number can sign you in with a text code. The primary one can't be removed; make another primary first.">
              <ContactList channel="phone" carbon={carbon} />
              <div className={styles.actions}><Button variant="secondary" onClick={onClose}>Close</Button></div>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </>
  );
}

function NameForm({ value, onSave, onDone }: { value: string; onSave: (name: string) => Promise<unknown>; onDone: () => void }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    const problem = validateName(next);
    if (problem) return setError(problem);
    if (next === value) return onDone();
    setPending(true);
    try {
      await onSave(next);
      onDone();
    } catch (raw) {
      setError(describeError(raw));
    } finally {
      setPending(false);
    }
  };
  return (
    <form className={styles.form} onSubmit={event => void submit(event)} noValidate>
      <Input label="Name" value={draft} maxLength={100} autoComplete="off" autoFocus onChange={event => { setDraft(event.target.value); setError(null); }} error={error ?? undefined} />
      <div className={styles.actions}>
        <Button type="button" variant="secondary" onClick={onDone} disabled={pending}>Cancel</Button>
        <Button type="submit" loading={pending} disabled={!draft.trim()}>Save</Button>
      </div>
    </form>
  );
}

/** "YYYY-MM-DD" for a local date. */
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const fromDayKey = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
};
/** The API takes dates after 1900-01-01. */
const MIN_DOB = new Date(1900, 0, 2);

/**
 * The date of birth editor: a year list, then Silicon UI's Calendar laid out in the dialog, Cancel and Save. The
 * prototype draws one date field; Silicon UI's DatePicker is that field, but inside a dialog its calendar is clipped
 * (a Silicon UI bug, being fixed: prototype-differences.md). Once it ships, this becomes a DatePicker.
 */
function DobCalendarForm({ value, onSave, onDone }: { value: string; onSave: (dob: string) => Promise<unknown>; onDone: () => void }) {
  const [max] = useState(() => {
    const yesterday = new Date();
    yesterday.setHours(0, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  });
  const [draft, setDraft] = useState<Date | undefined>(() => fromDayKey(value));
  const [month, setMonth] = useState<Date>(() => draft ?? max);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const years = useMemo(() => Array.from({ length: max.getFullYear() - 1899 }, (_, index) => {
    const year = String(max.getFullYear() - index);
    return { value: year, label: year };
  }), [max]);
  const changed = !!draft && dayKey(draft) !== value;

  const pickYear = (raw: string) => {
    const year = Number(raw);
    if (!Number.isFinite(year)) return;
    const base = draft ?? month;
    const last = new Date(year, base.getMonth() + 1, 0).getDate();
    let next = new Date(year, base.getMonth(), Math.min(base.getDate(), last));
    if (next > max) next = max;
    if (next < MIN_DOB) next = MIN_DOB;
    if (draft) setDraft(next);
    setMonth(next);
    setError(null);
  };
  const save = async () => {
    if (!draft) return setError("Pick a date.");
    if (!changed) return onDone();
    setPending(true);
    try {
      await onSave(dayKey(draft));
      onDone();
    } catch (raw) {
      setError(describeError(raw));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className={styles.form}>
      <Select label="Year" options={years} value={String(month.getFullYear())} onValueChange={pickYear} />
      <Calendar value={draft} onChange={date => { setDraft(date); setError(null); }} month={month} onMonthChange={setMonth} minDate={MIN_DOB} maxDate={max} />
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <Button type="button" variant="secondary" onClick={onDone} disabled={pending}>Cancel</Button>
        <Button type="button" loading={pending} disabled={!changed} onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Loading                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

function PageSkeleton() {
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label="Loading your personal info">
      <SkeletonBlock width="100%" height="300px" radius="var(--radius-container)" />
      <SkeletonBlock width="100%" height="120px" radius="var(--radius-container)" index={1} />
    </div>
  );
}
