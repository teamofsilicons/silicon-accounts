"use client";

/**
 * Home ("/" signed in), as in the lead designer's prototype (redesign/prototype-map.md). It answers two questions in order:
 * what needs me, then how are my Silicons and apps doing.
 *
 * - a greeting with your photo and id (copy it to share);
 * - Needs you (attention/attention-strip.tsx) while something waits for your decision, else "You're all set";
 * - a short introduction to the account until it is dismissed (remembered in this browser);
 * - Your Silicons: the first two, then a tile to make a new one (a Carbon's own; Silicons look after none);
 * - Your apps: the first four you are signed into.
 *
 * Tiles lead to their section until each Silicon and app has a page of its own. What the prototype also shows on a
 * tile (a Silicon's last sign-in, how many Silicons use an app) has no API yet: redesign/api-gaps.md.
 */
import { useSyncExternalStore } from "react";
import Link from "next/link";
import { Check, LayoutGrid, Plus, Sparkles, X } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge, type BadgeTone } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { CopyButton } from "@teamofsilicons/silicon-ui/copy-button";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, Section } from "@/components/foundation/layout/layout";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { ManagedSilicon, Me, MyApp } from "@/lib/api/types";
import { formatRelative } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useMe } from "@/lib/query/session";
import { ATTENTION_ID, AttentionStrip } from "../attention/attention-strip";
import { appLogo, asCarbon, describeError, useNow } from "../parts/common";
import { useEveryApp, useEveryCustodianRequest, useEverySilicon } from "../parts/queries";
import { NEW_PARAM } from "../silicons/silicons";
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
  if (!account) return <Page><OverviewSkeleton /></Page>;

  return (
    <Page>
      <div className={styles.overview} data-home="">
        <Greeting me={account} />
        <NeedsYou me={account} />
        <Intro me={account} />
        {asCarbon(account) ? <YourSilicons /> : null}
        <YourApps />
      </div>
    </Page>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Greeting and needs you                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

function Greeting({ me }: { me: Me }) {
  const first = me.display_name.trim().split(/\s+/)[0] ?? me.display_name;
  return (
    <header className={styles.greeting}>
      <Avatar name={me.display_name} src={me.pfp_url} size="lg" />
      <div className={styles.greetingText}>
        <h1 className={styles.title}>Welcome back, {first}</h1>
        {me.id ? (
          <span className={styles.handle}>
            <span className="mono">{me.id}</span>
            <CopyButton value={me.id} label="Copy your id" iconOnly variant="plain" />
          </span>
        ) : null}
      </div>
    </header>
  );
}

/** The needs-you block while something waits; "You're all set" once the requests have loaded and none wait. */
function NeedsYou({ me }: { me: Me }) {
  const requests = useEveryCustodianRequest();
  const carbon = asCarbon(me);
  const waiting = requests.data?.items.length ?? 0;
  if (carbon && (waiting > 0 || (requests.error && !requests.data))) return <AttentionStrip me={me} />;
  if (carbon && !requests.data) return null;
  return (
    <p id={ATTENTION_ID} className={styles.allClear} role="status">
      <Check size={16} strokeWidth={2} aria-hidden="true" />
      You&apos;re all set
      <span className={styles.allClearNote}>· nothing needs you right now</span>
    </p>
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
    <section data-sq="surface" className={styles.intro} aria-labelledby="intro-title">
      <div className={styles.introHead}>
        <h2 id="intro-title" className={styles.introTitle}>One account for every Team of Silicons app</h2>
        <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={dismissIntro}><X size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
      </div>
      <ul className={styles.introItems}>
        <li className={styles.introItem}>
          <Avatar name={me.display_name} src={me.pfp_url} size="md" />
          <strong className={styles.introName}>You</strong>
          <span className={styles.introText}>{me.id ? <>Others find you by <span className="mono">{me.id}</span>.</> : "Others find you by your id."}</span>
        </li>
        <li className={styles.introItem}>
          <span className={`${styles.introMark} ${styles.siliconMark}`} aria-hidden="true"><Sparkles size={18} strokeWidth={1.75} /></span>
          <strong className={styles.introName}>Silicons</strong>
          <span className={styles.introText}>AI agents you can look after.</span>
        </li>
        <li className={styles.introItem}>
          <span className={styles.introMark} aria-hidden="true"><LayoutGrid size={18} strokeWidth={1.75} /></span>
          <strong className={styles.introName}>Apps</strong>
          <span className={styles.introText}>Each asks what it can see.</span>
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
    <Section title="Your Silicons" actions={list.length ? <Link href={paths.silicons} className={styles.seeAll}>See all</Link> : null}>
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
          <Link href={`${paths.silicons}?${NEW_PARAM}`} data-sq="surface" className={`${styles.tile} ${styles.newTile}`}>
            <span className={styles.introMark} aria-hidden="true"><Plus size={18} strokeWidth={1.75} /></span>
            <span className={styles.tileName}>New Silicon</span>
          </Link>
        </div>
      )}
    </Section>
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
    <Link href={paths.silicons} data-sq="surface" className={`${styles.tile} ${styles.siliconTile}`}>
      <span className={styles.tileHead}>
        <Avatar name={silicon.display_name} src={silicon.pfp_url} size="md" />
        <span className={styles.tileName}>{silicon.display_name}</span>
      </span>
      <span className={styles.tileFoot}>
        <Badge size="sm" tone={status.tone}>{status.text}</Badge>
        <span className={`mono ${styles.tileNote}`}>{silicon.id ?? silicon.uuid}</span>
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
    <Section title="Your apps" actions={active.length ? <Link href={paths.apps} className={styles.seeAll}>See all</Link> : null}>
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
        <p className={styles.quiet}>Apps appear here after you sign in to them.</p>
      )}
    </Section>
  );
}

function AppTile({ item, logo, now }: { item: MyApp; logo: string | null; now: number }) {
  const used = item.last_signed_in_at ?? item.first_signed_in_at;
  return (
    <Link href={`${paths.apps}#app-${item.app.app_id}`} data-sq="surface" className={styles.tile}>
      <span className={styles.tileHead}>
        <Avatar name={item.app.name} src={logo ?? undefined} size="md" />
        <span className={styles.tileName}>{item.app.name}</span>
      </span>
      <span className={styles.tileFoot}>
        <span className={styles.tileNote}>{used ? `Used ${formatRelative(used, now)}` : "Signed in"}</span>
      </span>
    </Link>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Skeletons                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

function TilesSkeleton({ count }: { count: number }) {
  return (
    <div className={styles.tiles} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => <SkeletonBlock key={index} width="100%" height="104px" radius="var(--radius-container)" index={index} />)}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className={styles.overview} aria-busy="true" aria-label="Loading your account">
      <SkeletonBlock width="min(360px, 80%)" height="48px" radius="var(--radius-control)" />
      <SkeletonBlock width="100%" height="120px" radius="var(--radius-container)" index={1} />
      <TilesSkeleton count={3} />
    </div>
  );
}
