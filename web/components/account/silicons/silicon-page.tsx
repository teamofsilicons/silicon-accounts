"use client";

/**
 * /silicons/[uuid], one Silicon's page, as the prototype draws it (Anil, 2026-11-12): Silicons above its name, its mark
 * with its si:id, its status and since when it is in your care, then two tabs on the account pages' rows
 * (parts/rows.tsx):
 *
 *   Access     its secret key (Change), its webhook (Set, Change, Remove)
 *   Settings   About: name, id, timezone, photo, looked after by (Hand Over / Cancel Handover); then Delete
 *
 * Every change asks or takes its input in a dialog (the dialog rules, redesign/decisions.md). A new key or webhook
 * secret is shown once above the tabs until the Carbon says it is stored (parts/reveals.ts).
 *
 * Not shown, because the API has no way to say it yet (prototype-differences.md): its last sign-in, the apps it uses,
 * its sign-ins over 14 days, its Activity tab, Apps it may use, Automation and Cloud services.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Clock, ImageUp, KeyRound, Trash2, UserRound, Webhook } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { ButtonLink } from "@teamofsilicons/silicon-ui/button-link";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { FileUpload } from "@teamofsilicons/silicon-ui/file-upload";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { Input } from "@teamofsilicons/silicon-ui/input";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@teamofsilicons/silicon-ui/tabs";
import { Page } from "@/components/foundation/layout/layout";
import type { CarbonMe, ManagedSilicon } from "@/lib/api/types";
import { formatDate, formatRelative } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useUpdateSilicon, useUploadSiliconPhoto } from "@/lib/query/silicons";
import { useMe } from "@/lib/query/session";
import { timezoneLabel, utcOffset } from "@/lib/timezones";
import { asCarbon, describeError, isDefaultPhoto, msUntil, PHOTO_ACCEPT, PHOTO_MAX_BYTES, photoProblem, personLabel, spanText, stkRotatedAt, useNow } from "../parts/common";
import { PhotoUrlForm, TimezoneForm } from "../parts/detail-editors";
import { IdChangeForm } from "../parts/id-change-form";
import { recipient } from "../parts/handover";
import { PageBar } from "../parts/page-bar";
import { useCancelTransferSettled, useChangeSiliconIdInForm, useDeleteSiliconSettled, useEverySilicon, useRemoveSiliconWebhookSettled, useSetSiliconWebhookOnce, useSiliconDefaultPhoto, useStartTransfer } from "../parts/queries";
import { addReveal, dismissReveal, dismissRevealsOf, usePendingReveals } from "../parts/reveals";
import { Row, Section, Strong, Tile } from "../parts/rows";
import { SecretReveal } from "../parts/secret-reveal";
import { SiliconMark } from "../parts/silicon-mark";
import { ChangeKeyDialog } from "./change-key";
import styles from "./silicon-page.module.css";

type Tab = "access" | "settings";
const TABS: Tab[] = ["access", "settings"];

/** What the Silicon is doing now, when it is anything but plainly in your care. */
function statusOf(silicon: ManagedSilicon): { tone: "warning" | "info" | "success"; text: string } {
  if (silicon.status === "pending_custodian") return { tone: "warning", text: "Waiting for a custodian" };
  if (silicon.pending_transfer) return { tone: "info", text: "Handing over" };
  return { tone: "success", text: "Active" };
}

export function SiliconPage({ uuid }: { uuid: string }) {
  const me = useMe();
  const carbon = asCarbon(me.data);
  const silicons = useEverySilicon();
  const reveals = usePendingReveals();
  const now = useNow(30_000);
  const params = useSearchParams();
  const router = useRouter();
  const silicon = silicons.data?.items.find(item => item.uuid === uuid || item.id === uuid);
  const asked = params.get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(asked && TABS.includes(asked) ? asked : "access");
  const parent = { label: "Silicons", href: paths.silicons };

  const shell = (title: string, body: ReactNode) => (
    <div>
      <PageBar parent={parent} title={title} />
      <Page>{body}</Page>
    </div>
  );

  if ((silicons.error && !silicons.data) || (me.error && !me.data)) {
    return shell("Silicon", (
      <Alert tone="danger" title="This Silicon did not load">
        {describeError(silicons.error ?? me.error)}
        <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void silicons.refetch()}>Try Again</Button></span>
      </Alert>
    ));
  }
  if (!silicons.data || !carbon) return shell("Silicon", <div className={styles.skeleton} aria-busy="true" aria-label="Loading the Silicon"><Skeleton label="Loading" lines={6} avatar /></div>);
  if (!silicon) {
    return shell("Silicon", (
      <EmptyState
        title="No Silicon here"
        description="It may have been deleted or handed to another Carbon, or it was never in your care."
        action={<ButtonLink href={paths.silicons} variant="secondary" size="sm">Your Silicons</ButtonLink>}
      />
    ));
  }

  const status = statusOf(silicon);
  const mine = reveals.filter(item => item.silicon === silicon.uuid);
  const choose = (next: string) => {
    setTab(next as Tab);
    router.replace(`?tab=${next}`, { scroll: false });
  };

  return shell(silicon.display_name || silicon.id || "Silicon", (
    <>
      <div className={styles.intro}>
        <SiliconMark seed={silicon.uuid} size={40} />
        <span className={styles.introText}>
          <span className={styles.introTitle}><span className="mono">{silicon.id ?? silicon.uuid}</span><Badge size="sm" tone={status.tone}>{status.text}</Badge></span>
          <span className={styles.introLine}>In your care since {formatDate(silicon.created_at, me.data?.timezone)}</span>
        </span>
      </div>
      {mine.length ? (
        <div className={styles.reveals} data-page-reveals="">
          {mine.map(reveal => <SecretReveal key={reveal.id} revealId={reveal.id} title={reveal.title} description={reveal.description} secrets={reveal.secrets} onDone={() => dismissReveal(reveal.id)} focusOnMount />)}
        </div>
      ) : null}
      <Tabs value={tab} onValueChange={choose} className={styles.tabs}>
        <TabsList aria-label={`${silicon.display_name || "The Silicon"}'s settings`}>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="access">
          <SecretKey silicon={silicon} now={now} />
          <WebhookSection silicon={silicon} />
        </TabsContent>
        <TabsContent value="settings">
          <About silicon={silicon} me={carbon} now={now} />
          <DeleteSection silicon={silicon} onDeleted={gone => { dismissRevealsOf(gone); router.push(paths.silicons); }} />
        </TabsContent>
      </Tabs>
    </>
  ));
}

/* Shared: a dialog that asks or takes one input, on the dialog rules ------------------------------------------------- */

function Ask({ open, onClose, busy, title, description, children }: { open: boolean; onClose: () => void; busy?: boolean; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}>
      {open ? <DialogContent title={title} description={description}>{children}</DialogContent> : null}
    </Dialog>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}

const idOf = (silicon: ManagedSilicon) => silicon.id ?? silicon.uuid;

/* Access: the secret key --------------------------------------------------------------------------------------------- */

function SecretKey({ silicon, now }: { silicon: ManagedSilicon; now: number }) {
  const [open, setOpen] = useState(false);
  const made = stkRotatedAt(silicon) ?? silicon.created_at;
  return (
    <Section id="silicon-key" title="Secret key">
      <Row lead={<Tile><KeyRound size={16} strokeWidth={2} /></Tile>} title={<span className="mono">stk-••••••••••••</span>} detail={<>Made <Strong>{formatRelative(made, now)}</Strong></>}>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Change</Button>
        <ChangeKeyDialog silicon={silicon} open={open} onClose={() => setOpen(false)} />
      </Row>
    </Section>
  );
}

/* Access: the webhook ------------------------------------------------------------------------------------------------ */

function urlProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter the URL the Silicon receives events at.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `\u201c${value}\u201d isn\u2019t a full URL. Start it with https://, for example https://scout.example/hooks/accounts.`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `A webhook URL starts with https:// (this one starts with ${url.protocol}//).`;
  return null;
}

function WebhookSection({ silicon }: { silicon: ManagedSilicon }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const setWebhook = useSetSiliconWebhookOnce();
  const removeWebhook = useRemoveSiliconWebhookSettled();
  const id = idOf(silicon);
  const current = silicon.webhook_url;
  const close = () => { setEditing(false); setRemoving(false); setError(null); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const problem = urlProblem(url);
    if (problem) return setError(problem);
    setError(null);
    try {
      const answer = await setWebhook.run({ uuid: silicon.uuid, url: url.trim() });
      close();
      addReveal({
        silicon: silicon.uuid,
        origin: "webhook",
        title: `${id}\u2019s webhook signing secret`,
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
      close();
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  return (
    <Section id="silicon-webhook" title="Webhook">
      <Row lead={<Tile><Webhook size={16} strokeWidth={2} /></Tile>} title={current ?? "Not set"} detail={current ? "Signed events about its own account" : "Where Silicon Accounts tells it about its own account"} wide={!!current}>
        {current ? <Button variant="secondary" size="sm" onClick={() => setRemoving(true)}>Remove</Button> : null}
        <Button variant="secondary" size="sm" onClick={() => { setUrl(current ?? ""); setEditing(true); }}>{current ? "Change" : "Set"}</Button>
        <Ask open={editing} onClose={close} busy={setWebhook.isPending} title={current ? "Change the webhook" : "Set a webhook"} description={<>Where Silicon Accounts tells <strong>{id}</strong> about its own account: id and detail changes, key changes and handovers. Every event is signed.</>}>
          <form className={styles.form} onSubmit={event => void save(event)} noValidate>
            <Input label="Webhook URL" type="url" inputMode="url" placeholder="https://scout.example/hooks/accounts" value={url} onChange={event => { setUrl(event.target.value); setError(null); }} error={error ?? undefined} autoComplete="off" spellCheck={false} autoFocus description="A new signing secret is made and shown to you once." />
            <Actions>
              <Button type="button" variant="ghost" onClick={close} disabled={setWebhook.isPending}>Cancel</Button>
              <Button type="submit" loading={setWebhook.isPending}>{current ? "Save" : "Set Webhook"}</Button>
            </Actions>
          </form>
        </Ask>
        <Ask open={removing} onClose={close} busy={removeWebhook.isPending} title="Remove the webhook?" description={<><strong>{id}</strong> stops getting events about its own account.</>}>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <Actions>
            <Button variant="ghost" onClick={close} disabled={removeWebhook.isPending}>Cancel</Button>
            <Button variant="danger" loading={removeWebhook.isPending} onClick={() => void remove()}>Remove</Button>
          </Actions>
        </Ask>
      </Row>
    </Section>
  );
}

/* Settings: About ---------------------------------------------------------------------------------------------------- */

type Editing = "name" | "id" | "timezone" | "photo" | "handover" | "cancel" | null;

function About({ silicon, me, now }: { silicon: ManagedSilicon; me: CarbonMe; now: number }) {
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState(silicon.display_name);
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateSilicon();
  const upload = useUploadSiliconPhoto();
  const defaultPhoto = useSiliconDefaultPhoto();
  const changeId = useChangeSiliconIdInForm();
  const start = useStartTransfer();
  const cancelTransfer = useCancelTransferSettled();
  const id = idOf(silicon);
  const ownPhoto = isDefaultPhoto(silicon.pfp_url) ? null : silicon.pfp_url;
  const transfer = silicon.pending_transfer;
  const left = msUntil(transfer?.expires_at, now);
  const close = () => { setEditing(null); setError(null); };
  const save = (patch: { display_name?: string; timezone?: string; pfp_url?: string | null }) => update.mutateAsync({ uuid: silicon.uuid, patch });

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    if (!next) return setError("Enter a name.");
    if (next.length > 100) return setError(`A name can be at most 100 characters (this one has ${next.length}).`);
    try {
      await save({ display_name: next });
      close();
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  const sendHandover = async (event: FormEvent) => {
    event.preventDefault();
    const target = recipient(to, me);
    if ("problem" in target) return setError(target.problem);
    setError(null);
    try {
      const request = await start.mutateAsync({ uuid: silicon.uuid, to: target.to });
      start.settle(silicon.uuid, request, target.to);
      setTo("");
      close();
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  const cancel = async () => {
    setError(null);
    try {
      await cancelTransfer.mutateAsync(silicon.uuid);
      close();
    } catch (raw) {
      setError(describeError(raw));
    }
  };

  return (
    <Section id="silicon-about" title="About">
      <Row lead={<Avatar name={silicon.display_name} src={silicon.pfp_url} size="sm" />} title="Name" detail={silicon.display_name}>
        <Button variant="secondary" size="sm" onClick={() => { setName(silicon.display_name); setEditing("name"); }}>Edit</Button>
      </Row>
      <Row lead={<Tile><UserRound size={16} strokeWidth={2} /></Tile>} title="Id" detail={<span className="mono">{silicon.id ?? "No id yet"}</span>}>
        <Button variant="secondary" size="sm" onClick={() => setEditing("id")}>Change</Button>
      </Row>
      <Row lead={<Tile><Clock size={16} strokeWidth={2} /></Tile>} title="Timezone" detail={`${timezoneLabel(silicon.timezone)} · UTC${utcOffset(silicon.timezone)}`}>
        <Button variant="secondary" size="sm" onClick={() => setEditing("timezone")}>Change</Button>
      </Row>
      <Row lead={<Tile><ImageUp size={16} strokeWidth={2} /></Tile>} title="Photo" detail={ownPhoto ? "A photo of its own" : "The default photo"}>
        <Button variant="secondary" size="sm" onClick={() => setEditing("photo")}>Change</Button>
      </Row>
      <Row
        lead={<Avatar name={me.display_name} src={me.pfp_url} size="sm" />}
        title="Looked after by you"
        detail={transfer
          ? <>Handing over to <Strong>{personLabel(transfer.to)}</Strong> · {left > 0 ? `${spanText(left)} left to accept` : "the request has expired"}</>
          : "Hand it to another Carbon; they have 14 days to accept"}
      >
        {transfer
          ? <Button variant="secondary" size="sm" onClick={() => setEditing("cancel")}>Cancel Handover</Button>
          : <Button variant="secondary" size="sm" onClick={() => { setTo(""); setEditing("handover"); }}>Hand Over</Button>}
      </Row>

      <Ask open={editing === "name"} onClose={close} busy={update.isPending} title="Name" description={<>Apps show <strong>{silicon.display_name}</strong> wherever {id} appears.</>}>
        <form className={styles.form} onSubmit={event => void saveName(event)} noValidate>
          <Input label="Its name" value={name} maxLength={100} autoFocus autoComplete="off" onChange={event => { setName(event.target.value); setError(null); }} description="Up to 100 characters." error={error ?? undefined} />
          <Actions>
            <Button type="button" variant="ghost" onClick={close} disabled={update.isPending}>Cancel</Button>
            <Button type="submit" loading={update.isPending} disabled={!name.trim()}>Save</Button>
          </Actions>
        </form>
      </Ask>
      <Ask open={editing === "id"} onClose={close} title="Its id" description={silicon.id ? <>Its id is <strong>{silicon.id}</strong>. It&rsquo;s how people and apps find it.</> : "Pick the id people and apps will type to find it."}>
        <IdChangeForm prefix="si:" currentId={silicon.id} uuid={silicon.uuid} subject="silicon" autoFocus submit={next => changeId.mutateAsync({ uuid: silicon.uuid, id: next })} onChanged={close} onCancel={close} />
      </Ask>
      <Ask open={editing === "timezone"} onClose={close} title="Timezone" description={<>Apps show times to <strong>{id}</strong> in this timezone.</>}>
        <TimezoneForm value={silicon.timezone} onSave={timezone => save({ timezone })} onDone={close} autoFocus />
      </Ask>
      <Ask open={editing === "photo"} onClose={close} title="Photo" description={<>Apps show it next to <strong>{silicon.display_name}</strong>. Upload one, or use a link.</>}>
        <div className={styles.form}>
          <FileUpload
            label="Upload a photo"
            description="A PNG, JPEG, WebP or GIF, up to 2 MB."
            accept={PHOTO_ACCEPT}
            maxSize={PHOTO_MAX_BYTES}
            onUpload={async file => {
              const problem = photoProblem(file);
              if (problem) throw new Error(problem);
              await upload.mutateAsync({ uuid: silicon.uuid, file });
              close();
            }}
          />
          <PhotoUrlForm value={ownPhoto} name={silicon.display_name} onSave={url => save({ pfp_url: url })} onDone={close} />
          {ownPhoto ? (
            <Button variant="link" size="sm" className={styles.start} loading={defaultPhoto.isPending} onClick={() => void defaultPhoto.mutateAsync(silicon.uuid).then(close, raw => setError(describeError(raw)))}>Use the Default Photo</Button>
          ) : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </div>
      </Ask>
      <Ask open={editing === "handover"} onClose={close} busy={start.isPending} title={`Hand ${id} over`} description="The Carbon you name looks after it once they accept. Until then nothing changes.">
        <form className={styles.form} onSubmit={event => void sendHandover(event)} noValidate>
          <Input label="Their CarbonID or email" placeholder="c:id or email" value={to} autoFocus autoComplete="off" spellCheck={false} autoCapitalize="off" onChange={event => { setTo(event.target.value); setError(null); }} error={error ?? undefined} description="They have 14 days to accept." />
          <Actions>
            <Button type="button" variant="ghost" onClick={close} disabled={start.isPending}>Cancel</Button>
            <Button type="submit" loading={start.isPending}>Send Request</Button>
          </Actions>
        </form>
      </Ask>
      <Ask open={editing === "cancel"} onClose={close} busy={cancelTransfer.isPending} title="Cancel the handover?" description={transfer ? <><strong>{personLabel(transfer.to)}</strong> can no longer accept, and you keep looking after {id}.</> : undefined}>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <Actions>
          <Button variant="ghost" onClick={close} disabled={cancelTransfer.isPending}>Keep It</Button>
          <Button variant="danger" loading={cancelTransfer.isPending} onClick={() => void cancel()}>Cancel Handover</Button>
        </Actions>
      </Ask>
    </Section>
  );
}

/* Settings: Delete --------------------------------------------------------------------------------------------------- */

function DeleteSection({ silicon, onDeleted }: { silicon: ManagedSilicon; onDeleted: (uuid: string) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = useDeleteSiliconSettled();
  const id = idOf(silicon);
  const run = async () => {
    setError(null);
    const uuid = silicon.uuid;
    try {
      await remove.mutateAsync({ uuid, confirm: silicon.id ?? uuid });
      setOpen(false);
      remove.settle(uuid);
      onDeleted(uuid);
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  return (
    <Section id="silicon-delete" label="Delete this Silicon">
      <Row lead={<Tile><Trash2 size={16} strokeWidth={2} /></Tile>} title="Delete this Silicon" detail={"It\u2019s signed out everywhere. Its id is held for 10 days."}>
        <Button variant="danger" size="sm" onClick={() => setOpen(true)}>Delete</Button>
        <Ask open={open} onClose={() => { setOpen(false); setError(null); }} busy={remove.isPending} title={`Delete ${id}?`} description={<>Its account ends: it&rsquo;s signed out everywhere, every app it signed into is told, and <strong>{id}</strong> is held for 10 days. This can&rsquo;t be undone.</>}>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <Actions>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={remove.isPending}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => void run()}>Delete {silicon.display_name || "It"}</Button>
          </Actions>
        </Ask>
      </Row>
    </Section>
  );
}
