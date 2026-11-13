"use client";

/**
 * /activity, as the prototype draws it (Anil, 2026-11-12; a sidebar section since 2026-11-13): one line on what it holds and in
 * which timezone, the prototype's filters (All, Security, Personal info, Apps, Silicons), then a section per day on the
 * account pages' rows (parts/rows.tsx): what happened, its one detail line, and the time; an app's mark when an app was
 * involved, else the kind's icon. Newest first, in the account's timezone; "Show Older Activity" reads the next page.
 *
 * The filters group the API's history kinds: Security is sign-ins and security changes, Personal info is CarbonID
 * changes, Apps is app access and permissions between apps, Silicons is custodian changes. A filter of one kind asks
 * the API for that kind; a filter of two filters what has loaded, and Show Older Activity brings more.
 */
import { useRef, useState, type ReactNode } from "react";
import { AtSign, Cpu, History, LayoutGrid, LockKeyhole, LogIn, ShieldCheck } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
import type { HistoryItem, HistoryKind } from "@/lib/api/types";
import { browserTimezone } from "@/lib/format";
import { useHistory } from "@/lib/query/account";
import { useMe } from "@/lib/query/session";
import { timezoneLabel } from "@/lib/timezones";
import { AppMark } from "../parts/app-mark";
import { withAppIcon } from "../parts/app-icons";
import { asCarbon, describeError, readableTimes } from "../parts/common";
import { handFocus, pageMain } from "../parts/focus";
import { PageBar } from "../parts/page-bar";
import { useEverySilicon } from "../parts/queries";
import { Row, Section, Tile } from "../parts/rows";
import { siliconOf, type DetailContext } from "./history-details";
import styles from "./activity.module.css";

type Filter = "all" | "security" | "personal" | "apps" | "silicons";

const FILTERS: Array<{ value: Filter; label: string; kinds: HistoryKind[] }> = [
  { value: "all", label: "All", kinds: [] },
  { value: "security", label: "Security", kinds: ["signin", "security"] },
  { value: "personal", label: "Personal info", kinds: ["id_change"] },
  { value: "apps", label: "Apps", kinds: ["app_access", "proof"] },
  { value: "silicons", label: "Silicons", kinds: ["custodian"] },
];

const EMPTY: Record<Filter, string> = {
  all: "Sign-ins, changes to your account, your Silicons and your apps show up here as they happen.",
  security: "Each sign-in, and each change to how you sign in, shows up here.",
  personal: "When your CarbonID changes, the old and new ones show up here.",
  apps: "Apps you remove, apps that import your account, and apps acting for you show up here.",
  silicons: "Silicons you take on, hand over or are asked to look after show up here.",
};

const ICONS: Record<HistoryKind, ReactNode> = {
  signin: <LogIn size={16} strokeWidth={2} />,
  id_change: <AtSign size={16} strokeWidth={2} />,
  custodian: <Cpu size={16} strokeWidth={2} />,
  proof: <ShieldCheck size={16} strokeWidth={2} />,
  app_access: <LayoutGrid size={16} strokeWidth={2} />,
  security: <LockKeyhole size={16} strokeWidth={2} />,
};

/** The account site itself: its own sign-ins get the sign-in icon, not an app mark (it has no app icon). */
const FIRST_PARTY = "silicon-accounts";

/** "2026-11-12": the day of a moment in a timezone, for grouping. */
const dayKey = (at: number, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/** Today, Yesterday, "Tuesday, November 10", or with the year once it isn't this year's. */
function dayLabel(key: string, now: number, timeZone: string): string {
  if (key === dayKey(now, timeZone)) return "Today";
  if (key === dayKey(now - 86_400_000, timeZone)) return "Yesterday";
  const noon = new Date(`${key}T12:00:00Z`);
  const sameYear = key.slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(noon);
}

export function Activity() {
  const [filter, setFilter] = useState<Filter>("all");
  const group = FILTERS.find(item => item.value === filter) ?? FILTERS[0]!;
  const history = useHistory(group.kinds.length === 1 ? group.kinds[0] : null);
  const me = useMe();
  const silicons = useEverySilicon();
  const feed = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [zone] = useState(browserTimezone);
  const [now] = useState(() => Date.now());
  const timeZone = me.data?.timezone ?? zone;
  // Rows wait for the account's timezone so their days and times never redraw after a first paint in the browser's.
  const zoneKnown = !!me.data || me.isError;

  // The custodian's Silicons, so a row about one of them names it by its si:id without a lookup.
  const carbon = asCarbon(me.data);
  const siliconIds = new Map((carbon ? silicons.data?.items ?? [] : []).map(item => [item.uuid, item.id] as const));
  const context: DetailContext = {
    me: me.data ? { uuid: me.data.uuid, id: me.data.id, kind: me.data.kind } : undefined,
    siliconId: uuid => siliconIds.get(uuid),
  };

  const loaded = history.data?.pages.flatMap(page => page.items) ?? [];
  const items = group.kinds.length > 1 ? loaded.filter(item => group.kinds.includes(item.kind)) : loaded;
  const days: Array<{ key: string; items: HistoryItem[] }> = [];
  for (const item of items) {
    const key = dayKey(Date.parse(item.at), timeZone);
    const day = days[days.length - 1];
    if (day?.key === key) day.items.push(item);
    else days.push({ key, items: [item] });
  }
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });

  /** Loads the next page; when it was the last, focus moves from the gone button to the first row it brought. */
  const showOlder = async () => {
    const before = feed.current?.querySelectorAll("li").length ?? 0;
    const hadFocus = !!moreButton.current && document.activeElement === moreButton.current;
    const result = await history.fetchNextPage();
    if (!hadFocus || result.isError || result.hasNextPage) return;
    handFocus(pageMain(), () => {
      const row = feed.current?.querySelectorAll<HTMLElement>("li")[before];
      if (!row) return null;
      row.tabIndex = -1;
      row.setAttribute("data-focus-landing", "");
      return row;
    });
  };

  return (
    <div>
      <PageBar title="Activity" />
      <Page>
        <p className={styles.lead}>What you, your Silicons and your apps did, newest first. Times are in {timezoneLabel(timeZone)}.</p>
        <div className={styles.toolbar}>
          <SegmentedControl label="Show" value={filter} onValueChange={value => setFilter(value as Filter)} options={FILTERS.map(({ value, label }) => ({ value, label }))} />
        </div>
        {history.error && !history.data ? (
          <Alert tone="danger" title="Your activity did not load">
            {describeError(history.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void history.refetch()}>Try Again</Button></span>
          </Alert>
        ) : !history.data || !zoneKnown ? (
          <div className={styles.skeleton} aria-busy="true" aria-label="Loading your activity"><Skeleton label="Loading" lines={6} avatar /></div>
        ) : !items.length && !history.hasNextPage ? (
          <div className={styles.empty}>
            {/* Names what the filter shows, so the empty state's heading sits one level under the page's: h1, h2, h3. */}
            <h2 className="sr-only">{filter === "all" ? "All activity" : group.label}</h2>
            <EmptyState icon={<History width={24} height={24} strokeWidth={1.5} />} title="Nothing here yet" description={EMPTY[filter]} />
          </div>
        ) : (
          <div ref={feed} role="region" aria-label="Account activity" className={styles.feed}>
            {days.map(day => (
              <Section key={day.key} id={`activity-${day.key}`} title={dayLabel(day.key, now, timeZone)}>
                {day.items.map(item => {
                  // Times inside the service's sentences read in the account's timezone, like the times around them.
                  const detail = [item.detail ? readableTimes(item.detail, { timeZone }) : null, siliconOf(item, context), item.app && !item.title.includes(item.app.name) ? item.app.name : null].filter(Boolean).join(" · ");
                  return (
                    <Row
                      key={item.id}
                      lead={item.app && item.app.app_id !== FIRST_PARTY ? <AppMark app={withAppIcon(item.app)} size={28} className={styles.mark} decorative /> : <Tile>{ICONS[item.kind] ?? <History size={16} strokeWidth={2} />}</Tile>}
                      title={readableTimes(item.title, { timeZone })}
                      detail={detail || undefined}
                    >
                      <time className={styles.time} dateTime={item.at}>{time.format(Date.parse(item.at))}</time>
                    </Row>
                  );
                })}
              </Section>
            ))}
            {!items.length ? <p className={styles.none}>Nothing here in your recent activity.</p> : null}
            {history.hasNextPage ? (
              <div className={styles.more}>
                <Button ref={moreButton} variant="secondary" onClick={() => void showOlder()} loading={history.isFetchingNextPage}>Show Older Activity</Button>
              </div>
            ) : null}
            {history.isFetchNextPageError ? <p className={styles.error} role="alert">{describeError(history.error)}</p> : null}
          </div>
        )}
      </Page>
    </div>
  );
}
