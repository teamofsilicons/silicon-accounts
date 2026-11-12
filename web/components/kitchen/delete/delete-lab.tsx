"use client";

/**
 * /__delete: Data & privacy's Delete account as built (Now), beside three other designs (Anil, 2026-11-12: "can we
 * design delete account better? 3 alternative designs"). All four read your real account (Silicons, apps, devices,
 * emails); "Preview as" shows each one blocked (your Silicons) or free to delete. NOTHING HERE DELETES: the dialog's
 * Delete Account only closes it.
 *
 *   Now          one row: blocked says "Hand over or delete your 2 Silicons first" and Go to Silicons
 *   A · Blockers each Silicon that blocks you, by name, each opening its Settings; the rule said once
 *   B · Checklist what has to be true first, ticked off as it becomes true; Delete waits for the last tick
 *   C · What ends what deleting does to your account, counted from it, up front; the blocker above it
 *   D · Checks   (Anil, 2026-11-12: "like checks in the current design; 2 sections, checks, a dividing line, what you'll
 *                lose access to, and that you can recover the account within a month") Security's Checkup rows: each
 *                Silicon to hand over or delete right there, a handover waiting to be accepted, requests waiting for
 *                you; a line; what you lose, counted; the 30-day recovery note; Delete waits for the checks. Recovery is
 *                to be built (Anil, 2026-11-12); today deleting is immediate and final (api-gaps.md #11).
 *   E · One box  D inside one container (Anil, 2026-11-12: "all this inside one container"): Checks, a full-width line,
 *                what you'll lose access to, a line, then the recovery note and Delete at its foot.
 *   G · Airy     E with more room at the sides, the line between Checks and what you lose inset from the edges, and
 *                no lines between rows (Anil, 2026-11-12: "more side padding, a line separating not edge to edge, and
 *                no line between the elements, same in Silicons").
 *   H · Footed   G with its foot redesigned (Anil, 2026-11-12: "better design for the changed your mind, no Needs the API
 *                clip, we'll add the recovery feature; and design the 2 checks left and the Delete button"): the 30 days
 *                as a card with the actual last day, then a bar with one segment per check (amber while a handover
 *                waits), what is left in words, and Delete Account.
 *   F · Compact  E, dense (Anil, 2026-11-12: "a compact version"): one line per Silicon (mark, name, si:id, xs buttons),
 *                what you lose as a two-column list of counts, the note and Delete on one line at the foot.
 */
import { useState, type ReactNode } from "react";
import { AtSign, Check, Circle, Cpu, Inbox, Laptop, LayoutGrid, Link2, RotateCcw, Trash2 } from "lucide-react";
import { AvatarGroup } from "@teamofsilicons/silicon-ui/avatar-group";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { Input } from "@teamofsilicons/silicon-ui/input";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@teamofsilicons/silicon-ui/tabs";
import { ButtonLink } from "@/components/foundation/button-link";
import { withAppIcon } from "@/components/account/parts/app-icons";
import { AppMark } from "@/components/account/parts/app-mark";
import { asCarbon, msUntil, personLabel, spanText } from "@/components/account/parts/common";
import { useEveryApp, useEveryCustodianRequest, useEveryProof, useEverySession, useEverySilicon } from "@/components/account/parts/queries";
import { LinkItem, Row, Section, Tile } from "@/components/account/parts/rows";
import { SiliconMark } from "@/components/account/parts/silicon-mark";
import { requestHref } from "@/components/account/silicons/request-page";
import { siliconHref } from "@/components/account/silicons/silicons";
import type { CarbonMe, CustodianRequest, ManagedSilicon, MyApp } from "@/lib/api/types";
import { formatDate, plural } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useMe } from "@/lib/query/session";
import styles from "./delete-lab.module.css";

type As = "blocked" | "handover" | "free";

interface Facts {
  carbon: CarbonMe;
  id: string;
  silicons: ManagedSilicon[];
  apps: MyApp[];
  devices: number;
  proofs: number;
  requests: CustodianRequest[];
  now: number;
}

const settingsHref = (silicon: ManagedSilicon) => `${siliconHref(silicon)}?tab=settings`;
const nameOf = (silicon: ManagedSilicon) => silicon.display_name || silicon.id || "A Silicon";
const listJoin = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

export function DeleteLab() {
  const me = useMe();
  const silicons = useEverySilicon();
  const apps = useEveryApp();
  const sessions = useEverySession();
  const proofs = useEveryProof();
  const requests = useEveryCustodianRequest();
  const [now] = useState(() => Date.now());
  const [as, setAs] = useState<As>("blocked");
  const carbon = asCarbon(me.data);
  const ready = carbon && silicons.data && apps.data && sessions.data;
  const facts: Facts | null = ready ? {
    carbon,
    id: carbon.id ?? carbon.uuid,
    // "Handover in progress" draws the first Silicon as handed to c:maya 1 day ago (a drawing; nothing is sent).
    silicons: as === "free" ? [] : silicons.data!.items.map((item, index) => as === "handover" && index === 0 && !item.pending_transfer
      ? { ...item, pending_transfer: { id: "drawn", to: { uuid: "drawn", kind: "carbon", id: "c:maya", display_name: "Maya", pfp_url: null, status: "active" }, created_at: new Date(now - 86_400_000).toISOString(), expires_at: new Date(now + 13 * 86_400_000).toISOString() } } as ManagedSilicon
      : item),
    apps: apps.data!.items.filter(item => item.status !== "access_removed"),
    devices: sessions.data!.items.length,
    proofs: (proofs.data?.items ?? []).filter(item => item.status === "active").length,
    requests: as === "free" ? [] : requests.data?.items ?? [],
    now,
  } : null;

  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Delete account designs</h1>
        <p className={styles.lede}>Your real account, four ways. Only Now is built; the others are drawings. Nothing here deletes: Delete Account in the dialog only closes it.</p>
        <SegmentedControl label="Preview as" value={as} onValueChange={value => setAs(value as As)} options={[{ value: "blocked", label: "Looking after Silicons" }, { value: "handover", label: "Handover in progress" }, { value: "free", label: "No Silicons" }]} />
      </header>
      <Tabs defaultValue="h" className={styles.tabs}>
        <TabsList aria-label="Designs">
          <TabsTrigger value="now">Now</TabsTrigger>
          <TabsTrigger value="a">A · Blockers</TabsTrigger>
          <TabsTrigger value="b">B · Checklist</TabsTrigger>
          <TabsTrigger value="c">C · What ends</TabsTrigger>
          <TabsTrigger value="d">D · Checks</TabsTrigger>
          <TabsTrigger value="e">E · One box</TabsTrigger>
          <TabsTrigger value="f">F · Compact</TabsTrigger>
          <TabsTrigger value="g">G · Airy</TabsTrigger>
          <TabsTrigger value="h">H · Footed</TabsTrigger>
        </TabsList>
        {facts ? (
          <>
            <TabsContent value="now"><Frame><Now facts={facts} /></Frame></TabsContent>
            <TabsContent value="a"><Frame><Blockers facts={facts} /></Frame></TabsContent>
            <TabsContent value="b"><Frame><Checklist facts={facts} /></Frame></TabsContent>
            <TabsContent value="c"><Frame><WhatEnds facts={facts} /></Frame></TabsContent>
            <TabsContent value="d"><Checks facts={facts} /></TabsContent>
            <TabsContent value="e"><Checks facts={facts} boxed /></TabsContent>
            <TabsContent value="f"><Compact facts={facts} /></TabsContent>
            <TabsContent value="g"><Checks facts={facts} boxed airy /></TabsContent>
            <TabsContent value="h"><Checks facts={facts} boxed airy footed /></TabsContent>
          </>
        ) : <Skeleton label="Loading" lines={4} avatar />}
      </Tabs>
    </main>
  );
}

/** The page around the design: Data & privacy's What apps see, shortened, so the delete sits where it will. */
function Frame({ children }: { children: ReactNode }) {
  return <div className={styles.page}><p className={styles.context}>Data &amp; privacy · below What apps see</p>{children}</div>;
}

/* The confirmation, shared by every design: what ends, then the CarbonID typed. A drawing: Delete Account only closes. */
function useConfirm(facts: Facts, intro?: ReactNode) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const close = () => { setOpen(false); setTyped(""); };
  const dialog = (
    <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
      {open ? (
        <DialogContent title="Delete your account?" description={<>This can&rsquo;t be undone.</>}>
          <div className={styles.form}>
            {intro ?? (
              <ul className={styles.ends}>
                <li>Every app you signed in to is told and loses access.</li>
                <li>Your emails, phones and Google or Apple links are removed.</li>
                <li>Every sign-in and permission between apps ends.</li>
                <li><strong className="mono">{facts.id}</strong> stays reserved for 10 days.</li>
              </ul>
            )}
            <Input label={`Type ${facts.id} to confirm`} value={typed} autoComplete="off" spellCheck={false} onChange={event => setTyped(event.target.value)} />
            <div className={styles.actions}>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="danger" disabled={typed !== facts.id} onClick={close}>Delete Account</Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
  return { open: () => setOpen(true), dialog };
}

/* Now: the page as built ---------------------------------------------------------------------------------------------- */

function Now({ facts }: { facts: Facts }) {
  const confirm = useConfirm(facts);
  const blocked = facts.silicons.length > 0;
  return (
    <Section id="now-delete" label="Delete account" tone="danger">
      <Row lead={<Tile><Trash2 size={16} strokeWidth={2} /></Tile>} title="Delete account" detail={blocked ? `Hand over or delete your ${plural(facts.silicons.length, "Silicon")} first` : "This can’t be undone"}>
        {blocked ? <ButtonLink href={paths.silicons} variant="secondary" size="sm">Go to Silicons</ButtonLink> : <Button variant="danger" size="sm" onClick={confirm.open}>Delete</Button>}
        {confirm.dialog}
      </Row>
    </Section>
  );
}

/* A: the Silicons that block you, by name ---------------------------------------------------------------------------- */

function Blockers({ facts }: { facts: Facts }) {
  const confirm = useConfirm(facts);
  const blocked = facts.silicons.length > 0;
  return (
    <Section
      id="a-delete"
      title="Delete account"
      tone="danger"
      description={blocked
        ? <>Every Silicon needs someone looking after it. Hand {facts.silicons.length === 1 ? "this one" : "these"} to another Carbon, or delete {facts.silicons.length === 1 ? "it" : "them"}, and then you can delete your account.</>
        : <>Your account ends for good. Apps are told, your sign-ins end, and <strong className="mono">{facts.id}</strong> is held for 10 days.</>}
    >
      {facts.silicons.map(silicon => (
        <LinkItem
          key={silicon.uuid}
          href={settingsHref(silicon)}
          lead={<SiliconMark seed={silicon.uuid} size={28} />}
          title={nameOf(silicon)}
          detail={silicon.pending_transfer ? "Handover waiting to be accepted" : <span className="mono">{silicon.id}</span>}
          end={<span className={styles.endText}>Hand Over or Delete</span>}
        />
      ))}
      <Row lead={<Tile><Trash2 size={16} strokeWidth={2} /></Tile>} title="Delete account" detail={blocked ? `Waiting on ${plural(facts.silicons.length, "Silicon")}` : "This can’t be undone"}>
        <Button variant="danger" size="sm" disabled={blocked} onClick={confirm.open}>Delete</Button>
        {confirm.dialog}
      </Row>
    </Section>
  );
}

/* B: what has to be true first, ticked off --------------------------------------------------------------------------- */

function Step({ done, title, detail, children }: { done: boolean; title: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <Row
      lead={<span className={styles.step} data-done={done ? "" : undefined} aria-hidden="true">{done ? <Check size={14} strokeWidth={2.5} /> : <Circle size={14} strokeWidth={2} />}</span>}
      title={<span className={done ? styles.doneTitle : undefined}>{title}</span>}
      detail={detail}
    >
      {children}
    </Row>
  );
}

function Checklist({ facts }: { facts: Facts }) {
  const confirm = useConfirm(facts);
  const left = facts.silicons.length;
  return (
    <Section id="b-delete" title="Delete account" count={left || undefined} tone="danger" description={left ? "Before you can delete your account:" : "Everything is ready. Deleting can’t be undone."}>
      {left ? facts.silicons.map(silicon => (
        <Step key={silicon.uuid} done={false} title={`Hand over or delete ${nameOf(silicon)}`} detail={silicon.pending_transfer ? "Handover sent. It counts once it’s accepted." : "Every Silicon needs someone looking after it"}>
          <ButtonLink href={settingsHref(silicon)} variant="secondary" size="sm">Open</ButtonLink>
        </Step>
      )) : <Step done title="No Silicons in your care" />}
      <Step done title={<>Your CarbonID <strong className="mono">{facts.id}</strong> will be held for 10 days</>} detail="Then anyone can take it" />
      <li className={styles.foot}>
        <Button variant="danger" size="sm" disabled={left > 0} onClick={confirm.open}>Delete Account</Button>
        {left ? <span className={styles.footNote}>{plural(left, "step")} left</span> : null}
        {confirm.dialog}
      </li>
    </Section>
  );
}

/* C: what ends, counted from your account, up front ------------------------------------------------------------------- */

function WhatEnds({ facts }: { facts: Facts }) {
  const blocked = facts.silicons.length > 0;
  const emails = facts.carbon.emails.length;
  const phones = facts.carbon.phones.length;
  const links = facts.carbon.identities.length;
  const contact = [emails ? plural(emails, "email") : null, phones ? plural(phones, "phone") : null, links ? plural(links, "Google or Apple link") : null].filter((part): part is string => !!part);
  const confirm = useConfirm(facts, <p className={styles.dialogText}>Everything listed on the page ends now, and <strong className="mono">{facts.id}</strong> is held for 10 days.</p>);
  return (
    <Section id="c-delete" title="Delete account" tone="danger" description="What deleting your account does:">
      {blocked ? (
        <Row lead={<Tile><Cpu size={16} strokeWidth={2} /></Tile>} title={<>First, hand over or delete {listJoin(facts.silicons.map(nameOf))}</>} detail="Every Silicon needs someone looking after it">
          <ButtonLink href={paths.silicons} variant="secondary" size="sm">Go to Silicons</ButtonLink>
        </Row>
      ) : null}
      <Row
        lead={facts.apps.length ? <AvatarGroup size="sm" max={3} label="Your apps" members={facts.apps.map(item => ({ name: item.app.name, src: withAppIcon(item.app).logo_url ?? undefined }))} /> : <Tile><LayoutGrid size={16} strokeWidth={2} /></Tile>}
        title={facts.apps.length ? `${plural(facts.apps.length, "app")} told, and lose access` : "No app has access"}
        detail={facts.apps.length ? listJoin(facts.apps.map(item => item.app.name)) : undefined}
      />
      <Row lead={<Tile><Laptop size={16} strokeWidth={2} /></Tile>} title={`Signed out of ${plural(facts.devices, "device")}`} detail="Including this one" />
      <Row lead={<Tile><AtSign size={16} strokeWidth={2} /></Tile>} title={contact.length ? `${listJoin(contact)} removed` : "Nothing to remove"} detail="They can be used for a new account" />
      <Row lead={<Tile><Trash2 size={16} strokeWidth={2} /></Tile>} title={<><strong className="mono">{facts.id}</strong> held for 10 days</>} detail={"Then anyone can take it. This can’t be undone."}>
        <Button variant="danger" size="sm" disabled={blocked} onClick={confirm.open}>Delete</Button>
        {confirm.dialog}
      </Row>
    </Section>
  );
}


/* D: checks, a line, what you lose ------------------------------------------------------------------------------------ */

/** A drawn dialog: the Silicon page's words, and buttons that only close. */
function Drawn({ open, onClose, title, description, children, confirm, danger }: { open: boolean; onClose: () => void; title: string; description: ReactNode; children?: ReactNode; confirm: string; danger?: boolean }) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      {open ? (
        <DialogContent title={title} description={description}>
          <div className={styles.form}>
            {children}
            <div className={styles.actions}>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant={danger ? "danger" : "primary"} onClick={onClose}>{confirm}</Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** One Silicon to settle: Hand Over or Delete right here, or, once handed over, waiting for the other Carbon. */
function SiliconCheck({ silicon, now, compact, footed }: { silicon: ManagedSilicon; now: number; compact?: boolean; footed?: boolean }) {
  const [open, setOpen] = useState<"handover" | "delete" | "cancel" | null>(null);
  const [to, setTo] = useState("");
  const name = nameOf(silicon);
  const id = silicon.id ?? silicon.uuid;
  const transfer = silicon.pending_transfer;
  const close = () => { setOpen(null); setTo(""); };
  const size = compact ? "xs" : "sm";
  const buttons = transfer ? (
    <Button variant="secondary" size={size} onClick={() => setOpen("cancel")}>Cancel Handover</Button>
  ) : (
    <>
      <Button variant="secondary" size={size} onClick={() => setOpen("handover")}>Hand Over</Button>
      <Button variant="secondary" size={size} onClick={() => setOpen("delete")}>Delete</Button>
    </>
  );
  const dialogs = (
    <>
      <Drawn open={open === "handover"} onClose={close} title={`Hand ${id} over`} description="The Carbon you name looks after it once they accept. Until then nothing changes." confirm="Send Request">
        <Input label="Their CarbonID or email" placeholder="c:id or email" value={to} autoComplete="off" spellCheck={false} onChange={event => setTo(event.target.value)} description="They have 14 days to accept." />
      </Drawn>
      <Drawn open={open === "delete"} onClose={close} danger title={`Delete ${id}?`} description={<>Its account ends: it&rsquo;s signed out everywhere, every app it signed into is told, and <strong>{id}</strong> is held for 10 days. This can&rsquo;t be undone.</>} confirm={`Delete ${name}`} />
      <Drawn open={open === "cancel"} onClose={close} danger title="Cancel the handover?" description={transfer ? <><strong>{personLabel(transfer.to)}</strong> can no longer accept, and you keep looking after {id}.</> : null} confirm="Cancel Handover" />
    </>
  );
  if (compact) {
    return (
      <li className={styles.cRow}>
        <SiliconMark seed={silicon.uuid} size={20} />
        <span className={styles.cText}>
          <span className={styles.cName}>{name}</span>
          <span className={styles.cMeta}>{transfer ? `waiting for ${personLabel(transfer.to)} · ${spanText(msUntil(transfer.expires_at, now))} left` : <span className="mono">{id}</span>}</span>
        </span>
        <span className={styles.cActions}>{buttons}</span>
        {dialogs}
      </li>
    );
  }
  return (
    <Row
      lead={<SiliconMark seed={silicon.uuid} size={28} />}
      title={footed
        ? (transfer ? `${name} is going to ${personLabel(transfer.to)}` : `${name} needs a new home`)
        : (transfer ? `${name} is waiting for ${personLabel(transfer.to)}` : `Hand over or delete ${name}`)}
      detail={footed
        ? (transfer ? `Waiting for them to accept \u00b7 ${spanText(msUntil(transfer.expires_at, now))} left` : "Hand it to someone, or delete it")
        : (transfer ? `${spanText(msUntil(transfer.expires_at, now))} left to accept. It\u2019s still yours until then.` : "Every Silicon needs someone looking after it")}
      wide
    >
      {buttons}
      {dialogs}
    </Row>
  );
}

function Checks({ facts, boxed, airy, footed }: { facts: Facts; boxed?: boolean; airy?: boolean; footed?: boolean }) {
  const confirm = useConfirm(facts, <p className={styles.dialogText}>You lose access to everything on the page. Sign in within 30 days to get your account back.</p>);
  const left = facts.silicons.length;
  const emails = facts.carbon.emails.length;
  const phones = facts.carbon.phones.length;
  const links = facts.carbon.identities.length;
  const contact = [emails ? plural(emails, "email") : null, phones ? plural(phones, "phone number") : null, links ? plural(links, "Google or Apple link") : null].filter((part): part is string => !!part);
  const checkRows = (
    <>
      {facts.silicons.map(silicon => <SiliconCheck key={silicon.uuid} silicon={silicon} now={facts.now} footed={footed} />)}
      {left ? null : (
        <Row lead={<span className={styles.step} data-done="" aria-hidden="true"><Check size={14} strokeWidth={2.5} /></span>} title="No Silicons in your care" detail="Nothing stops you from deleting your account" />
      )}
      {facts.requests.map(request => {
        const name = request.silicon.display_name || request.silicon.id || "A Silicon";
        return (
          <Row key={request.id} lead={<Tile><Inbox size={16} strokeWidth={2} /></Tile>} title={request.kind === "transfer" ? `${personLabel(request.from)} is handing ${name} to you` : `${name} wants you to look after it`} detail="Deleting your account turns this down">
            <ButtonLink href={requestHref(request.id)} variant="secondary" size="sm">Review</ButtonLink>
          </Row>
        );
      })}
    </>
  );
  const loseRows = (
    <>
      {facts.apps.map(item => (
        <Row key={item.membership_id} lead={<AppMark app={withAppIcon(item.app)} size={28} className={styles.mark} decorative />} title={item.app.name} detail={footed ? "Signs you out and is told you\u2019ve left" : "You\u2019re signed out, and it\u2019s told your account is gone"} />
      ))}
      {facts.proofs ? <Row lead={<Tile><Link2 size={16} strokeWidth={2} /></Tile>} title={`${plural(facts.proofs, "permission")} between apps`} detail={footed ? "End, so no app can act for you" : "They end, and the apps can no longer act for you"} /> : null}
      <Row lead={<Tile><Laptop size={16} strokeWidth={2} /></Tile>} title={plural(facts.devices, "signed-in device")} detail={footed ? "All signed out, this one too" : "Every one is signed out, this one too"} />
      {contact.length ? <Row lead={<Tile><AtSign size={16} strokeWidth={2} /></Tile>} title={listJoin(contact)} detail={footed ? "Can\u2019t sign you in anymore" : "They stop signing you in"} /> : null}
      <Row lead={<Tile><Cpu size={16} strokeWidth={2} /></Tile>} title={<>Your CarbonID <strong className="mono">{facts.id}</strong></>} detail={footed ? "Kept for you for 30 days" : "Held for you while you can still come back"} />
    </>
  );
  const recover = (
    <p className={styles.recover}>
      <span className={styles.recoverLabel}>Changed your mind?</span> Sign in within 30 days to get your account back. After that it&rsquo;s gone for good.
    </p>
  );
  const deleteBar = (
    <div className={styles.deleteBar}>
      <Button variant="danger" disabled={left > 0} onClick={confirm.open}>Delete Account</Button>
      {left ? <span className={styles.footNote}>{plural(left, "check")} left</span> : null}
      {confirm.dialog}
    </div>
  );

  if (boxed) {
    return (
      <div className={styles.page}>
        <p className={styles.context}>A page of its own, /privacy/delete, opened from Data &amp; privacy&rsquo;s Delete account row</p>
        <h2 className={styles.pageTitle}>Delete your account</h2>
        {footed ? <p className={styles.pageLead}>Check what&rsquo;s left to do, and what you&rsquo;ll lose, before you go.</p> : null}
        <section data-sq="surface" className={styles.box} data-airy={airy ? "" : undefined} aria-label="Delete your account">
          <div className={styles.boxHead}>
            <div className={styles.boxTitleRow}>
              <h3 className={styles.boxTitle}>{footed ? "Before you delete" : "Checks"}</h3>
              {left ? <Badge size="sm" tone="neutral">{left}</Badge> : null}
            </div>
            {left ? <p className={styles.boxLine}>{footed ? "Every Silicon needs someone looking after it." : "Do these first, then you can delete your account."}</p> : null}
          </div>
          <ul className={styles.boxList}>{checkRows}</ul>
          <div className={styles.boxHead} data-ruled="">
            <h3 className={styles.boxTitle}>What you&rsquo;ll lose access to</h3>
          </div>
          <ul className={styles.boxList}>{loseRows}</ul>
          {footed ? <Foot facts={facts} onDelete={confirm.open} /> : (
            <div className={styles.boxFoot}>
              {recover}
              {deleteBar}
            </div>
          )}
          {footed ? confirm.dialog : null}
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <p className={styles.context}>A page of its own, /privacy/delete, opened from Data &amp; privacy&rsquo;s Delete account row</p>
      <h2 className={styles.pageTitle}>Delete your account</h2>
      <Section id="d-checks" title="Checks" count={left || undefined} description={left ? "Do these first, then you can delete your account." : undefined}>{checkRows}</Section>
      <hr className={styles.rule} />
      <Section id="d-lose" title={"What you\u2019ll lose access to"}>{loseRows}</Section>
      {recover}
      {deleteBar}
    </div>
  );
}

/* F: E, compact ------------------------------------------------------------------------------------------------------- */

function Compact({ facts }: { facts: Facts }) {
  const confirm = useConfirm(facts, <p className={styles.dialogText}>You lose access to everything on the page. Sign in within 30 days to get your account back.</p>);
  const left = facts.silicons.length;
  const emails = facts.carbon.emails.length;
  const phones = facts.carbon.phones.length;
  const links = facts.carbon.identities.length;
  const lose: Array<{ icon: ReactNode; text: ReactNode }> = [
    {
      icon: facts.apps.length ? <AvatarGroup size="sm" max={3} label="Your apps" members={facts.apps.map(item => ({ name: item.app.name, src: withAppIcon(item.app).logo_url ?? undefined }))} /> : <LayoutGrid size={14} strokeWidth={2} />,
      text: facts.apps.length ? plural(facts.apps.length, "app") : "No apps",
    },
    ...(facts.proofs ? [{ icon: <Link2 size={14} strokeWidth={2} />, text: `${plural(facts.proofs, "permission")} between apps` }] : []),
    { icon: <Laptop size={14} strokeWidth={2} />, text: plural(facts.devices, "signed-in device") },
    ...(emails ? [{ icon: <AtSign size={14} strokeWidth={2} />, text: plural(emails, "email") }] : []),
    ...(phones ? [{ icon: <AtSign size={14} strokeWidth={2} />, text: plural(phones, "phone number") }] : []),
    ...(links ? [{ icon: <AtSign size={14} strokeWidth={2} />, text: plural(links, "Google or Apple link") }] : []),
    { icon: <Cpu size={14} strokeWidth={2} />, text: <>CarbonID <strong className="mono">{facts.id}</strong></> },
  ];
  return (
    <div className={styles.page}>
      <p className={styles.context}>A page of its own, /privacy/delete, opened from Data &amp; privacy&rsquo;s Delete account row</p>
      <h2 className={styles.pageTitle}>Delete your account</h2>
      <section data-sq="surface" className={styles.box} aria-label="Delete your account">
        <div className={styles.cHead}>
          <h3 className={styles.cTitle}>Checks</h3>
          {left ? <Badge size="sm" tone="neutral">{left}</Badge> : null}
          <span className={styles.cHint}>{left ? "Hand over or delete each Silicon first" : "Nothing left to do"}</span>
        </div>
        <ul className={styles.cList}>
          {facts.silicons.map(silicon => <SiliconCheck key={silicon.uuid} silicon={silicon} now={facts.now} compact />)}
          {left ? null : (
            <li className={styles.cRow}>
              <span className={styles.cDone} aria-hidden="true"><Check size={14} strokeWidth={2.5} /></span>
              <span className={styles.cText}><span className={styles.cName}>No Silicons in your care</span></span>
            </li>
          )}
          {facts.requests.map(request => (
            <li key={request.id} className={styles.cRow}>
              <span className={styles.cDone} aria-hidden="true"><Inbox size={14} strokeWidth={2} /></span>
              <span className={styles.cText}>
                <span className={styles.cName}>{request.silicon.display_name || request.silicon.id || "A Silicon"}</span>
                <span className={styles.cMeta}>waiting for you · turned down if you delete</span>
              </span>
              <span className={styles.cActions}><ButtonLink href={requestHref(request.id)} variant="secondary" size="xs">Review</ButtonLink></span>
            </li>
          ))}
        </ul>
        <div className={styles.cHead} data-ruled="">
          <h3 className={styles.cTitle}>You&rsquo;ll lose access to</h3>
        </div>
        <ul className={styles.cGrid}>
          {lose.map((item, index) => (
            <li key={index} className={styles.cItem}>
              <span className={styles.cIcon} aria-hidden="true">{item.icon}</span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
        <div className={styles.cFoot}>
          <p className={styles.cNote}><span className={styles.recoverLabel}>Changed your mind?</span> Sign in within 30 days to get it back.</p>
          <span className={styles.cDelete}>
            {left ? <span className={styles.footNote}>{plural(left, "check")} left</span> : null}
            <Button variant="danger" size="sm" disabled={left > 0} onClick={confirm.open}>Delete Account</Button>
          </span>
          {confirm.dialog}
        </div>
      </section>
    </div>
  );
}

/* H: the foot. The 30 days as a card with the last day you can come back; then where the checks stand and Delete. */

function Foot({ facts, onDelete }: { facts: Facts; onDelete: () => void }) {
  const left = facts.silicons.length;
  const waiting = facts.silicons.filter(silicon => silicon.pending_transfer);
  const todo = facts.silicons.filter(silicon => !silicon.pending_transfer);
  const lastDay = formatDate(facts.now + 30 * 86_400_000, facts.carbon.timezone);
  const status = !left ? null
    : todo.length
      ? `${listJoin(todo.map(nameOf))} ${todo.length === 1 ? "needs" : "need"} a new home${waiting.length ? `, and ${listJoin(waiting.map(nameOf))} ${waiting.length === 1 ? "is" : "are"} waiting for ${waiting.length === 1 ? personLabel(waiting[0]!.pending_transfer?.to) : "a reply"}` : ""}`
      : `Waiting for ${listJoin(waiting.map(silicon => `${personLabel(silicon.pending_transfer?.to)} to accept ${nameOf(silicon)}`))}`;
  return (
    <div className={styles.hFoot}>
      <div data-sq="surface" className={styles.hRecover}>
        <span className={styles.hRecoverIcon} aria-hidden="true"><RotateCcw size={16} strokeWidth={2} /></span>
        <span className={styles.hRecoverText}>
          <span className={styles.hRecoverTitle}>Changed your mind? You have 30 days.</span>
          <span className={styles.hRecoverLine}>Sign in before <strong>{lastDay}</strong> and everything comes back as it was.</span>
        </span>
      </div>
      <div className={styles.hAction}>
        <span className={styles.hStatus} role="status">
          {left ? (
            <>
              <span className={styles.hTrack} aria-hidden="true">
                {facts.silicons.map(silicon => <span key={silicon.uuid} data-sq="surface" className={styles.hSegment} data-state={silicon.pending_transfer ? "waiting" : "todo"} />)}
              </span>
              <span className={styles.hStatusText}>
                <span className={styles.hStatusTitle}>{left} left before you can delete</span>
                <span className={styles.hStatusLine}>{status}</span>
              </span>
            </>
          ) : (
            <>
              <span className={styles.hReady} aria-hidden="true"><Check size={14} strokeWidth={2.5} /></span>
              <span className={styles.hStatusText}>
                <span className={styles.hStatusTitle}>All done</span>
                <span className={styles.hStatusLine}>You can delete your account now</span>
              </span>
            </>
          )}
        </span>
        <Button variant="danger" disabled={left > 0} onClick={onDelete}>Delete Account</Button>
      </div>
    </div>
  );
}
