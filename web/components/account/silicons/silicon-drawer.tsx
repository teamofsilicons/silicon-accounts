"use client";

/**
 * One Silicon, as its custodian manages it (a drawer beside the Silicons page): its details, photo and id, its STK
 * (rotate it by holding; the new one is shown once), its webhook (the signing secret is shown once each time it is set),
 * handing it to another Carbon (the card slides toward the recipient; they have 14 days to accept), and deleting it.
 *
 * The drawer is modal, so focus never falls out of it: whenever a control replaces itself (a form becoming a waiting
 * card, a "Removed" button folding away, a stored secret closing), focus moves to what took its place. Escape closes
 * the drawer, except while a control inside has something of its own to close first (the timezone list, a name being
 * edited, a confirm question): Arc's layers handle that themselves (components/arc/lib/escape.ts).
 */
import { useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { animate } from "motion/react";
import { ArrowRight, ImageUp, LoaderCircle, Mail, RefreshCw, Trash2 } from "lucide-react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Checkbox } from "@/components/arc/checkbox/checkbox";
import { ConfirmMorph } from "@/components/arc/confirm-morph/confirm-morph";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { Drawer, DrawerContent } from "@/components/arc/drawer/drawer";
import { HoldToConfirm } from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { InlineEdit } from "@/components/arc/inline-edit/inline-edit";
import { Input } from "@/components/arc/input/input";
import { TextMorph } from "@/components/arc/text-morph/text-morph";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import type { AccountSummary, CarbonMe, ManagedSilicon } from "@/lib/api/types";
import { formatDate, formatRelative } from "@/lib/format";
import { useUpdateSilicon, useUploadSiliconPhoto } from "@/lib/query/silicons";
import { timezoneLabel, utcOffset } from "@/lib/timezones";
import { describeError, isDefaultPhoto, msUntil, PHOTO_ACCEPT, photoProblem, personLabel, reasonError, spanText, stkRotatedAt } from "../parts/common";
import { InlineEditor, PhotoUrlForm, photoUrlDescription, timezoneDescription, TimezoneForm } from "../parts/detail-editors";
import { FitPrompt } from "../parts/fit-prompt";
import { handFocus } from "../parts/focus";
import { HeightFrame } from "../parts/height-frame";
import { IdChangeForm } from "../parts/id-change-form";
import { useCancelTransferSettled, useChangeSiliconIdInForm, useDeleteSiliconSettled, useRemoveSiliconWebhookSettled, useRotateStkOnce, useSetSiliconWebhookOnce, useSiliconDefaultPhoto, useStartTransfer } from "../parts/queries";
import { type NewReveal, type Reveal } from "../parts/reveals";
import { SecretReveal } from "../parts/secret-reveal";
import { normalizeStk, stkProblem, stkSecret } from "../parts/stk";
import partStyles from "../parts/parts.module.css";
import styles from "./silicon-drawer.module.css";

export interface SiliconDrawerProps {
  silicon: ManagedSilicon | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  me: CarbonMe;
  now: number;
  /** Secrets waiting to be stored (only this Silicon's show here). */
  reveals: Reveal[];
  onReveal: (reveal: NewReveal) => void;
  onRevealDone: (id: string) => void;
  /** The Silicon was deleted and the drawer has closed: remove its tile. */
  onDeleted: (uuid: string) => void;
  /**
   * Where keyboard focus goes back to when the drawer closes: the Silicon's tile. Radix returns focus only to a
   * Dialog.Trigger, and the tiles open the drawer without one, so focus would otherwise drop to the page body.
   */
  focusOnClose?: (uuid: string) => HTMLElement | null | undefined;
}

/** How long a "Removed" / "Cancelled" / "Deleted" result shows in place before the content behind it changes. */
const RESULT_MS = 700;
/** Ids longer than this wrap in the drawer's header instead of morphing on one line. */
const LONG_ID = 18;
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function SiliconDrawer({ silicon, open, onOpenChange, focusOnClose, ...rest }: SiliconDrawerProps) {
  const returnFocus = (event: Event) => {
    const target = silicon ? focusOnClose?.(silicon.uuid) : null;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  };
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      {silicon ? (
        <DrawerContent className={styles.panel} title={silicon.display_name} description={`${silicon.id ?? "No id"} · uuid ${silicon.uuid}`} onCloseAutoFocus={returnFocus}>
          <Body key={silicon.uuid} silicon={silicon} onClose={() => onOpenChange(false)} {...rest} />
        </DrawerContent>
      ) : null}
    </Drawer>
  );
}

type BodyProps = Omit<SiliconDrawerProps, "silicon" | "open" | "onOpenChange" | "focusOnClose"> & { silicon: ManagedSilicon; onClose: () => void };
type Origin = NonNullable<Reveal["origin"]>;

function Body(props: BodyProps) {
  const { silicon, reveals, onRevealDone } = props;
  const body = useRef<HTMLDivElement>(null);
  const headings = useRef<Partial<Record<Origin, HTMLHeadingElement | null>>>({});
  const id = silicon.id ?? silicon.uuid;
  const mine = reveals.filter(item => item.silicon === silicon.uuid);
  /** "I've stored it": the next secret waiting here, else the block the secret came from, else the drawer itself. */
  const stored = (reveal: Reveal) => {
    onRevealDone(reveal.id);
    handFocus(body.current, () => body.current?.querySelector<HTMLElement>("[data-reveals] [data-reveal] h2")
      ?? (reveal.origin ? headings.current[reveal.origin] : undefined)
      ?? body.current?.closest<HTMLElement>("[role=dialog]"));
  };
  return (
    <div ref={body} className={styles.body}>
      {mine.length ? (
        <div className={styles.reveals} data-reveals="">
          {mine.map(reveal => <SecretReveal key={reveal.id} revealId={reveal.id} title={reveal.title} description={reveal.description} secrets={reveal.secrets} onDone={() => stored(reveal)} focusOnMount />)}
        </div>
      ) : null}
      <Profile {...props} />
      <Block title="STK" headingRef={el => { headings.current.stk = el; }} description={`The password ${id} signs in with. Rotating it ends the old one at once and signs ${id} out of every app.`}>
        <StkBlock {...props} />
      </Block>
      <Block title="Webhook" headingRef={el => { headings.current.webhook = el; }} description={`Where Silicon Accounts tells ${id} about its own account: id and detail changes, STK rotations and custodian changes. Every event is signed.`}>
        <WebhookBlock {...props} />
      </Block>
      <Block title="Custodian" description={`You are ${id}'s custodian. To hand it to another Carbon, name them; they have 14 days to accept, and until then nothing changes.`}>
        <TransferBlock {...props} />
      </Block>
      <Block title="Delete this Silicon" danger description={`Its account ends: it is signed out everywhere, every app it signed into is told, and ${id} stays reserved for 10 days. This cannot be undone.`}>
        <DeleteBlock {...props} />
      </Block>
    </div>
  );
}

function Block({ title, description, children, danger, headingRef }: { title: string; description: string; children: ReactNode; danger?: boolean; headingRef?: Ref<HTMLHeadingElement> }) {
  return (
    <section className={styles.block} data-danger={danger || undefined}>
      <div className={styles.blockHead}>
        {/* Focusable by script only: focus lands here after a secret from this block is stored. */}
        <h3 ref={headingRef} className={styles.blockTitle} tabIndex={-1}>{title}</h3>
        <p className={styles.blockText}>{description}</p>
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Profile                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

type Editing = "timezone" | "photo" | null;

function statusOf(silicon: ManagedSilicon): { tone: "warning" | "info" | "success"; text: string } {
  if (silicon.status === "pending_custodian") return { tone: "warning", text: "Waiting for a custodian" };
  if (silicon.pending_transfer) return { tone: "info", text: "Transfer pending" };
  return { tone: "success", text: "Active" };
}

function Profile({ silicon }: BodyProps) {
  const [changingId, setChangingId] = useState(false);
  // One detail editor at a time, inline below the facts: a phone-wide drawer has no room beside the row, and a layer
  // opened from a modal layer is easy to lose.
  const [editing, setEditing] = useState<Editing>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const profile = useRef<HTMLElement>(null);
  const idScope = useRef<HTMLDivElement>(null);
  const changeIdButton = useRef<HTMLButtonElement>(null);
  const photoTrigger = useRef<HTMLButtonElement>(null);
  const uploadTrigger = useRef<HTMLButtonElement>(null);
  const timezoneTrigger = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const update = useUpdateSilicon();
  const upload = useUploadSiliconPhoto();
  const defaultPhoto = useSiliconDefaultPhoto();
  const changeId = useChangeSiliconIdInForm();
  const editorId = `silicon-editor-${silicon.uuid}`;
  const id = silicon.id ?? silicon.uuid;
  const status = statusOf(silicon);
  const ownPhoto = isDefaultPhoto(silicon.pfp_url) ? null : silicon.pfp_url;

  const openEditor = (which: Exclude<Editing, null>) => setEditing(current => (current === which ? null : which));
  const closeEditor = () => {
    const which = editing;
    setEditing(null);
    handFocus(profile.current, () => (which === "photo" ? photoTrigger.current : timezoneTrigger.current));
  };
  const closeIdForm = () => {
    setChangingId(false);
    handFocus(idScope.current, () => changeIdButton.current);
  };
  const save = (patch: { display_name?: string; timezone?: string; pfp_url?: string | null }) => update.mutateAsync({ uuid: silicon.uuid, patch });

  const startUpload = async (file: File) => {
    const problem = photoProblem(file);
    if (problem) {
      setPhotoError(problem);
      return;
    }
    setPhotoError(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    setUploading(true);
    try {
      await upload.mutateAsync({ uuid: silicon.uuid, file });
    } catch (raw) {
      setPhotoError(describeError(raw));
    } finally {
      setUploading(false);
      setPreview(null);
      URL.revokeObjectURL(url);
      handFocus(profile.current, () => uploadTrigger.current);
    }
  };

  return (
    <section ref={profile} className={styles.profile} aria-label="Profile">
      <div className={styles.identity}>
        <span className={styles.photo} data-busy={uploading || undefined}>
          <Avatar name={silicon.display_name} src={preview ?? silicon.pfp_url ?? undefined} size="xl" />
          {uploading ? <span className={styles.busy} aria-hidden="true"><LoaderCircle className={styles.spinner} size={22} strokeWidth={1.75} /></span> : null}
        </span>
        <div className={styles.identityText}>
          <InlineEdit
            className={styles.name}
            label="Display name"
            value={silicon.display_name}
            onSave={async next => {
              try {
                await save({ display_name: next });
              } catch (error) {
                throw reasonError(error);
              }
            }}
            validate={next => (!next ? "Enter a display name." : next.length > 100 ? `A display name can be at most 100 characters (this one has ${next.length}).` : null)}
          />
          <div className={styles.idLine}>
            {/* A short id morphs when it changes; a long one wraps (the drawer is narrow on phones) rather than being cut. */}
            {(silicon.id?.length ?? 0) > LONG_ID
              ? <span className={styles.idWrap}>{silicon.id}</span>
              : <span className={styles.idText} title={silicon.id ?? undefined}><TextMorph className={styles.idMorph}>{silicon.id ?? "No id"}</TextMorph></span>}
            <CopyButton value={silicon.id ?? ""} label={`Copy ${silicon.id ?? "id"}`} iconOnly variant="plain" disabled={!silicon.id} />
            <Badge size="sm" tone={status.tone}>{status.text}</Badge>
          </div>
        </div>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>uuid</dt>
          <dd><span className={styles.mono}>{silicon.uuid}</span><CopyButton value={silicon.uuid} label="Copy uuid" iconOnly variant="plain" /></dd>
        </div>
        <div>
          <dt>Timezone</dt>
          <dd>
            <span>{timezoneLabel(silicon.timezone)} · UTC{utcOffset(silicon.timezone)}</span>
            <button ref={timezoneTrigger} data-sq="surface" type="button" className={partStyles.textAction} aria-label={`Change ${id}'s timezone`} aria-expanded={editing === "timezone"} aria-controls={editorId} onClick={() => openEditor("timezone")}>Change</button>
          </dd>
        </div>
        <div>
          <dt>Born</dt>
          <dd><span>{formatDate(silicon.dob)}, the day its account was created</span></dd>
        </div>
        <div>
          <dt>Photo</dt>
          <dd className={styles.photoValue}>
            <span>{ownPhoto ? "A photo of its own" : "The default photo"}</span>
            <span className={styles.photoActions}>
            <button ref={uploadTrigger} data-sq="surface" type="button" className={partStyles.textAction} onClick={() => fileInput.current?.click()} disabled={uploading} aria-label={`Upload a photo for ${id}`}>
              <ImageUp size={14} strokeWidth={1.75} aria-hidden="true" />&nbsp;Upload a photo
            </button>
            <button ref={photoTrigger} data-sq="surface" type="button" className={partStyles.textAction} aria-label={`Set ${id}'s photo from a link`} aria-expanded={editing === "photo"} aria-controls={editorId} onClick={() => openEditor("photo")}>Use a link</button>
            {ownPhoto ? (
              <ConfirmMorph
                label="Use the default photo"
                prompt={<FitPrompt full="Remove its photo?" short="Remove its photo?" tiny="Remove it?" />}
                confirmLabel="Remove"
                pendingLabel="Removing"
                doneLabel="Removed"
                tone="neutral"
                onConfirm={async () => {
                  setPhotoError(null);
                  try {
                    await defaultPhoto.mutateAsync(silicon.uuid);
                  } catch (raw) {
                    setPhotoError(describeError(raw));
                    throw raw;
                  }
                  window.setTimeout(() => handFocus(profile.current, () => uploadTrigger.current), RESULT_MS + 60);
                }}
              />
            ) : null}
            </span>
          </dd>
        </div>
      </dl>
      {photoError ? <p className={styles.error} role="alert">{photoError}</p> : null}
      <input
        ref={fileInput}
        type="file"
        accept={PHOTO_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void startUpload(file);
        }}
      />
      <div className={styles.below}>
        <HeightFrame morphKey={editing ?? "none"}>
          {/* Spaced only while an editor shows, so the closed slot adds no gap above "Change its id". */}
          <div id={editorId} className={styles.editorSlot} data-open={editing !== null || undefined}>
            {editing === "timezone" ? (
              <InlineEditor title="Timezone" description={timezoneDescription(id)} autoFocus>
                <TimezoneForm value={silicon.timezone} onSave={timezone => save({ timezone })} onDone={closeEditor} />
              </InlineEditor>
            ) : editing === "photo" ? (
              <InlineEditor title="Photo from a link" description={photoUrlDescription(id)}>
                <PhotoUrlForm value={ownPhoto} name={silicon.display_name} autoFocus onSave={url => save({ pfp_url: url })} onDone={closeEditor} />
              </InlineEditor>
            ) : null}
          </div>
        </HeightFrame>
        <div ref={idScope} className={styles.idScope}>
          <HeightFrame morphKey={String(changingId)}>
            {changingId ? (
              <div className={styles.idForm}>
                <IdChangeForm
                  prefix="si:"
                  currentId={silicon.id}
                  uuid={silicon.uuid}
                  subject="silicon"
                  autoFocus
                  submit={next => changeId.mutateAsync({ uuid: silicon.uuid, id: next })}
                  onChanged={closeIdForm}
                  onCancel={closeIdForm}
                />
              </div>
            ) : (
              <Button ref={changeIdButton} variant="secondary" size="sm" onClick={() => setChangingId(true)}>Change its id</Button>
            )}
          </HeightFrame>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* STK                                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

function StkBlock({ silicon, now, onReveal }: BodyProps) {
  const [phase, setPhase] = useState<"idle" | "pending" | "done">("idle");
  const [own, setOwn] = useState(false);
  const [stk, setStk] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rotateStk = useRotateStkOnce();
  const id = silicon.id ?? silicon.uuid;
  const rotated = stkRotatedAt(silicon);
  const rotate = async () => {
    const chosen = own ? stk : "";
    if (own) {
      const problem = stkProblem(chosen);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setPhase("pending");
    setError(null);
    try {
      // The answer leaves the mutation cache as soon as it is here: the reveal card below holds the only copy.
      const answer = await rotateStk.run({ uuid: silicon.uuid, stk: own ? normalizeStk(chosen) : undefined });
      setPhase("done");
      setStk("");
      if (answer.stk) {
        onReveal({
          silicon: silicon.uuid,
          origin: "stk",
          title: `${id}'s new STK`,
          description: `The old STK stopped working and ${id} was signed out everywhere. Give it this one; Silicon Accounts keeps only its hash.`,
          secrets: [stkSecret(id, answer.stk)],
        });
      }
      window.setTimeout(() => setPhase("idle"), 1800);
    } catch (raw) {
      setPhase("idle");
      setError(describeError(raw));
    }
  };
  return (
    <div className={styles.stack}>
      <p className={styles.fact}>
        {rotated
          ? <>Last rotated {formatRelative(rotated, now)} ({formatDate(rotated)}).</>
          : <>Not rotated since it was created on {formatDate(silicon.created_at)}.</>}
      </p>
      <Checkbox label="Choose the new STK yourself" description="Otherwise a new stk- plus 12 hex digits is generated and shown to you once." checked={own} onCheckedChange={value => { setOwn(value === true); setError(null); }} />
      {own ? (
        <Input label="New STK" className={styles.monoInput} value={stk} onChange={event => { setStk(event.target.value); setError(null); }} placeholder="stk-0123456789ab" autoComplete="off" spellCheck={false} description="stk- followed by 8 to 32 hex digits. It is never shown again, so keep a copy." />
      ) : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.holdRow}>
        {/* The id is in the block's heading and text; a label without it fits a phone whatever the id's length. */}
        <HoldToConfirm
          label="Hold to rotate the STK"
          confirmedLabel={phase === "pending" ? "Rotating" : "Rotated"}
          confirmed={phase !== "idle"}
          tone="danger"
          icon={<RefreshCw size={18} strokeWidth={1.75} />}
          onConfirm={() => void rotate()}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Webhook                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

function urlProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter the URL the Silicon receives events at.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `“${value}” is not a full URL. Start it with https://, for example https://scout.example/hooks/accounts.`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `A webhook URL must start with https:// (this one starts with ${url.protocol}//).`;
  return null;
}

function WebhookBlock({ silicon, onReveal }: BodyProps) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scope = useRef<HTMLDivElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const setWebhook = useSetSiliconWebhookOnce();
  const removeWebhook = useRemoveSiliconWebhookSettled();
  const id = silicon.id ?? silicon.uuid;
  const startEdit = () => {
    setUrl(silicon.webhook_url ?? "");
    setError(null);
    setEditing(true);
    handFocus(scope.current, () => urlInput.current);
  };
  const cancelEdit = () => {
    setEditing(false);
    handFocus(scope.current, () => changeButton.current);
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = urlProblem(url);
    if (problem) return setError(problem);
    setError(null);
    try {
      const answer = await setWebhook.run({ uuid: silicon.uuid, url: url.trim() });
      setEditing(false);
      // The secret card that opens takes focus (it is read once and must be stored).
      onReveal({
        silicon: silicon.uuid,
        origin: "webhook",
        title: `${id}'s webhook signing secret`,
        description: `Events to ${answer.webhook_url} are signed with it (X-Accounts-Signature: v1=HMAC-SHA256 of "{timestamp}.{body}"). A new secret is made each time the URL is set.`,
        secrets: [{ label: "Signing secret", value: answer.webhook_secret }],
      });
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  const remove = async () => {
    setError(null);
    try {
      await removeWebhook.mutateAsync(silicon.uuid);
    } catch (raw) {
      setError(describeError(raw));
      throw raw;
    }
    window.setTimeout(() => {
      setUrl("");
      handFocus(scope.current, () => urlInput.current);
    }, RESULT_MS + 60);
  };
  const current = silicon.webhook_url;
  return (
    <div ref={scope} className={styles.scope}>
      <HeightFrame morphKey={`${editing}-${!!current}`}>
        {editing || !current ? (
          <form className={styles.stack} onSubmit={save} noValidate>
            <Input ref={urlInput} label="Webhook URL" type="url" inputMode="url" placeholder="https://scout.example/hooks/accounts" value={url} onChange={event => { setUrl(event.target.value); setError(null); }} error={error ?? undefined} autoComplete="off" spellCheck={false} />
            <div className={styles.actions}>
              {editing ? <Button type="button" variant="ghost" size="sm" onClick={cancelEdit} disabled={setWebhook.isPending}>Cancel</Button> : null}
              <Button type="submit" variant="secondary" size="sm" loading={setWebhook.isPending}>{current ? "Save new URL" : "Set webhook"}</Button>
            </div>
          </form>
        ) : (
          <div className={styles.stack}>
            <div data-sq="surface" className={styles.urlBox}>
              <span className={styles.url} title={current}>{current}</span>
              <CopyButton value={current} label="Copy webhook URL" iconOnly variant="plain" />
            </div>
            <div className={styles.actions}>
              <ConfirmMorph label="Remove webhook" prompt={<FitPrompt full="Stop sending it events?" short="Stop sending it events?" tiny="Stop events?" />} confirmLabel="Remove" pendingLabel="Removing" doneLabel="Removed" onConfirm={remove} />
              <Button ref={changeButton} variant="secondary" size="sm" onClick={startEdit}>Change URL</Button>
            </div>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
          </div>
        )}
      </HeightFrame>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Transfer                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Turns what was typed into the `to` the API takes (`c:id` or an email), or says why it can't be. */
function recipient(raw: string, me: CarbonMe): { to: string } | { problem: string } {
  const value = raw.trim().toLowerCase();
  if (!value) return { problem: "Name the Carbon who should take over: their c:id or their email." };
  if (value.startsWith("si:")) return { problem: "A Silicon cannot be a custodian. Name a Carbon's c:id or email." };
  if (value.includes("@")) {
    if (!EMAIL_SHAPE.test(value)) return { problem: `Enter an email like name@example.com; “${value}” is not one.` };
    if (me.emails.some(item => item.email.toLowerCase() === value)) return { problem: `${value} is your own email, and you are already the custodian.` };
    return { to: value };
  }
  const handle = value.replace(/^c:/, "");
  if (!/^[a-z0-9_-]{3,30}$/.test(handle)) return { problem: "A c:id is c: followed by 3 to 30 of a to z, 0 to 9, - and _." };
  const to = `c:${handle}`;
  if (me.id && to === me.id.toLowerCase()) return { problem: "That is your own id, and you are already the custodian." };
  return { to };
}

function isSummary(value: unknown): value is AccountSummary {
  return !!value && typeof value === "object" && "display_name" in value;
}

function TransferBlock({ silicon, me, now }: BodyProps) {
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef<HTMLDivElement>(null);
  const mini = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const recipientInput = useRef<HTMLInputElement>(null);
  const pendingCard = useRef<HTMLDivElement>(null);
  const start = useStartTransfer();
  const cancelTransfer = useCancelTransferSettled();
  const id = silicon.id ?? silicon.uuid;
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = recipient(to, me);
    if ("problem" in target) return setError(target.problem);
    setSending(true);
    setError(null);
    try {
      const request = await start.mutateAsync({ uuid: silicon.uuid, to: target.to });
      // The Silicon's card travels to the Carbon it is going to, then the block shows the waiting transfer.
      const from = mini.current?.getBoundingClientRect();
      const dest = field.current?.getBoundingClientRect();
      if (mini.current && from && dest && !reducedMotion()) {
        await animate(mini.current, { x: [0, dest.left + dest.width / 2 - (from.left + from.width / 2)], scale: [1, 0.86], opacity: [1, 0] }, { x: { ...motionTokens.spring.smooth, visualDuration: 0.5 }, scale: motionTokens.spring.smooth, opacity: { duration: 0.42, delay: 0.12, ease: [...motionTokens.ease.exit] } });
      }
      start.settle(silicon.uuid, request, target.to);
      setTo("");
      // The form is gone; focus goes to the waiting transfer, which reads out who it is waiting for.
      handFocus(scope.current, () => pendingCard.current);
    } catch (raw) {
      setError(describeError(raw));
    } finally {
      setSending(false);
    }
  };
  const cancel = async () => {
    setError(null);
    try {
      await cancelTransfer.mutateAsync(silicon.uuid);
    } catch (raw) {
      setError(describeError(raw));
      throw raw;
    }
    window.setTimeout(() => handFocus(scope.current, () => recipientInput.current), RESULT_MS + 60);
  };
  const transfer = silicon.pending_transfer;
  const left = msUntil(transfer?.expires_at, now);
  return (
    <div ref={scope} className={styles.scope}>
      <HeightFrame morphKey={String(!!transfer)}>
        {transfer ? (
          <div className={styles.stack}>
            <div ref={pendingCard} data-sq="surface" className={styles.pending} tabIndex={-1} role="group" aria-label="Transfer request">
              <div className={styles.pendingRoute} aria-hidden="true">
                <Avatar name={silicon.display_name} src={silicon.pfp_url} size="sm" />
                <ArrowRight size={14} strokeWidth={1.75} />
                {isSummary(transfer.to) ? <Avatar name={transfer.to.display_name} src={transfer.to.pfp_url} size="sm" /> : <span className={styles.personMark}><Mail size={14} strokeWidth={1.75} /></span>}
              </div>
              <p className={styles.pendingText}>
                Waiting for <strong>{personLabel(transfer.to)}</strong> to accept {id}.{" "}
                {left > 0 ? `The request expires in ${spanText(left)} (${formatDate(transfer.expires_at)}).` : "The request has expired."}
              </p>
            </div>
            <div className={styles.actions}>
              <ConfirmMorph label="Cancel transfer" prompt={<FitPrompt full="Cancel the transfer?" short="Cancel the transfer?" tiny="Cancel it?" />} confirmLabel="Cancel it" cancelLabel="Keep" pendingLabel="Cancelling" doneLabel="Cancelled" onConfirm={cancel} />
            </div>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
          </div>
        ) : (
          <form className={styles.transfer} onSubmit={send} noValidate>
            <div className={styles.route}>
              <div ref={mini} data-sq="surface" className={styles.mini} aria-hidden="true">
                <Avatar name={silicon.display_name} src={silicon.pfp_url} size="sm" />
                <span className={styles.mono}>{id}</span>
              </div>
              <ArrowRight className={styles.routeArrow} size={16} strokeWidth={1.75} aria-hidden="true" />
              <div ref={field} className={styles.routeField}>
                <Input ref={recipientInput} label="New custodian" className={styles.recipient} placeholder="c:id or email" value={to} onChange={event => { setTo(event.target.value); setError(null); }} autoComplete="off" spellCheck={false} autoCapitalize="off" />
              </div>
            </div>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.actions}>
              <Button type="submit" variant="secondary" size="sm" loading={sending}>Send transfer request</Button>
            </div>
          </form>
        )}
      </HeightFrame>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Delete                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

function DeleteBlock({ silicon, onClose, onDeleted }: BodyProps) {
  const [phase, setPhase] = useState<"idle" | "pending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const remove = useDeleteSiliconSettled();
  const run = async () => {
    setPhase("pending");
    setError(null);
    const uuid = silicon.uuid;
    try {
      await remove.mutateAsync({ uuid, confirm: silicon.id ?? uuid });
      setPhase("done");
      // "Deleted" shows in place, the drawer slides away with its content, then the tile leaves the grid.
      window.setTimeout(() => {
        onClose();
        window.setTimeout(() => {
          remove.settle(uuid);
          onDeleted(uuid);
        }, 360);
      }, RESULT_MS);
    } catch (raw) {
      setPhase("idle");
      setError(describeError(raw));
    }
  };
  return (
    <div className={styles.stack}>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.holdRow}>
        <HoldToConfirm
          label="Hold to delete this Silicon"
          confirmedLabel={phase === "pending" ? "Deleting" : "Deleted"}
          confirmed={phase !== "idle"}
          duration={1600}
          tone="danger"
          icon={<Trash2 size={18} strokeWidth={1.75} />}
          onConfirm={() => void run()}
        />
      </div>
    </div>
  );
}
