"use client";

/**
 * /privacy/delete, Delete your account, built from /__delete's design H (Anil, 2026-11-12: "Yes, build H"). One box:
 *
 *   Before you delete             every Silicon you look after, handed over or deleted right here (a handover waits for
 *                                 the other Carbon, and still counts until they accept), and requests waiting for you
 *                                 (deleting turns them down)
 *   (an inset line)
 *   What you'll lose access to    each app, permissions between apps, devices, emails, phones and Google or Apple
 *                                 links, and the CarbonID
 *   (an inset line)
 *   the 30 days to change your mind (only once the API keeps deleted accounts: RECOVERY_DAYS), then how many checks
 *   are left beside Delete Account, which asks for the CarbonID typed.
 *
 * Deleting is immediate and final until the API ships recovery (redesign/api-gaps.md #11, decisions.md 2026-11-12), so
 * with RECOVERY_DAYS null the page says what is true today: no recovery card, and the CarbonID held for 10 days.
 */
import { useState, type FormEvent } from "react";
import { AtSign, Check, Cpu, Inbox, Laptop, Link2, RotateCcw } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { Input } from "@teamofsilicons/silicon-ui/input";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { ButtonLink } from "@/components/foundation/button-link";
import { Page } from "@/components/foundation/layout/layout";
import { ApiError } from "@/lib/api/errors";
import { DELETED_ID_KEY } from "@/lib/deleted-account";
import type { CarbonMe, CustodianRequest, ManagedSilicon, MyApp } from "@/lib/api/types";
import { formatDate, plural } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useDeleteAccount } from "@/lib/query/account";
import { useMe } from "@/lib/query/session";
import { AppMark } from "../parts/app-mark";
import { withAppIcon } from "../parts/app-icons";
import { asCarbon, asSilicon, describeError, msUntil, personLabel, spanText, useNow } from "../parts/common";
import { recipient } from "../parts/handover";
import { PageBar } from "../parts/page-bar";
import { OrgCloses } from "./privacy";
import {
  useCancelTransferSettled,
  useDeleteSiliconSettled,
  useEveryApp,
  useEveryCustodianRequest,
  useEveryProof,
  useEverySession,
  useEverySilicon,
  useSetMeView,
  useStartTransfer,
} from "../parts/queries";
import { Row, Tile } from "../parts/rows";
import { SiliconMark } from "../parts/silicon-mark";
import { requestHref } from "../silicons/request-page";
import styles from "./delete-page.module.css";

/**
 * Days a deleted account can still be brought back by signing in. null until the API keeps deleted accounts (today
 * DELETE /v1/me is final); then 30, and the page shows the card and holds the CarbonID for as long.
 */
const RECOVERY_DAYS: number | null = null;
/** How long a CarbonID is held after deletion today (UNDERSTANDING.md: an old id stays reserved for 10 days). */
const ID_HELD_DAYS = 10;

const nameOf = (silicon: Pick<ManagedSilicon, "display_name" | "id">) => silicon.display_name || silicon.id || "A Silicon";
const listJoin = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * The account is gone and its session with it: leave for /goodbye with a full load (nothing about the account stays in
 * memory), the CarbonID left in this tab's session storage for it to name, never in the address.
 */
function leaveDeletedAccount(id: string): void {
  try {
    window.sessionStorage.setItem(DELETED_ID_KEY, id);
  } catch {
    // Private windows may refuse storage: the page then says it without the CarbonID.
  }
  window.location.replace(paths.goodbye);
}

export function DeletePage() {
  const me = useMe();
  const silicons = useEverySilicon();
  const apps = useEveryApp();
  const sessions = useEverySession();
  const proofs = useEveryProof();
  const requests = useEveryCustodianRequest();
  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);
  const failed = [me, silicons, apps, sessions].find(query => query.error && !query.data);
  const ready = me.data && (silicon || (silicons.data && apps.data && sessions.data));

  return (
    <div>
      <PageBar parent={{ label: "Data & Privacy", href: paths.privacy }} title="Delete your account" />
      <Page>
        {failed ? (
          <Alert tone="danger" title="This page did not load">
            {describeError(failed.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void failed.refetch()}>Try Again</Button></span>
          </Alert>
        ) : !ready ? (
          <div className={styles.skeleton} aria-busy="true" aria-label="Loading"><Skeleton label="Loading" lines={6} avatar /></div>
        ) : me.data?.org ? (
          <p className={styles.lead}><OrgCloses org={me.data.org} /></p>
        ) : silicon ? (
          <p className={styles.lead}>{silicon.custodian?.id ?? "Your custodian"} deletes this Silicon&rsquo;s account, from their Silicons page.</p>
        ) : carbon ? (
          <DeleteChecks
            carbon={carbon}
            silicons={silicons.data?.items ?? []}
            apps={(apps.data?.items ?? []).filter(item => item.status !== "access_removed")}
            devices={sessions.data?.items.length ?? 0}
            proofs={(proofs.data?.items ?? []).filter(item => item.status === "active").length}
            requests={requests.data?.items ?? []}
          />
        ) : null}
      </Page>
    </div>
  );
}

function DeleteChecks({ carbon, silicons, apps, devices, proofs, requests }: { carbon: CarbonMe; silicons: ManagedSilicon[]; apps: MyApp[]; devices: number; proofs: number; requests: CustodianRequest[] }) {
  const now = useNow(60_000);
  const left = silicons.length;
  const id = carbon.id ?? carbon.uuid;
  const contact = [
    carbon.emails.length ? plural(carbon.emails.length, "email") : null,
    carbon.phones.length ? plural(carbon.phones.length, "phone number") : null,
    carbon.identities.length ? plural(carbon.identities.length, "Google or Apple link") : null,
  ].filter((part): part is string => !!part);

  return (
    <>
      <p className={styles.lead}>Check what&rsquo;s left to do, and what you&rsquo;ll lose, before you go.</p>
      <section data-sq="surface" className={styles.box} aria-label="Delete your account">
        <div className={styles.head}>
          <div className={styles.titleRow}>
            <h2 id="delete-before" className={styles.title}>Before you delete</h2>
            {left ? <Badge size="sm" tone="neutral">{left}</Badge> : null}
          </div>
          {left ? <p className={styles.line}>Every Silicon needs someone looking after it.</p> : null}
        </div>
        <ul className={styles.list} aria-labelledby="delete-before">
          {silicons.map(item => <SiliconCheck key={item.uuid} silicon={item} carbon={carbon} now={now} />)}
          {left ? null : (
            <Row lead={<span className={styles.done} aria-hidden="true"><Check size={14} strokeWidth={2} /></span>} title="No Silicons in your care" detail="Nothing stops you from deleting your account" />
          )}
          {requests.map(request => {
            const name = nameOf(request.silicon);
            return (
              <Row key={request.id} lead={<Tile><Inbox size={16} strokeWidth={2} /></Tile>} title={request.kind === "transfer" ? `${personLabel(request.from)} is handing ${name} to you` : `${name} wants you to look after it`} detail="Deleting your account turns this down">
                <ButtonLink href={requestHref(request.id)} variant="secondary" size="sm">Review</ButtonLink>
              </Row>
            );
          })}
        </ul>

        <div className={styles.head} data-ruled="">
          <h2 id="delete-lose" className={styles.title}>What you&rsquo;ll lose access to</h2>
        </div>
        <ul className={styles.list} aria-labelledby="delete-lose">
          {apps.map(item => (
            <Row key={item.membership_id} lead={<AppMark app={withAppIcon(item.app)} size={28} className={styles.mark} decorative />} title={item.app.name} detail={"Signs you out and is told you’ve left"} />
          ))}
          {proofs ? <Row lead={<Tile><Link2 size={16} strokeWidth={2} /></Tile>} title={`${plural(proofs, "permission")} between apps`} detail="End, so no app can act for you" /> : null}
          <Row lead={<Tile><Laptop size={16} strokeWidth={2} /></Tile>} title={plural(devices, "signed-in device")} detail="All signed out, this one too" />
          {contact.length ? <Row lead={<Tile><AtSign size={16} strokeWidth={2} /></Tile>} title={listJoin(contact)} detail={"Can’t sign you in anymore"} /> : null}
          <Row
            lead={<Tile><Cpu size={16} strokeWidth={2} /></Tile>}
            title={<>Your CarbonID <strong className="mono">{id}</strong></>}
            detail={RECOVERY_DAYS ? `Kept for you for ${RECOVERY_DAYS} days` : `Held for ${ID_HELD_DAYS} days, then anyone can take it`}
          />
        </ul>

        <Foot carbon={carbon} silicons={silicons} now={now} />
      </section>
    </>
  );
}

/* A Silicon to settle ------------------------------------------------------------------------------------------------- */

type Asking = "handover" | "delete" | "cancel" | null;

function SiliconCheck({ silicon, carbon, now }: { silicon: ManagedSilicon; carbon: CarbonMe; now: number }) {
  const [asking, setAsking] = useState<Asking>(null);
  const [to, setTo] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const start = useStartTransfer();
  const cancelTransfer = useCancelTransferSettled();
  const remove = useDeleteSiliconSettled();
  const name = nameOf(silicon);
  const id = silicon.id ?? silicon.uuid;
  const transfer = silicon.pending_transfer;
  const busy = start.isPending || cancelTransfer.isPending || remove.isPending;
  const open = (next: Asking) => { setError(null); setTo(""); setTyped(""); setAsking(next); };
  const close = () => { if (!busy) setAsking(null); };

  const sendHandover = async (event: FormEvent) => {
    event.preventDefault();
    const target = recipient(to, carbon);
    if ("problem" in target) return setError(target.problem);
    setError(null);
    try {
      const request = await start.mutateAsync({ uuid: silicon.uuid, to: target.to });
      start.settle(silicon.uuid, request, target.to);
      setAsking(null);
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  const cancel = async () => {
    setError(null);
    try {
      await cancelTransfer.mutateAsync(silicon.uuid);
      setAsking(null);
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  const deleteIt = async (event: FormEvent) => {
    event.preventDefault();
    if (typed !== id) return;
    setError(null);
    try {
      await remove.mutateAsync({ uuid: silicon.uuid, confirm: id });
      setAsking(null);
      remove.settle(silicon.uuid);
    } catch (raw) {
      setError(describeError(raw));
    }
  };

  return (
    <Row
      lead={<SiliconMark seed={silicon.uuid} size={28} />}
      title={transfer ? `${name} is going to ${personLabel(transfer.to)}` : `${name} needs a new home`}
      detail={transfer ? `Waiting for them to accept · ${spanText(msUntil(transfer.expires_at, now))} left` : "Hand it to someone, or delete it"}
      wide
    >
      {transfer ? (
        <Button variant="secondary" size="sm" onClick={() => open("cancel")}>Cancel Handover</Button>
      ) : (
        <>
          <Button variant="secondary" size="sm" onClick={() => open("handover")} aria-label={`Hand Over ${name}`}>Hand Over</Button>
          <Button variant="secondary" size="sm" onClick={() => open("delete")} aria-label={`Delete ${name}`}>Delete</Button>
        </>
      )}
      <Dialog open={asking !== null} onOpenChange={next => { if (!next) close(); }}>
        {asking === "handover" ? (
          <DialogContent title={`Hand ${id} over`} description="The Carbon you name looks after it once they accept. Until then nothing changes.">
            <form className={styles.form} onSubmit={event => void sendHandover(event)} noValidate>
              <Input label="Their CarbonID or email" placeholder="c:id or email" value={to} autoFocus autoComplete="off" spellCheck={false} autoCapitalize="off" onChange={event => { setTo(event.target.value); setError(null); }} error={error ?? undefined} description="They have 14 days to accept." />
              <div className={styles.actions}>
                <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
                <Button type="submit" loading={start.isPending}>Send Request</Button>
              </div>
            </form>
          </DialogContent>
        ) : asking === "delete" ? (
          <DialogContent title={`Delete ${id}?`} description={<>Its account ends: it&rsquo;s signed out everywhere, every app it signed into is told, and <strong>{id}</strong> is held for 10 days. This can&rsquo;t be undone.</>}>
            <form className={styles.form} onSubmit={event => void deleteIt(event)} noValidate>
              <Input label={`Type ${id} to confirm`} value={typed} autoFocus autoComplete="off" spellCheck={false} autoCapitalize="off" onChange={event => { setTyped(event.target.value); setError(null); }} error={error ?? undefined} />
              <div className={styles.actions}>
                <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
                <Button type="submit" variant="danger" loading={remove.isPending} disabled={typed !== id}>Delete {name}</Button>
              </div>
            </form>
          </DialogContent>
        ) : asking === "cancel" ? (
          <DialogContent title="Cancel the handover?" description={transfer ? <><strong>{personLabel(transfer.to)}</strong> can no longer accept, and you keep looking after {id}.</> : undefined}>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.actions}>
              <Button variant="ghost" onClick={close} disabled={busy}>Keep It</Button>
              <Button variant="danger" loading={cancelTransfer.isPending} onClick={() => void cancel()}>Cancel Handover</Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </Row>
  );
}

/* The foot: the 30 days (once there are), then where the checks stand and Delete Account ------------------------------ */

function Foot({ carbon, silicons, now }: { carbon: CarbonMe; silicons: ManagedSilicon[]; now: number }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const remove = useDeleteAccount();
  const view = useSetMeView();
  const id = carbon.id ?? carbon.uuid;
  const left = silicons.length;
  const waiting = silicons.filter(item => item.pending_transfer);
  const todo = silicons.filter(item => !item.pending_transfer);
  const busy = remove.isPending || done;
  const status = !left ? null
    : todo.length
      ? `${listJoin(todo.map(nameOf))} ${todo.length === 1 ? "needs" : "need"} a new home${waiting.length ? `, and ${listJoin(waiting.map(nameOf))} ${waiting.length === 1 ? "is" : "are"} waiting for ${waiting.length === 1 ? personLabel(waiting[0]!.pending_transfer?.to) : "a reply"}` : ""}`
      : `Waiting for ${listJoin(waiting.map(item => `${personLabel(item.pending_transfer?.to)} to accept ${nameOf(item)}`))}`;

  const close = () => { if (busy) return; setOpen(false); setTyped(""); setError(null); };
  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (typed !== id || busy) return;
    setError(null);
    try {
      await remove.mutateAsync(id);
      setDone(true);
      window.setTimeout(() => leaveDeletedAccount(id), 600);
    } catch (raw) {
      const failure = ApiError.from(raw);
      // A Silicon came into this Carbon's care since the page loaded: the checks show it once the account is read again.
      if (failure.code === "custodian_of_silicons") void view.refresh();
      setError(describeError(failure));
    }
  };

  return (
    <div className={styles.foot}>
      {RECOVERY_DAYS ? (
        <div data-sq="surface" className={styles.recover}>
          <span className={styles.recoverIcon} aria-hidden="true"><RotateCcw size={16} strokeWidth={2} /></span>
          <span className={styles.recoverText}>
            <span className={styles.recoverTitle}>Changed your mind? You have {RECOVERY_DAYS} days.</span>
            <span className={styles.recoverLine}>Sign in before <strong>{formatDate(now + RECOVERY_DAYS * 86_400_000, carbon.timezone)}</strong> and everything comes back as it was.</span>
          </span>
        </div>
      ) : null}
      <div className={styles.action}>
        <span className={styles.status} role="status">
          {left ? (
            <>
              <span className={styles.track} aria-hidden="true">
                {silicons.map(item => <span key={item.uuid} data-sq="surface" className={styles.segment} data-state={item.pending_transfer ? "waiting" : "todo"} />)}
              </span>
              <span className={styles.statusText}>
                <span className={styles.statusTitle}>{left} left before you can delete</span>
                <span className={styles.statusLine}>{status}</span>
              </span>
            </>
          ) : (
            <>
              <span className={styles.ready} aria-hidden="true"><Check size={14} strokeWidth={2} /></span>
              <span className={styles.statusText}>
                <span className={styles.statusTitle}>All done</span>
                <span className={styles.statusLine}>You can delete your account now</span>
              </span>
            </>
          )}
        </span>
        <Button variant="danger" disabled={left > 0} onClick={() => setOpen(true)}>Delete Account</Button>
      </div>
      <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
        {open ? (
          <DialogContent title="Delete your account?" description={RECOVERY_DAYS ? <>Sign in within {RECOVERY_DAYS} days to get it back.</> : <>This can&rsquo;t be undone.</>}>
            <form className={styles.form} onSubmit={event => void run(event)} noValidate>
              <p className={styles.dialogText}>You lose access to everything on this page.</p>
              <Input label={`Type ${id} to confirm`} value={typed} autoFocus autoComplete="off" spellCheck={false} autoCapitalize="off" onChange={event => { setTyped(event.target.value); setError(null); }} error={error ?? undefined} />
              <div className={styles.actions}>
                <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
                <Button type="submit" variant="danger" loading={busy} disabled={typed !== id}>Delete Account</Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
