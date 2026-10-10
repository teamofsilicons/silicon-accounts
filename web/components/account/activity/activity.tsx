"use client";

/**
 * /activity: what happened to this account, newest first and grouped by day in your timezone: sign-ins, id changes,
 * custodian changes, proofs, app access and security events. Rows with more to say open in place.
 *
 * "Show older activity" keeps focus while there is more; when the oldest page arrives the button goes, and focus moves
 * to the first row it brought (focusable for that, when the row itself is not).
 */
import { useRef, useState, type ReactNode } from "react";
import { AtSign, Cpu, History, LayoutGrid, LockKeyhole, LogIn, ShieldCheck } from "lucide-react";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Button } from "@/components/silicon-ui/button/button";
import { EmptyState } from "@/components/silicon-ui/empty-state/empty-state";
import SegmentedControl from "@/components/silicon-ui/segmented-control/segmented-control";
import { Timeline, type TimelineEvent } from "@/components/silicon-ui/timeline/timeline";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { HistoryKind } from "@/lib/api/types";
import { browserTimezone } from "@/lib/format";
import { useHistory } from "@/lib/query/account";
import { useMe } from "@/lib/query/session";
import { timezoneLabel } from "@/lib/timezones";
import { appLogo, asCarbon, describeError, readableTimes, useNow } from "../parts/common";
import { handFocus, pageMain } from "../parts/focus";
import { useEverySilicon } from "../parts/queries";
import { historyDetails, siliconOf, type DetailContext } from "./history-details";
import styles from "./activity.module.css";

type Filter = "all" | HistoryKind;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "signin", label: "Sign-ins" },
  { value: "id_change", label: "Id changes" },
  { value: "custodian", label: "Custodian" },
  { value: "proof", label: "User verification" },
  { value: "app_access", label: "App access" },
  { value: "security", label: "Security" },
];

const EMPTY: Record<Filter, string> = {
  all: "Sign-ins, id changes, custodian changes, user verifications and app access show up here as they happen.",
  signin: "Each time you sign in to an app or to this site, it shows up here.",
  id_change: "When your id changes, the old and new ids show up here.",
  custodian: "Silicons you take on, hand over or are asked to look after show up here.",
  proof: "User verifications apps get to act for you, and the ones you revoke, show up here.",
  app_access: "Apps you remove, and apps that import your account, show up here.",
  security: "Changes to how you sign in show up here.",
};

const ICONS: Record<HistoryKind, ReactNode> = {
  signin: <LogIn size={14} strokeWidth={2} />,
  id_change: <AtSign size={14} strokeWidth={2} />,
  custodian: <Cpu size={14} strokeWidth={2} />,
  proof: <ShieldCheck size={14} strokeWidth={2} />,
  app_access: <LayoutGrid size={14} strokeWidth={2} />,
  security: <LockKeyhole size={14} strokeWidth={2} />,
};

export function Activity() {
  const [filter, setFilter] = useState<Filter>("all");
  const history = useHistory(filter === "all" ? null : filter);
  const now = useNow(60_000);
  const me = useMe();
  const { theme } = useTheme();
  const silicons = useEverySilicon();
  const feed = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [zone] = useState(browserTimezone);
  const timeZone = me.data?.timezone ?? zone;
  // Rows wait for the account's timezone so their days and times never redraw after a first paint in the browser's
  // zone; the browser's zone is only the fallback when the account can't be loaded.
  const zoneKnown = !!me.data || me.isError;

  // The custodian's Silicons, so rows about one of them name it by its si:id without a lookup.
  const carbon = asCarbon(me.data);
  const siliconIds = new Map((carbon ? silicons.data?.items ?? [] : []).map(item => [item.uuid, item.id] as const));
  const context: DetailContext = {
    me: me.data ? { uuid: me.data.uuid, id: me.data.id, kind: me.data.kind } : undefined,
    siliconId: uuid => siliconIds.get(uuid),
  };

  const items = history.data?.pages.flatMap(page => page.items) ?? [];
  const events: TimelineEvent[] = items.map(item => {
    const rows = historyDetails(item, context);
    const logo = item.app ? appLogo(item.app, theme) : null;
    // Times inside the service's sentences read in the account's timezone, like the days and times around them.
    const meta = [item.detail ? readableTimes(item.detail, { timeZone }) : null, siliconOf(item, context), item.app && !item.title.includes(item.app.name) ? item.app.name : null].filter(Boolean).join(" · ");
    return {
      id: item.id,
      at: item.at,
      title: readableTimes(item.title, { timeZone }),
      meta: meta || undefined,
      avatar: logo ?? undefined,
      icon: ICONS[item.kind] ?? <History size={14} strokeWidth={2} />,
      detail: rows.length ? (
        <dl className={styles.detail}>
          {rows.map((row, index) => <div key={`${row.label}-${index}`}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
        </dl>
      ) : undefined,
    };
  });

  /**
   * Loads the next page. When it was the last one, the button that had focus goes away: focus moves to the first row
   * it brought (its "more" button, or the row itself), so the keyboard carries on where the new rows start.
   */
  const showOlder = async () => {
    const before = feed.current?.querySelectorAll("li").length ?? 0;
    const hadFocus = !!moreButton.current && document.activeElement === moreButton.current;
    const result = await history.fetchNextPage();
    if (!hadFocus || result.isError || result.hasNextPage) return;
    handFocus(pageMain(), () => {
      const row = feed.current?.querySelectorAll<HTMLElement>("li")[before];
      if (!row) return null;
      const trigger = row.querySelector<HTMLElement>("[data-timeline-trigger]");
      if (trigger) return trigger;
      row.tabIndex = -1;
      row.setAttribute("data-focus-landing", "");
      return row;
    });
  };

  return (
    <Page width="reading">
      <PageHeader title="Activity" description={`Everything that happened to your account, newest first. Days and times are in ${timezoneLabel(timeZone)}, your timezone.`} />
      <div className={styles.toolbar}>
        <SegmentedControl label="Show" value={filter} onValueChange={value => setFilter(value as Filter)} options={FILTERS} />
      </div>
      {/* Names what the switch shows, so the day headings (or the empty state's) sit one level under the page's. */}
      <h2 className="sr-only">{filter === "all" ? "All activity" : FILTERS.find(item => item.value === filter)?.label}</h2>
      {history.error && !history.data ? (
        <Alert tone="danger" title="Your activity did not load">
          {describeError(history.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void history.refetch()}>Try again</Button></span>
        </Alert>
      ) : !history.data || !zoneKnown ? (
        <div className={styles.skeleton} aria-busy="true" aria-label="Loading your activity">
          <SkeletonBlock width="180px" height="18px" radius="6px" />
          {[0, 1, 2, 3, 4].map(index => (
            <div key={index} className={styles.skeletonRow}>
              <SkeletonBlock width="28px" height="28px" radius="10px" index={index} />
              <SkeletonBlock width={`${70 - index * 6}%`} height="18px" radius="6px" index={index} />
            </div>
          ))}
        </div>
      ) : !items.length ? (
        <div className={styles.empty}>
          <EmptyState icon={<History width={24} height={24} strokeWidth={1.5} />} title="Nothing here yet" description={EMPTY[filter]} />
        </div>
      ) : (
        <>
          <div ref={feed} className={styles.feed}>
            {/* Each filter starts its own timeline, so rows of the previous filter never slide in as new ones. */}
            <Timeline key={filter} events={events} now={now} label="Account activity" timeZone={timeZone} headingLevel={3} />
          </div>
          {history.hasNextPage ? (
            <div className={styles.more}>
              <Button ref={moreButton} variant="secondary" onClick={() => void showOlder()} loading={history.isFetchingNextPage}>Show older activity</Button>
            </div>
          ) : null}
          {history.isFetchNextPageError ? <p className={styles.error} role="alert">{describeError(history.error)}</p> : null}
        </>
      )}
    </Page>
  );
}
