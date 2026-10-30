"use client";

/**
 * Home ("/" signed in), as in the lead designer's prototype (redesign/prototype-map.md). It answers two questions in order:
 * what needs me, then how are my Silicons and apps doing. The greeting over a main column and a side column, one type
 * scale, one tile style (redesign/decisions.md, 2026-10-30).
 *
 * - a greeting with your photo and id (copy it to share);
 * Main column:
 * - Needs you: a tile of rows, one per thing waiting for you (custodian requests, reviewed in a dialog with the request
 *   deck; a Carbon with no phone number is asked to add one), else "You're all set";
 * - Your Silicons: the first two, then a tile to make a new one (a Carbon's own; Silicons look after none);
 * - Your apps: the first four you are signed into.
 * Side column (below the main one under 1024px):
 * - a short introduction to the account until it is dismissed (remembered in this browser);
 * - Your details: your primary email and phone, on to Personal info.
 *
 * Tiles lead to their section until each Silicon and app has a page of its own. What the prototype also shows on a
 * tile (a Silicon's last sign-in, how many Silicons use an app) has no API yet: redesign/api-gaps.md.
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { Check, LayoutGrid, Plus, Smartphone, Sparkles, X } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge, type BadgeTone } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { CopyButton } from "@teamofsilicons/silicon-ui/copy-button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { ButtonLink } from "@/components/foundation/button-link";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page } from "@/components/foundation/layout/layout";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { CustodianRequest, ManagedSilicon, Me, MyApp } from "@/lib/api/types";
import { formatRelative } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useMe } from "@/lib/query/session";
import { NEEDS_YOU_ID, NEW_SILICON_PARAM } from "../parts/anchors";
import { appLogo, asCarbon, describeError, msUntil, personLabel, spanText, useNow } from "../parts/common";
import { useEveryApp, useEveryCustodianRequest, useEverySilicon } from "../parts/queries";
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
        <div className={styles.overview}>
          <Alert tone="danger" title="Your account did not load">
            {describeError(me.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
          </Alert>
        </div>
      </Page>
    );
  }
  if (!account) return <Page><OverviewSkeleton /></Page>;

  return (
    <Page>
      <div className={styles.overview} data-home="">
        <Greeting me={account} />
        <div className={styles.columns}>
          <div className={styles.mainColumn}>
            <NeedsYou me={account} />
            {asCarbon(account) ? <YourSilicons /> : null}
            <YourApps />
          </div>
          <aside className={styles.sideColumn} aria-label="About your account">
            <Intro me={account} />
            <YourDetails me={account} />
          </aside>
        </div>
      </div>
    </Page>
  );
}

/** A section of Home: a small heading, an optional link ("See all"), then its content. */
function Block({ title, href, linkLabel = "See all", children }: { title: string; href?: string; linkLabel?: string; children: ReactNode }) {
  const id = `home-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section className={styles.block} aria-labelledby={id}>
      <div className={styles.blockHead}>
        <h2 id={id} className={styles.blockTitle}>{title}</h2>
        {href ? <Link href={href} className={styles.seeAll}>{linkLabel}</Link> : null}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Greeting                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

function Greeting({ me }: { me: Me }) {
  const first = me.display_name.trim().split(/\s+/)[0] ?? me.display_name;
  return (
    <header className={styles.greeting}>
      <Avatar name={me.display_name} src={me.pfp_url} size="lg" />
      <div className={styles.greetingText}>
        <h1 className={styles.title}>Welcome back, {first}</h1>
        {me.id ? (
          <span data-sq="surface" className={styles.handle}>
            <span className="mono">{me.id}</span>
            <CopyButton value={me.id} label="Copy your id" iconOnly variant="plain" />
          </span>
        ) : null}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Needs you                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

function requestWords(request: CustodianRequest): { title: string; detail: string } {
  const silicon = request.silicon.display_name || request.silicon.id || "A Silicon";
  return request.kind === "transfer"
    ? { title: `${personLabel(request.from)} is handing ${silicon} to you`, detail: "Accept to look after it" }
    : { title: `${silicon} asks you to look after it`, detail: "It made its own account and named you" };
}

/** Everything waiting for the account, as rows of one tile; "You're all set" when nothing waits. */
function NeedsYou({ me }: { me: Me }) {
  const carbon = asCarbon(me);
  const requests = useEveryCustodianRequest();
  const now = useNow(30_000);
  const [reviewing, setReviewing] = useState<CustodianRequest | null>(null);
  const waiting = carbon ? requests.data?.items ?? [] : [];
  const noPhone = !!carbon && carbon.phones.length === 0;

  // A Carbon's requests are part of the answer: wait for them rather than say "all set" too early.
  if (carbon && !requests.data && !requests.error) return null;
  const failed = !!carbon && !!requests.error && !requests.data;
  const count = waiting.length + (noPhone ? 1 : 0) + (failed ? 1 : 0);

  if (!count) {
    return (
      <p id={NEEDS_YOU_ID} className={styles.allClear} role="status">
        <Check size={16} strokeWidth={2} aria-hidden="true" />
        You&apos;re all set
        <span className={styles.allClearNote}>· nothing needs you right now</span>
      </p>
    );
  }

  return (
    <section id={NEEDS_YOU_ID} data-sq="surface" className={`${styles.card} ${styles.needs}`} aria-labelledby={`${NEEDS_YOU_ID}-title`} tabIndex={-1}>
      <div className={styles.cardHead}>
        <h2 id={`${NEEDS_YOU_ID}-title`} className={styles.blockTitle}>Needs you</h2>
        <Badge size="sm" tone="warning">{count}</Badge>
      </div>
      <ul className={styles.rows}>
        {failed ? (
          <Row lead={<span className={styles.mark} aria-hidden="true"><Sparkles size={16} strokeWidth={1.75} /></span>} title="Requests waiting for you did not load" detail={describeError(requests.error)}>
            <Button variant="secondary" size="sm" onClick={() => void requests.refetch()}>Try again</Button>
          </Row>
        ) : null}
        {waiting.map(request => {
          const words = requestWords(request);
          const left = msUntil(request.expires_at, now);
          return (
            <Row key={request.id} lead={<Avatar name={request.silicon.display_name} src={request.silicon.pfp_url} size="md" />} title={words.title} detail={left > 0 ? `${words.detail} · ${spanText(left)} left to answer` : words.detail}>
              <Button variant="secondary" size="sm" onClick={() => setReviewing(request)}>Review</Button>
            </Row>
          );
        })}
        {noPhone ? (
          <Row lead={<span className={styles.mark} aria-hidden="true"><Smartphone size={16} strokeWidth={1.75} /></span>} title="Add a recovery phone" detail="In case you lose your email">
            <ButtonLink href={paths.signInMethods} variant="secondary" size="sm">Add</ButtonLink>
          </Row>
        ) : null}
      </ul>
      <Dialog open={!!reviewing} onOpenChange={open => { if (!open) setReviewing(null); }}>
        {reviewing ? (
          <DialogContent title={requestWords(reviewing).title} description="Each request lasts 14 days. A declined Silicon's account is released; a declined transfer changes nothing.">
            <RequestDeck requests={[reviewing]} now={now} onEmptied={() => setReviewing(null)} />
          </DialogContent>
        ) : null}
      </Dialog>
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

function Intro({ me }: { me: Me }) {
  // Hidden on the server and until storage is read, so a dismissed introduction never flashes in.
  const dismissed = useSyncExternalStore(subscribeIntro, () => dismissedThisVisit || readIntroDismissed(), () => true);
  if (dismissed) return null;
  return (
    <section data-sq="surface" className={`${styles.card} ${styles.intro}`} aria-labelledby="intro-title">
      <div className={styles.cardHead}>
        <h2 id="intro-title" className={styles.blockTitle}>One account for every Team of Silicons app</h2>
        <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={dismissIntro}><X size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
      </div>
      <ul className={styles.introItems}>
        <li className={styles.introItem}>
          <Avatar name={me.display_name} src={me.pfp_url} size="md" />
          <span className={styles.rowTitle}>You</span>
          <span className={styles.rowDetail}>{me.id ? <>Others find you by <span className="mono">{me.id}</span>.</> : "Others find you by your id."}</span>
        </li>
        <li className={styles.introItem}>
          <span className={`${styles.mark} ${styles.siliconMark}`} aria-hidden="true"><Sparkles size={16} strokeWidth={1.75} /></span>
          <span className={styles.rowTitle}>Silicons</span>
          <span className={styles.rowDetail}>AI agents you can look after.</span>
        </li>
        <li className={styles.introItem}>
          <span className={styles.mark} aria-hidden="true"><LayoutGrid size={16} strokeWidth={1.75} /></span>
          <span className={styles.rowTitle}>Apps</span>
          <span className={styles.rowDetail}>Each asks what it can see.</span>
        </li>
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Your details                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A Carbon's primary email and phone (else the first); a Silicon's id. Personal info is where they change. */
function YourDetails({ me }: { me: Me }) {
  const carbon = asCarbon(me);
  const email = carbon ? carbon.emails.find(entry => entry.is_primary) ?? carbon.emails[0] : undefined;
  const phone = carbon ? carbon.phones.find(entry => entry.is_primary) ?? carbon.phones[0] : undefined;
  return (
    <Block title="Your details" href={paths.personal} linkLabel="Edit">
      <dl data-sq="surface" className={`${styles.card} ${styles.details}`}>
        {carbon ? (
          <>
            <Detail label="Email" value={email?.email ?? "None yet"} />
            <Detail label="Phone" value={phone?.phone ?? "None yet"} />
          </>
        ) : (
          <Detail label="Id" value={me.id ?? "None yet"} />
        )}
      </dl>
    </Block>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.detail}>
      <dt className={styles.rowDetail}>{label}</dt>
      <dd className={styles.rowTitle}>{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Your Silicons and your apps                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

function YourSilicons() {
  const silicons = useEverySilicon();
  const list = silicons.data?.items ?? [];
  return (
    <Block title="Your Silicons" href={list.length ? paths.silicons : undefined}>
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
          <Link href={`${paths.silicons}?${NEW_SILICON_PARAM}`} data-sq="surface" className={`${styles.card} ${styles.tile} ${styles.newTile}`}>
            <span className={styles.mark} aria-hidden="true"><Plus size={16} strokeWidth={1.75} /></span>
            <span className={styles.rowTitle}>New Silicon</span>
          </Link>
        </div>
      )}
    </Block>
  );
}

function siliconStatus(silicon: ManagedSilicon): { tone: BadgeTone; text: string } {
  if (silicon.status === "pending_custodian") return { tone: "warning", text: "Waiting for a custodian" };
  if (silicon.pending_transfer) return { tone: "warning", text: "Handing over" };
  return { tone: "success", text: "Active" };
}

function SiliconTile({ silicon }: { silicon: ManagedSilicon }) {
  const status = siliconStatus(silicon);
  return (
    <Link href={paths.silicons} data-sq="surface" className={`${styles.card} ${styles.tile}`}>
      <span className={styles.tileHead}>
        <span className={styles.siliconRing}><Avatar name={silicon.display_name} src={silicon.pfp_url} size="sm" /></span>
        <span className={styles.rowTitle}>{silicon.display_name}</span>
      </span>
      <span className={styles.tileFoot}>
        <Badge size="sm" tone={status.tone}>{status.text}</Badge>
        <span className={`mono ${styles.rowDetail}`}>{silicon.id ?? silicon.uuid}</span>
      </span>
    </Link>
  );
}

function YourApps() {
  const apps = useEveryApp();
  const now = useNow(60_000);
  const { theme } = useTheme();
  const active = (apps.data?.items ?? []).filter(item => item.status === "active");
  return (
    <Block title="Your apps" href={active.length ? paths.apps : undefined}>
      {apps.error && !apps.data ? (
        <Alert tone="danger" title="Your apps did not load">
          {describeError(apps.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void apps.refetch()}>Try again</Button></span>
        </Alert>
      ) : !apps.data ? (
        <TilesSkeleton count={4} />
      ) : active.length ? (
        <div className={`${styles.tiles} ${styles.appTiles}`}>
          {active.slice(0, APP_TILES).map(item => <AppTile key={item.app.app_id} item={item} logo={appLogo(item.app, theme)} now={now} />)}
        </div>
      ) : (
        <p data-sq="surface" className={`${styles.card} ${styles.well}`}>Apps appear here after you sign in to them.</p>
      )}
    </Block>
  );
}

function AppTile({ item, logo, now }: { item: MyApp; logo: string | null; now: number }) {
  const used = item.last_signed_in_at ?? item.first_signed_in_at;
  return (
    <Link href={`${paths.apps}#app-${item.app.app_id}`} data-sq="surface" className={`${styles.card} ${styles.tile}`}>
      <span className={styles.tileHead}>
        <Avatar name={item.app.name} src={logo ?? undefined} size="sm" />
        <span className={styles.rowTitle}>{item.app.name}</span>
      </span>
      <span className={styles.rowDetail}>{used ? `Used ${formatRelative(used, now)}` : "Signed in"}</span>
    </Link>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Skeletons                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

function TilesSkeleton({ count }: { count: number }) {
  return (
    <div className={styles.tiles} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => <SkeletonBlock key={index} width="100%" height="100px" radius="var(--radius-overlay)" index={index} />)}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className={styles.overview} aria-busy="true" aria-label="Loading your account">
      <SkeletonBlock width="min(320px, 80%)" height="48px" radius="var(--radius-control)" />
      <div className={styles.columns}>
        <div className={styles.mainColumn}>
          <SkeletonBlock width="100%" height="120px" radius="var(--radius-overlay)" index={1} />
          <TilesSkeleton count={3} />
        </div>
        <div className={styles.sideColumn}>
          <SkeletonBlock width="100%" height="200px" radius="var(--radius-overlay)" index={2} />
        </div>
      </div>
    </div>
  );
}
