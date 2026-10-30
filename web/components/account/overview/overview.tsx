"use client";

/**
 * Home ("/" signed in), built to the lead designer's prototype (redesign/prototype-v7.html, home): one centred column.
 *
 * - the greeting: your photo in the prototype's ring, "Welcome back", your id as a chip that copies on tap;
 * - Needs you: a card of rows, one per thing waiting for you (a Silicon asking you to look after it, with Decline and
 *   Review; a Carbon handing you a Silicon, with Review; a missing recovery phone, with Add), else "You're all set";
 * - the introduction until it is dismissed (remembered in this browser);
 * - Your Silicons: the first two, then New Silicon (a Carbon's own; Silicons look after none);
 * - Your apps: the first four you are signed into, else a quiet line.
 *
 * The prototype's states, as this page draws them: a request or handover waiting (Needs you), nothing waiting
 * ("You're all set"), no Silicons (New Silicon alone), first visit (the introduction), loading (skeletons in the
 * page's shape). What the prototype also shows without an API yet (wrong keys tried, a Silicon's last sign-in and its
 * 14-day bars, how many Silicons use an app, devices not used lately) is in redesign/prototype-differences.md.
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { AtSign, Bell, Briefcase, Check, KeyRound, Laptop, MessageSquare, Plus, Smartphone, X } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge, type BadgeTone } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { Progress } from "@teamofsilicons/silicon-ui/progress";
import { useCopyFeedback } from "@teamofsilicons/silicon-ui/lib/use-copy-feedback";
import { PixelAvatar } from "@/components/foundation/avatar/pixel-avatar";
import { ButtonLink } from "@/components/foundation/button-link";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page } from "@/components/foundation/layout/layout";
import type { CarbonMe, CustodianRequest, ManagedSilicon, Me, MyApp, SessionInfo } from "@/lib/api/types";
import { useCarbonPicture } from "@/lib/carbon-avatar";
import { formatPhone, formatRelative } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useDeclineCustodianRequest } from "@/lib/query/silicons";
import { useMe } from "@/lib/query/session";
import { NEEDS_YOU_ID, NEW_SILICON_PARAM } from "../parts/anchors";
import { AppMark } from "../parts/app-mark";
import { asCarbon, describeError, msUntil, personLabel, spanText, useNow } from "../parts/common";
import { useEveryApp, useEveryCustodianRequest, useEverySession, useEverySilicon, useSignOutSession } from "../parts/queries";
import { sessionName } from "../security/sessions";
import { SiliconMark } from "../parts/silicon-mark";
import { RequestDeck } from "../silicons/request-deck";
import styles from "./overview.module.css";

const SILICON_TILES = 2;
const APP_TILES = 4;

export function Overview() {
  const me = useMe();
  const account = me.data;

  if (me.error && !account) {
    return (
      <Page>
        <Alert tone="danger" title="Your account did not load">
          {describeError(me.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
        </Alert>
      </Page>
    );
  }
  if (!account) return <Page label="Loading your account"><OverviewSkeleton /></Page>;

  return (
    <Page>
      <div className={styles.home} data-home="">
        <Greeting me={account} />
        <NeedsYou me={account} />
        <Intro me={account} />
        {asCarbon(account) ? <YourSilicons /> : null}
        <YourApps />
      </div>
    </Page>
  );
}

/** A section heading with "See all" at its end (the prototype's sechd). */
function SectionHead({ id, title, href }: { id: string; title: string; href?: string }) {
  return (
    <div className={styles.sectionHead}>
      <h2 id={id} className={styles.sectionTitle}>{title}</h2>
      {href ? <Link href={href} className={styles.seeAll}>See all</Link> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Greeting                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

function Greeting({ me }: { me: Me }) {
  const first = me.display_name.trim().split(/\s+/)[0] ?? me.display_name;
  const picture = useCarbonPicture(me);
  return (
    <header className={styles.greeting}>
      <span className={styles.ring}>
        {picture?.kind === "avatar"
          ? <PixelAvatar choice={picture.choice} size={48} animate label={me.display_name} />
          : <Avatar name={me.display_name} src={me.pfp_url} size="lg" />}
      </span>
      <div className={styles.greetingText}>
        <h1 className={styles.title}>Welcome back, {first}</h1>
        {me.id ? <Handle id={me.id} /> : null}
      </div>
    </header>
  );
}

/** Your id as a quiet chip: tap copies it (no separate copy control). */
function Handle({ id }: { id: string }) {
  const { state, copy } = useCopyFeedback();
  const label = state === "copied" ? "Copied" : state === "error" ? "Couldn’t copy" : id;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-sq="surface"
      className={styles.handle}
      onClick={() => void copy(id)}
      aria-label={state === "idle" ? `Copy your id, ${id}` : label}
    >
      {label}
    </Button>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Needs you                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

const siliconName = (request: CustodianRequest) => request.silicon.display_name || request.silicon.id || "A Silicon";

/** Everything waiting for the account, as rows of one card; "You're all set" when nothing waits. */
function NeedsYou({ me }: { me: Me }) {
  const carbon = asCarbon(me);
  const requests = useEveryCustodianRequest();
  const decline = useDeclineCustodianRequest();
  const now = useNow(30_000);
  const [reviewing, setReviewing] = useState<CustodianRequest | null>(null);
  const [declining, setDeclining] = useState<CustodianRequest | null>(null);
  const sessions = useEverySession();
  const kept = useSyncExternalStore(subscribeKept, readKept, () => "");
  const waiting = carbon ? requests.data?.items ?? [] : [];
  const steps = carbon ? checkupSteps(carbon, sessions.data?.items, now, kept) : [];
  const stepsLeft = steps.filter(step => !step.done).length;

  // A Carbon's requests are part of the answer: wait for them rather than say "all set" too early.
  if (carbon && !requests.data && !requests.error) return null;
  const failed = !!carbon && !!requests.error && !requests.data;
  const count = waiting.length + (failed ? 1 : 0);

  if (!count && !stepsLeft) {
    return (
      <p id={NEEDS_YOU_ID} data-sq="surface" className={styles.allClear} role="status">
        <Check size={16} strokeWidth={2} aria-hidden="true" />
        You&apos;re all set
        <span className={styles.allClearNote}>· nothing needs you right now</span>
      </p>
    );
  }

  const daysLeft = (request: CustodianRequest) => {
    const left = msUntil(request.expires_at, now);
    return left > 0 ? `${spanText(left)} left` : "Ends today";
  };

  return (
    <div id={NEEDS_YOU_ID} className={styles.needsGroup} tabIndex={-1}>
    {count ? <section data-sq="surface" className={`${styles.card} ${styles.needs}`} aria-labelledby={`${NEEDS_YOU_ID}-title`}>
      <div className={styles.cardHead}>
        <h2 id={`${NEEDS_YOU_ID}-title`} className={styles.cardTitle}>Needs you</h2>
        <Badge size="sm" tone="warning">{count}</Badge>
      </div>
      <ul className={styles.rows}>
        {failed ? (
          <Row lead={<span data-sq="surface" className={styles.iconTile} aria-hidden="true"><X size={16} strokeWidth={1.75} /></span>} title="Requests waiting for you did not load" detail={describeError(requests.error)}>
            <Button variant="secondary" size="sm" onClick={() => void requests.refetch()}>Try again</Button>
          </Row>
        ) : null}
        {waiting.map(request => request.kind === "transfer" ? (
          <Row key={request.id} lead={<SiliconMark seed={request.silicon.uuid} size={40} />} title={`${personLabel(request.from)} is handing ${siliconName(request)} to you`} detail={daysLeft(request)}>
            <Button variant="primary" size="sm" onClick={() => setReviewing(request)}>Review</Button>
          </Row>
        ) : (
          <Row key={request.id} lead={<SiliconMark seed={request.silicon.uuid} size={40} pending />} title={`${siliconName(request)} wants you to look after it`} detail={daysLeft(request)}>
            <Button variant="secondary" size="sm" onClick={() => setDeclining(request)}>Decline</Button>
            <Button variant="primary" size="sm" onClick={() => setReviewing(request)}>Review</Button>
          </Row>
        ))}
      </ul>
      <Dialog open={!!reviewing} onOpenChange={open => { if (!open) setReviewing(null); }}>
        {reviewing ? (
          <DialogContent title={reviewing.kind === "transfer" ? `${personLabel(reviewing.from)} is handing ${siliconName(reviewing)} to you` : `${siliconName(reviewing)} wants you to look after it`} description="Each request lasts 14 days. A declined Silicon's account is released; a declined transfer changes nothing.">
            <RequestDeck requests={[reviewing]} now={now} onEmptied={() => setReviewing(null)} />
          </DialogContent>
        ) : null}
      </Dialog>
      <Dialog open={!!declining} onOpenChange={open => { if (!open) setDeclining(null); }}>
        {declining ? (
          <DialogContent title={`Decline ${siliconName(declining)}?`}>
            <p className={styles.dialogText}>
              It can&apos;t sign in anywhere, its account is removed, and <span className="mono">{declining.silicon.id ?? declining.silicon.uuid}</span> is free for anyone at once.
            </p>
            <div className={styles.dialogActions}>
              <Button variant="secondary" onClick={() => setDeclining(null)}>Cancel</Button>
              <Button variant="danger" loading={decline.isPending} onClick={() => void decline.mutateAsync(declining.id).then(() => setDeclining(null), () => undefined)}>Decline</Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </section> : null}
    {stepsLeft ? <Checklist steps={steps} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Finish setting up: the prototype's security checkup as a checklist                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A device not used for this long is "not used lately" (Anil, 2026-10-30). */
const STALE_MS = 7 * 86_400_000;

/** Sessions the Carbon chose to keep although they are not used lately, remembered in this browser. */
const KEPT_KEY = "accounts.home.kept-sessions";
const keptListeners = new Set<() => void>();
const subscribeKept = (listener: () => void) => {
  keptListeners.add(listener);
  return () => keptListeners.delete(listener);
};
function readKept(): string {
  try {
    return window.localStorage.getItem(KEPT_KEY) ?? "";
  } catch {
    return "";
  }
}
function keepSession(id: string) {
  try {
    const ids = new Set(readKept().split(",").filter(Boolean));
    ids.add(id);
    window.localStorage.setItem(KEPT_KEY, [...ids].join(","));
  } catch {
    // Storage blocked: the question comes back next visit.
  }
  keptListeners.forEach(listener => listener());
}

interface Step {
  key: "provider" | "email" | "phone" | "devices";
  done: boolean;
  title: string;
  detail: string;
  /** The device not used lately, for Keep and Sign out. */
  stale?: SessionInfo;
}

/** The prototype's checkup (Security), in its order: a second way in, a verified email, a recovery phone, devices. */
function checkupSteps(carbon: CarbonMe, sessions: SessionInfo[] | undefined, now: number, kept: string): Step[] {
  const providers = carbon.identities.map(identity => (identity.provider === "google" ? "Google" : identity.provider === "apple" ? "Apple" : null)).filter(Boolean);
  const email = carbon.emails.find(item => item.verified_at && item.is_primary) ?? carbon.emails.find(item => item.verified_at);
  const phone = carbon.phones.find(item => item.is_primary) ?? carbon.phones[0];
  const keptIds = new Set(kept.split(",").filter(Boolean));
  // Until the sessions load, devices count as fine rather than flash a question.
  const stale = (sessions ?? []).find(item => !item.current && !keptIds.has(item.id) && !!item.last_seen_at && now - Date.parse(item.last_seen_at) > STALE_MS);
  return [
    { key: "provider", done: providers.length > 0, title: "Sign in with Google or Apple", detail: providers.length ? `${providers.join(" and ")} signs you in` : "A second way in that isn't a code" },
    { key: "email", done: !!email, title: "Verified email", detail: email?.email ?? "Add an email" },
    { key: "phone", done: !!phone, title: "Recovery phone", detail: phone ? formatPhone(phone.phone) : "Gets you in if you lose your email" },
    stale
      ? { key: "devices", done: false, title: "Only devices you still use", detail: `${sessionName(stale)} · last used ${formatRelative(stale.last_seen_at ?? stale.created_at, now)}`, stale }
      : { key: "devices", done: true, title: "Only devices you still use", detail: "Every device was used recently" },
  ];
}

const STEP_ICON = { provider: KeyRound, email: AtSign, phone: Smartphone, devices: Laptop } as const;

function Checklist({ steps }: { steps: Step[] }) {
  const signOut = useSignOutSession();
  const left = steps.filter(step => !step.done);
  const done = steps.filter(step => step.done);
  return (
    <section data-sq="surface" className={styles.card} aria-labelledby="home-setup-title">
      <div className={styles.checkHead}>
        <div className={styles.checkTitleRow}>
          <h2 id="home-setup-title" className={styles.cardTitle}>Finish setting up</h2>
          <span className={styles.checkCount}>{left.length} of {steps.length} left</span>
        </div>
        <Progress value={done.length} max={steps.length} label="Setup progress" />
      </div>
      <ul className={styles.rows}>
        {left.map(step => {
          const Icon = STEP_ICON[step.key];
          return (
            <Row key={step.key} lead={<span data-sq="surface" className={`${styles.iconTile} ${styles.iconTileWarning}`} aria-hidden="true"><Icon size={16} strokeWidth={1.75} /></span>} title={step.title} detail={step.detail}>
              {step.key === "devices" && step.stale ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => step.stale && keepSession(step.stale.id)}>Keep</Button>
                  <Button variant="secondary" size="sm" loading={signOut.isPending} onClick={() => step.stale && void signOut.mutateAsync(step.stale.id).catch(() => undefined)}>Sign out</Button>
                </>
              ) : (
                <ButtonLink href={paths.signInMethods} variant="secondary" size="sm">{step.key === "provider" ? "Connect" : "Add"}</ButtonLink>
              )}
            </Row>
          );
        })}
        {done.map(step => (
          <li key={step.key} className={styles.row}>
            <span data-sq="surface" className={`${styles.iconTile} ${styles.iconTileDone}`} aria-hidden="true"><Check size={16} strokeWidth={2} /></span>
            <span className={styles.rowText}>
              <span className={styles.rowDone}><span className="sr-only">Done: </span>{step.title}</span>
              <span className={styles.rowDetail}>{step.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ lead, title, detail, children }: { lead: ReactNode; title: string; detail: string; children: ReactNode }) {
  return (
    <li className={styles.row}>
      {lead}
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowDetail}>{detail}</span>
      </span>
      <span className={styles.rowAction}>{children}</span>
    </li>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Introduction (dismissible, remembered in this browser)                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

const INTRO_KEY = "accounts.home.intro-dismissed";
const introListeners = new Set<() => void>();
let dismissedThisVisit = false;

function readIntroDismissed(): boolean {
  try {
    return window.localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissIntro() {
  try {
    window.localStorage.setItem(INTRO_KEY, "1");
  } catch {
    // Storage blocked: the introduction goes for this visit only.
  }
  dismissedThisVisit = true;
  introListeners.forEach(listener => listener());
}

const subscribeIntro = (listener: () => void) => {
  introListeners.add(listener);
  return () => introListeners.delete(listener);
};

/** The prototype's three app marks (Briefcase, DM, Ting) stand for "apps" in general. */
const INTRO_APPS = [Briefcase, MessageSquare, Bell];

function Intro({ me }: { me: Me }) {
  // Hidden on the server and until storage is read, so a dismissed introduction never flashes in.
  const dismissed = useSyncExternalStore(subscribeIntro, () => dismissedThisVisit || readIntroDismissed(), () => true);
  const picture = useCarbonPicture(me);
  if (dismissed) return null;
  return (
    <section data-sq="surface" className={`${styles.card} ${styles.intro}`} aria-labelledby="intro-title">
      <div className={styles.introHead}>
        <h2 id="intro-title" className={styles.introTitle}>One account for every Team of Silicons app</h2>
        <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={dismissIntro}><X size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
      </div>
      <ul className={styles.introItems}>
        <li className={styles.introItem}>
          <Avatar name={me.display_name} src={picture?.src ?? me.pfp_url} size="md" />
          <span className={styles.introLabel}>You</span>
          <span>{me.id ? <>Others find you by <span className="mono">{me.id}</span>.</> : "Others find you by your id."}</span>
        </li>
        <li className={styles.introItem}>
          <SiliconMark seed="scout" size={36} />
          <span className={styles.introLabel}>Silicons</span>
          <span>AI agents you can look after.</span>
        </li>
        <li className={styles.introItem}>
          <span className={styles.appStack} aria-hidden="true">
            {INTRO_APPS.map((Icon, index) => <span key={index} data-sq="surface" className={styles.introApp}><Icon size={18} strokeWidth={1.75} /></span>)}
          </span>
          <span className={styles.introLabel}>Apps</span>
          <span>Each asks what it can see.</span>
        </li>
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Your Silicons and your apps                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

function YourSilicons() {
  const silicons = useEverySilicon();
  const list = silicons.data?.items ?? [];
  return (
    <section className={styles.block} aria-labelledby="home-silicons">
      <SectionHead id="home-silicons" title="Your Silicons" href={list.length ? paths.silicons : undefined} />
      {silicons.error && !silicons.data ? (
        <Alert tone="danger" title="Your Silicons did not load">
          {describeError(silicons.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void silicons.refetch()}>Try again</Button></span>
        </Alert>
      ) : !silicons.data ? (
        <TilesSkeleton count={3} />
      ) : (
        <div className={styles.tiles}>
          {list.slice(0, SILICON_TILES).map(silicon => <SiliconTile key={silicon.uuid} silicon={silicon} />)}
          <Link href={`${paths.silicons}?${NEW_SILICON_PARAM}`} data-sq="surface" className={`${styles.tile} ${styles.newTile}`}>
            <span data-sq="surface" className={styles.iconTile} aria-hidden="true"><Plus size={16} strokeWidth={1.75} /></span>
            <span className={styles.tileName}>New Silicon</span>
          </Link>
        </div>
      )}
    </section>
  );
}

function siliconStatus(silicon: ManagedSilicon): { tone: BadgeTone; text: string; detail?: string } {
  if (silicon.status === "pending_custodian") return { tone: "warning", text: "Waiting for a custodian" };
  if (silicon.pending_transfer) {
    const to = personLabel(silicon.pending_transfer.to, "");
    return { tone: "warning", text: "Handing over", detail: to ? `to ${to.split(/\s+/)[0]}` : undefined };
  }
  return { tone: "success", text: "Active" };
}

function SiliconTile({ silicon }: { silicon: ManagedSilicon }) {
  const status = siliconStatus(silicon);
  return (
    <Link href={paths.silicons} data-sq="surface" className={styles.tile}>
      <span className={styles.tileHead}>
        <SiliconMark seed={silicon.uuid} size={32} />
        <span className={styles.tileName}>{silicon.display_name}</span>
      </span>
      <span className={styles.tileFoot}>
        <Badge size="sm" tone={status.tone}>{status.text}</Badge>
        {status.detail ? <span className={styles.tileDetail}>{status.detail}</span> : null}
      </span>
    </Link>
  );
}

function YourApps() {
  const apps = useEveryApp();
  const now = useNow(60_000);
  const active = (apps.data?.items ?? []).filter(item => item.status === "active");
  return (
    <section className={styles.block} aria-labelledby="home-apps">
      <SectionHead id="home-apps" title="Your apps" href={active.length ? paths.apps : undefined} />
      {apps.error && !apps.data ? (
        <Alert tone="danger" title="Your apps did not load">
          {describeError(apps.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void apps.refetch()}>Try again</Button></span>
        </Alert>
      ) : !apps.data ? (
        <TilesSkeleton count={4} />
      ) : active.length ? (
        <div className={`${styles.tiles} ${styles.appTiles}`}>
          {active.slice(0, APP_TILES).map(item => <AppTile key={item.app.app_id} item={item} now={now} />)}
        </div>
      ) : (
        <p data-sq="surface" className={styles.quiet}>Apps appear here after you sign in to them.</p>
      )}
    </section>
  );
}

function AppTile({ item, now }: { item: MyApp; now: number }) {
  const used = item.last_signed_in_at ?? item.first_signed_in_at;
  return (
    <Link href={`${paths.apps}#app-${item.app.app_id}`} data-sq="surface" className={styles.tile}>
      <span className={styles.tileHead}>
        <AppMark app={item.app} size={32} decorative />
        <span className={styles.tileName}>{item.app.name}</span>
      </span>
      <span className={styles.tileDetail}>{used ? `Used ${formatRelative(used, now)}` : "Signed in"}</span>
    </Link>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Loading: the prototype's skeleton in the page's shape                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

function TilesSkeleton({ count }: { count: number }) {
  return (
    <div className={`${styles.tiles} ${count === 4 ? styles.appTiles : ""}`} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => <SkeletonBlock key={index} width="100%" height="120px" radius="var(--radius-container)" index={index} />)}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className={styles.home} aria-busy="true">
      <SkeletonBlock width="42%" height="30px" radius="var(--radius-container)" />
      <SkeletonBlock width="100%" height="120px" radius="var(--radius-container)" index={1} />
      <TilesSkeleton count={3} />
      <SkeletonBlock width="100%" height="160px" radius="var(--radius-container)" index={5} />
    </div>
  );
}
