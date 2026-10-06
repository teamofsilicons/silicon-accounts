/**
 * One Silicon, as its custodian manages it (a drawer beside the Silicons page): its details, photo and id, its STK
 * (rotate it by holding; the new one is shown once), its webhook (the signing secret is shown once each time it is set),
 * handing it to another Carbon (the card slides toward the recipient; they have 14 days to accept), and deleting it.
 *
 * The drawer is modal, so focus never falls out of it: whenever a control replaces itself (a form becoming a waiting
 * card, a "Removed" button folding away, a stored secret closing), focus moves to what took its place.
 */
import { For, Match, Show, Switch, createSignal, type JSX } from "solid-js";
import { ArrowRight, Mail, RefreshCw, Trash2 } from "lucide-solid";
import { api, ApiError, type CarbonMe, type ManagedSilicon, type PendingTransfer, type SiliconMe } from "../../../api";
import { Avatar } from "../../../arc/avatar/avatar";
import { Badge } from "../../../arc/badge/badge";
import { Button } from "../../../arc/button/button";
import { Checkbox } from "../../../arc/checkbox/checkbox";
import { ConfirmMorph } from "../../../arc/confirm-morph/confirm-morph";
import { CopyButton } from "../../../arc/copy-button/copy-button";
import { Drawer, DrawerContent } from "../../../arc/drawer/drawer";
import { HoldToConfirm } from "../../../arc/hold-to-confirm/hold-to-confirm";
import { InlineEdit } from "../../../arc/inline-edit/inline-edit";
import { Input } from "../../../arc/input/input";
import { TextMorph } from "../../../arc/text-morph/text-morph";
import { HeightFrame } from "../../../arc/lib/HeightFrame";
import { animate, motionTokens, prefersReducedMotion, spring } from "../../../arc/lib/motion";
import { useSquircle } from "../../../arc/lib/squircle";
import { formatDate, formatRelative } from "../../../lib/format";
import { timezoneLabel, utcOffset } from "../../../lib/timezones";
import { editorTriggerClass, InlineEditor, PhotoUrlForm, photoUrlDescription, timezoneDescription, TimezoneForm } from "./DetailEditors";
import { IdChangeForm } from "./IdChangeForm";
import { SecretReveal } from "./SecretReveal";
import type { Reveal } from "./reveals";
import { rememberIdChange } from "./recent-ids";
import { handFocus } from "./focus";
import { normalizeStk, stkProblem, stkSecret } from "./stk";
import { isDefaultPhoto, msUntil, personLabel, reasonError, reportFailure, spanText } from "./common";
import styles from "./silicon-drawer.module.css";

export interface SiliconDrawerProps {
  silicon: ManagedSilicon | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  me: CarbonMe;
  now: number;
  onUpdated: (next: ManagedSilicon) => void;
  onDeleted: (uuid: string) => void;
  reveals: Reveal[];
  onReveal: (reveal: Omit<Reveal, "id">) => void;
  onRevealDone: (id: string) => void;
}

/** Merges an answer from a Silicon endpoint (the Silicon view, maybe with pending_transfer) into what we have. */
function merge(current: ManagedSilicon, answer: SiliconMe | ManagedSilicon | Record<string, unknown>): ManagedSilicon {
  const next = { ...current, ...(answer as object) } as ManagedSilicon;
  if (!("pending_transfer" in (answer as object))) next.pending_transfer = current.pending_transfer;
  return next;
}

/** How long a "Removed" / "Cancelled" result shows in place before the content behind it changes. */
const RESULT_MS = 700;

export function SiliconDrawer(props: SiliconDrawerProps) {
  return (
    <Drawer open={props.open} onOpenChange={props.onOpenChange}>
      <Show when={props.silicon}>
        {silicon => (
          <DrawerContent title={silicon().display_name} description={`${silicon().id ?? "No id"} · uuid ${silicon().uuid}`}>
            <Show when={silicon().uuid} keyed>
              {(_uuid: string) => <Body {...props} silicon={silicon()} />}
            </Show>
          </DrawerContent>
        )}
      </Show>
    </Drawer>
  );
}

type BodyProps = Omit<SiliconDrawerProps, "silicon"> & { silicon: ManagedSilicon };
type Origin = NonNullable<Reveal["origin"]>;

function Body(props: BodyProps) {
  let body: HTMLDivElement | undefined;
  const headings: Partial<Record<Origin, HTMLElement>> = {};
  const id = () => props.silicon.id ?? props.silicon.uuid;
  const reveals = () => props.reveals.filter(item => item.silicon === props.silicon.uuid);
  /** "I've stored it": the next secret waiting here, else the block the secret came from, else the drawer itself. */
  const stored = (reveal: Reveal) => {
    props.onRevealDone(reveal.id);
    handFocus(body, () =>
      body?.querySelector<HTMLElement>("[data-reveals] h2")
        ?? (reveal.origin ? headings[reveal.origin] : undefined)
        ?? body?.closest<HTMLElement>("[role=dialog]"));
  };
  return (
    <div ref={body} class={styles.body}>
      <Show when={reveals().length}>
        <div class={styles.reveals} data-reveals>
          <For each={reveals()}>
            {reveal => <SecretReveal title={reveal.title} description={reveal.description} secrets={reveal.secrets} onDone={() => stored(reveal)} focusOnMount />}
          </For>
        </div>
      </Show>
      <Profile {...props} />
      <Block title="STK" headingRef={el => (headings.stk = el)} description={`The password ${id()} signs in with. Rotating it ends the old one at once and signs ${id()} out of every app.`}>
        <StkBlock {...props} />
      </Block>
      <Block title="Webhook" headingRef={el => (headings.webhook = el)} description={`Where Silicon Accounts tells ${id()} about its own account: id and detail changes, STK rotations and custodian changes. Every event is signed.`}>
        <WebhookBlock {...props} />
      </Block>
      <Block title="Custodian" description={`You are ${id()}'s custodian. To hand it to another Carbon, name them; they have 14 days to accept, and until then nothing changes.`}>
        <TransferBlock {...props} />
      </Block>
      <Block title="Delete this Silicon" description={`Its account ends: it is signed out everywhere, every app it signed into is told, and ${id()} stays reserved for 10 days. This cannot be undone.`} danger>
        <DeleteBlock {...props} />
      </Block>
    </div>
  );
}

function Block(props: { title: string; description: string; children: JSX.Element; danger?: boolean; headingRef?: (el: HTMLElement) => void }) {
  return (
    <section class={styles.block} data-danger={props.danger || undefined}>
      <div class={styles.blockHead}>
        {/* Focusable by script only: focus lands here after a secret from this block is stored. */}
        <h3 ref={el => props.headingRef?.(el)} class={styles.blockTitle} tabIndex={-1}>{props.title}</h3>
        <p class={styles.blockText}>{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

/* ----------------------------------------------------- profile ----------------------------------------------------- */

type Editing = "timezone" | "photo" | null;

function Profile(props: BodyProps) {
  const [changingId, setChangingId] = createSignal(false);
  // One detail editor at a time, inline below the facts: popovers opened from a modal drawer are hidden from screen
  // readers (see DetailEditors), and a phone-wide drawer has no room beside the row anyway.
  const [editing, setEditing] = createSignal<Editing>(null);
  let idScope: HTMLDivElement | undefined;
  let changeIdButton: HTMLButtonElement | undefined;
  let profile: HTMLElement | undefined;
  let photoScope: HTMLElement | undefined;
  let photoTrigger: HTMLButtonElement | undefined;
  let timezoneTrigger: HTMLButtonElement | undefined;
  const editorId = `silicon-editor-${props.silicon.uuid}`;
  const openEditor = (which: Exclude<Editing, null>) => setEditing(current => (current === which ? null : which));
  const closeEditor = () => {
    const which = editing();
    setEditing(null);
    handFocus(profile, () => (which === "photo" ? photoTrigger : timezoneTrigger));
  };
  const id = () => props.silicon.id ?? props.silicon.uuid;
  const save = async (patch: { display_name?: string; timezone?: string; pfp_url?: string | null }) => {
    const answer = await api.me.silicons.update(props.silicon.uuid, patch);
    props.onUpdated(merge(props.silicon, answer));
  };
  /** Back to the default photo; "Removed" shows in place first, then the row settles and focus stays in it. */
  const useDefaultPhoto = async () => {
    const answer = await api.me.silicons.update(props.silicon.uuid, { pfp_url: null });
    window.setTimeout(() => {
      props.onUpdated(merge(props.silicon, answer));
      handFocus(photoScope, () => photoTrigger);
    }, RESULT_MS);
  };
  const closeIdForm = () => {
    setChangingId(false);
    handFocus(idScope, () => changeIdButton);
  };
  const status = () => {
    if (props.silicon.status === "pending_custodian") return { tone: "warning" as const, text: "Waiting for a custodian" };
    if (props.silicon.pending_transfer) return { tone: "info" as const, text: "Transfer pending" };
    return { tone: "success" as const, text: "Active" };
  };
  const ownPhoto = () => (isDefaultPhoto(props.silicon.pfp_url) ? null : props.silicon.pfp_url);
  return (
    <section ref={profile} class={styles.profile} aria-label="Profile">
      <div class={styles.identity}>
        <Avatar name={props.silicon.display_name} src={props.silicon.pfp_url} size="xl" kind="silicon" />
        <div class={styles.identityText}>
          <InlineEdit
            label="Display name"
            value={props.silicon.display_name}
            onSave={async next => { try { await save({ display_name: next }); } catch (error) { reportFailure(error, "The display name did not change"); throw reasonError(error); } }}
            validate={next => (!next ? "Enter a display name." : next.length > 100 ? `A display name can be at most 100 characters (this one has ${next.length}).` : null)}
            maxLength={100}
          />
          <div class={styles.idLine}>
            {/* A long id fades out at the edge rather than pushing the drawer sideways; the title and Copy have it all. */}
            <span class={styles.idText} title={props.silicon.id ?? undefined}><TextMorph class={styles.idMorph}>{props.silicon.id ?? "No id"}</TextMorph></span>
            <CopyButton value={props.silicon.id ?? ""} label={`Copy ${props.silicon.id ?? "id"}`} iconOnly variant="plain" size="xs" disabled={!props.silicon.id} />
            <Badge size="sm" tone={status().tone} dot={status().tone === "success"}>{status().text}</Badge>
          </div>
        </div>
      </div>
      <dl class={styles.facts}>
        <div>
          <dt>uuid</dt>
          <dd><span class={styles.mono}>{props.silicon.uuid}</span><CopyButton value={props.silicon.uuid} label="Copy uuid" iconOnly variant="plain" size="xs" /></dd>
        </div>
        <div>
          <dt>Timezone</dt>
          <dd>
            <span>{timezoneLabel(props.silicon.timezone)} · UTC{utcOffset(props.silicon.timezone)}</span>
            <button ref={el => { timezoneTrigger = el; useSquircle(el); }} type="button" class={editorTriggerClass} aria-label={`Change ${id()}'s timezone`} aria-expanded={editing() === "timezone"} aria-controls={editorId} onClick={() => openEditor("timezone")}>Change</button>
          </dd>
        </div>
        <div>
          <dt>Born</dt>
          <dd><span>{formatDate(props.silicon.dob)}, the day its account was created</span></dd>
        </div>
        <div>
          <dt>Photo</dt>
          <dd ref={el => (photoScope = el)}>
            <span>{ownPhoto() ? "A photo of its own" : "The default photo"}</span>
            <button ref={el => { photoTrigger = el; useSquircle(el); }} type="button" class={editorTriggerClass} aria-label={`Set ${id()}'s photo from a link`} aria-expanded={editing() === "photo"} aria-controls={editorId} onClick={() => openEditor("photo")}>Use a link</button>
            <Show when={ownPhoto()}>
              <ConfirmMorph label="Use the default photo" prompt="Remove its photo?" confirmLabel="Remove" pendingLabel="Removing" doneLabel="Removed" tone="neutral" onConfirm={useDefaultPhoto} onError={raw => reportFailure(raw, "The photo was not removed")} />
            </Show>
          </dd>
        </div>
      </dl>
      <div class={styles.below}>
        <HeightFrame morphKey={editing() ?? "none"}>
          {/* Spaced only while an editor shows, so the closed slot adds no gap above "Change its id". */}
          <div id={editorId} class={styles.editorSlot} data-open={editing() !== null || undefined}>
            <Switch>
              <Match when={editing() === "timezone"}>
                <InlineEditor title="Timezone" description={timezoneDescription(id())}>
                  <TimezoneForm value={props.silicon.timezone} autofocus onSave={timezone => save({ timezone })} onDone={closeEditor} />
                </InlineEditor>
              </Match>
              <Match when={editing() === "photo"}>
                <InlineEditor title="Photo from a link" description={photoUrlDescription(id())}>
                  <PhotoUrlForm value={ownPhoto()} name={props.silicon.display_name} autofocus onSave={url => save({ pfp_url: url })} onDone={closeEditor} />
                </InlineEditor>
              </Match>
            </Switch>
          </div>
        </HeightFrame>
        <div ref={idScope} class={styles.idScope}>
          <HeightFrame morphKey={String(changingId())}>
            <Show
              when={changingId()}
              fallback={<Button ref={el => (changeIdButton = el)} variant="secondary" size="sm" onClick={() => setChangingId(true)}>Change its id</Button>}
            >
              <div class={styles.idForm}>
                <IdChangeForm
                  prefix="si:"
                  currentId={props.silicon.id}
                  uuid={props.silicon.uuid}
                  subject="silicon"
                  autofocus
                  submit={async next => props.onUpdated(merge(props.silicon, await api.me.silicons.changeId(props.silicon.uuid, next)))}
                  onChanged={(next, previous) => {
                    rememberIdChange(props.silicon.uuid, previous, next);
                    closeIdForm();
                  }}
                  onCancel={closeIdForm}
                />
              </div>
            </Show>
          </HeightFrame>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- STK ------------------------------------------------------- */

function StkBlock(props: BodyProps) {
  const [phase, setPhase] = createSignal<"idle" | "pending" | "done">("idle");
  const [own, setOwn] = createSignal(false);
  const [stk, setStk] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const id = () => props.silicon.id ?? props.silicon.uuid;
  const rotate = async () => {
    const chosen = own() ? stk() : "";
    if (own()) {
      const problem = stkProblem(chosen);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setPhase("pending");
    setError(null);
    try {
      const answer = await api.me.silicons.rotateStk(props.silicon.uuid, own() ? normalizeStk(chosen) : undefined);
      props.onUpdated({ ...props.silicon, stk_rotated_at: answer.rotated_at });
      setPhase("done");
      setStk("");
      if (answer.stk) {
        props.onReveal({
          silicon: props.silicon.uuid,
          origin: "stk",
          title: `${id()}'s new STK`,
          description: `The old STK stopped working and ${id()} was signed out everywhere. Give it this one; Silicon Accounts keeps only its hash.`,
          secrets: [stkSecret(id(), answer.stk)],
        });
      }
      window.setTimeout(() => setPhase("idle"), 1800);
    } catch (raw) {
      setPhase("idle");
      setError(reportFailure(raw, "The STK was not rotated"));
    }
  };
  return (
    <div class={styles.stack}>
      <p class={styles.fact}>
        {props.silicon.stk_rotated_at ? <>Last rotated {formatRelative(props.silicon.stk_rotated_at, props.now)} ({formatDate(props.silicon.stk_rotated_at)}).</> : <>Not rotated since it was created on {formatDate(props.silicon.created_at)}.</>}
      </p>
      <Checkbox label="Choose the new STK yourself" description="Otherwise a new stk- plus 12 hex digits is generated and shown to you once." checked={own()} onChange={value => { setOwn(value); setError(null); }} />
      <Show when={own()}>
        <Input label="New STK" mono value={stk()} onInput={event => { setStk(event.currentTarget.value); setError(null); }} placeholder="stk-0123456789ab" autocomplete="off" spellcheck={false} description="stk- followed by 8 to 32 hex digits. It is never shown again, so keep a copy." />
      </Show>
      <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
      <div class={styles.holdRow}>
        {/* The id is in the block's heading and text; a label without it fits a phone whatever the id's length. */}
        <HoldToConfirm
          label="Hold to rotate the STK"
          confirmedLabel={phase() === "pending" ? "Rotating" : "Rotated"}
          confirmed={phase() !== "idle"}
          tone="danger"
          icon={<RefreshCw size={18} stroke-width={1.75} />}
          onConfirm={() => void rotate()}
        />
      </div>
    </div>
  );
}

/* ----------------------------------------------------- webhook ----------------------------------------------------- */

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

function WebhookBlock(props: BodyProps) {
  const [editing, setEditing] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let scope: HTMLDivElement | undefined;
  let urlInput: HTMLInputElement | undefined;
  let changeButton: HTMLButtonElement | undefined;
  const id = () => props.silicon.id ?? props.silicon.uuid;
  const startEdit = () => {
    setUrl(props.silicon.webhook_url ?? "");
    setError(null);
    setEditing(true);
    handFocus(scope, () => urlInput);
  };
  const cancelEdit = () => {
    setEditing(false);
    handFocus(scope, () => changeButton);
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const problem = urlProblem(url());
    if (problem) return setError(problem);
    setPending(true);
    setError(null);
    try {
      const answer = await api.me.silicons.setWebhook(props.silicon.uuid, url().trim());
      props.onUpdated({ ...props.silicon, webhook_url: answer.webhook_url });
      setEditing(false);
      // The secret card that opens takes focus (it is read once and must be stored).
      props.onReveal({
        silicon: props.silicon.uuid,
        origin: "webhook",
        title: `${id()}'s webhook signing secret`,
        description: `Events to ${answer.webhook_url} are signed with it (X-Accounts-Signature: v1=HMAC-SHA256 of "{timestamp}.{body}"). A new secret is made each time the URL is set.`,
        secrets: [{ label: "Signing secret", value: answer.webhook_secret }],
      });
    } catch (raw) {
      setError(reportFailure(raw, "The webhook was not set"));
    } finally {
      setPending(false);
    }
  };
  const remove = async () => {
    await api.me.silicons.removeWebhook(props.silicon.uuid);
    window.setTimeout(() => {
      setUrl("");
      props.onUpdated({ ...props.silicon, webhook_url: null });
      handFocus(scope, () => urlInput);
    }, RESULT_MS);
  };
  return (
    <div ref={scope} class={styles.scope}>
      <HeightFrame morphKey={`${editing()}-${!!props.silicon.webhook_url}`}>
        <Switch>
          <Match when={editing() || !props.silicon.webhook_url}>
            <form class={styles.stack} onSubmit={save} novalidate>
              <Input ref={el => (urlInput = el)} label="Webhook URL" type="url" inputmode="url" placeholder="https://scout.example/hooks/accounts" value={url()} onInput={event => { setUrl(event.currentTarget.value); setError(null); }} error={error()} autocomplete="off" spellcheck={false} />
              <div class={styles.actions}>
                <Show when={editing()}><Button type="button" variant="ghost" size="sm" onClick={cancelEdit} disabled={pending()}>Cancel</Button></Show>
                <Button type="submit" variant="secondary" size="sm" loading={pending()}>{props.silicon.webhook_url ? "Save new URL" : "Set webhook"}</Button>
              </div>
            </form>
          </Match>
          <Match when={props.silicon.webhook_url}>
            {current => (
              <div class={styles.stack}>
                <div ref={el => useSquircle(el)} class={styles.urlBox}>
                  <span class={styles.url} title={current()}>{current()}</span>
                  <CopyButton value={current()} label="Copy webhook URL" iconOnly variant="plain" size="xs" />
                </div>
                <div class={styles.actions}>
                  <ConfirmMorph label="Remove webhook" prompt="Stop sending it events?" confirmLabel="Remove" pendingLabel="Removing" doneLabel="Removed" onConfirm={remove} onError={raw => setError(reportFailure(raw, "The webhook was not removed"))} />
                  <Button ref={el => (changeButton = el)} variant="secondary" size="sm" onClick={startEdit}>Change URL</Button>
                </div>
                <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
              </div>
            )}
          </Match>
        </Switch>
      </HeightFrame>
    </div>
  );
}

/* ----------------------------------------------------- transfer ----------------------------------------------------- */

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

function TransferBlock(props: BodyProps) {
  const [to, setTo] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let scope: HTMLDivElement | undefined;
  let mini: HTMLDivElement | undefined;
  let field: HTMLDivElement | undefined;
  let recipientInput: HTMLInputElement | undefined;
  let pendingCard: HTMLDivElement | undefined;
  const id = () => props.silicon.id ?? props.silicon.uuid;
  const send = async (event: SubmitEvent) => {
    event.preventDefault();
    const target = recipient(to(), props.me);
    if ("problem" in target) return setError(target.problem);
    setPending(true);
    setError(null);
    try {
      const request = await api.me.silicons.transfer(props.silicon.uuid, target.to);
      // The Silicon's card travels to the person it is going to, then the block shows the waiting transfer.
      if (mini && field && !prefersReducedMotion()) {
        const from = mini.getBoundingClientRect();
        const dest = field.getBoundingClientRect();
        await animate(mini, { x: [0, dest.left + dest.width / 2 - (from.left + from.width / 2)], scale: [1, 0.86], opacity: [1, 0] }, { x: { ...spring.smooth, visualDuration: 0.5 }, scale: spring.smooth, opacity: { duration: 0.42, delay: 0.12, ease: [...motionTokens.ease.exit] as [number, number, number, number] } });
      }
      const pendingTransfer: PendingTransfer = { id: request.id, to: (request.to as PendingTransfer["to"]) ?? target.to, created_at: request.created_at, expires_at: request.expires_at };
      props.onUpdated({ ...props.silicon, pending_transfer: pendingTransfer });
      setTo("");
      // The form is gone; focus goes to the waiting transfer, which reads out who it is waiting for.
      handFocus(scope, () => pendingCard);
    } catch (raw) {
      setError(reportFailure(raw, "No transfer request was sent"));
    } finally {
      setPending(false);
    }
  };
  const cancel = async () => {
    await api.me.silicons.cancelTransfer(props.silicon.uuid);
    window.setTimeout(() => {
      props.onUpdated({ ...props.silicon, pending_transfer: null });
      handFocus(scope, () => recipientInput);
    }, RESULT_MS);
  };
  const left = () => msUntil(props.silicon.pending_transfer?.expires_at, props.now);
  return (
    <div ref={scope} class={styles.scope}>
      <HeightFrame morphKey={String(!!props.silicon.pending_transfer)}>
        <Show
          when={props.silicon.pending_transfer}
          fallback={
            <form class={styles.transfer} onSubmit={send} novalidate>
              <div class={styles.route}>
                <div ref={el => { mini = el; useSquircle(el); }} class={styles.mini} aria-hidden="true">
                  <Avatar name={props.silicon.display_name} src={props.silicon.pfp_url} size="sm" kind="silicon" />
                  <span class={styles.mono}>{id()}</span>
                </div>
                <ArrowRight class={styles.routeArrow} size={16} stroke-width={1.75} aria-hidden="true" />
                <div ref={field} class={styles.routeField}>
                  <Input ref={el => (recipientInput = el)} label="New custodian" hideLabel placeholder="c:id or email" value={to()} onInput={event => { setTo(event.currentTarget.value); setError(null); }} autocomplete="off" spellcheck={false} autocapitalize="off" />
                </div>
              </div>
              <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
              <div class={styles.actions}>
                <Button type="submit" variant="secondary" size="sm" loading={pending()}>Send transfer request</Button>
              </div>
            </form>
          }
        >
          {transfer => (
            <div class={styles.stack}>
              <div ref={el => { pendingCard = el; useSquircle(el); }} class={styles.pending} tabIndex={-1} role="group" aria-label="Transfer request">
                <div class={styles.pendingRoute} aria-hidden="true">
                  <Avatar name={props.silicon.display_name} src={props.silicon.pfp_url} size="sm" kind="silicon" />
                  <ArrowRight size={14} stroke-width={1.75} />
                  <Show when={typeof transfer().to === "object" && transfer().to && "display_name" in (transfer().to as object)} fallback={<span class={styles.personMark}><Mail size={14} stroke-width={1.75} /></span>}>
                    <Avatar name={(transfer().to as { display_name: string }).display_name} src={(transfer().to as { pfp_url?: string }).pfp_url} size="sm" />
                  </Show>
                </div>
                <p class={styles.pendingText}>
                  Waiting for <strong>{personLabel(transfer().to)}</strong> to accept {id()}.{" "}
                  {left() > 0 ? `The request expires in ${spanText(left())} (${formatDate(transfer().expires_at)}).` : "The request has expired."}
                </p>
              </div>
              <div class={styles.actions}>
                <ConfirmMorph label="Cancel transfer" prompt="Cancel the transfer?" confirmLabel="Cancel it" cancelLabel="Keep" pendingLabel="Cancelling" doneLabel="Cancelled" onConfirm={cancel} onError={raw => setError(reportFailure(raw, "The transfer was not cancelled"))} />
              </div>
              <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
            </div>
          )}
        </Show>
      </HeightFrame>
    </div>
  );
}

/* ------------------------------------------------------ delete ------------------------------------------------------ */

function DeleteBlock(props: BodyProps) {
  const [phase, setPhase] = createSignal<"idle" | "pending" | "done">("idle");
  const [error, setError] = createSignal<string | null>(null);
  const remove = async () => {
    setPhase("pending");
    setError(null);
    try {
      const uuid = props.silicon.uuid;
      await api.me.silicons.remove(uuid, props.silicon.id ?? uuid);
      setPhase("done");
      // "Deleted" shows in place, the drawer slides away with its content, then the tile leaves the grid.
      window.setTimeout(() => {
        props.onOpenChange(false);
        window.setTimeout(() => props.onDeleted(uuid), 360);
      }, RESULT_MS);
    } catch (raw) {
      setPhase("idle");
      const failure = ApiError.from(raw);
      setError(reportFailure(failure, "The Silicon was not deleted"));
    }
  };
  return (
    <div class={styles.stack}>
      <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
      <div class={styles.holdRow}>
        <HoldToConfirm
          label="Hold to delete this Silicon"
          confirmedLabel={phase() === "pending" ? "Deleting" : "Deleted"}
          confirmed={phase() !== "idle"}
          duration={1600}
          icon={<Trash2 size={18} stroke-width={1.75} />}
          onConfirm={() => void remove()}
        />
      </div>
    </div>
  );
}
