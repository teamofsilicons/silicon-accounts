/**
 * /activity: what happened to this account, newest first and grouped by day in your timezone: sign-ins, id changes,
 * custodian changes, proofs, app access and security events. Rows with more to say open in place.
 */
import { For, Match, Show, Switch, batch, createEffect, createMemo, createSignal, on } from "solid-js";
import { AtSign, Cpu, History, LayoutGrid, LockKeyhole, LogIn, ShieldCheck } from "lucide-solid";
import { api, ApiError, collectPages, type HistoryItem, type HistoryKind, type ManagedSilicon } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { Button } from "../../arc/button/button";
import { EmptyState } from "../../arc/empty-state/empty-state";
import { SegmentedControl } from "../../arc/segmented-control/segmented-control";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { Timeline, type TimelineEvent } from "../../arc/timeline/timeline";
import { Page, PageHeader } from "../../app/layout/layout";
import { browserTimezone } from "../../lib/format";
import { timezoneLabel } from "../../lib/timezones";
import { theme } from "../../theme/theme";
import { asCarbon, createLoader, createNow, currentMe, describeError, readableTimes } from "./parts/common";
import { historyDetails, siliconOf, type DetailContext } from "./parts/history-details";
import styles from "./activity.module.css";
import "./parts/telemetry";

type Filter = "all" | HistoryKind;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "signin", label: "Sign-ins" },
  { value: "id_change", label: "Id changes" },
  { value: "custodian", label: "Custodian" },
  { value: "proof", label: "Proofs" },
  { value: "app_access", label: "App access" },
  { value: "security", label: "Security" },
];

const EMPTY: Record<Filter, string> = {
  all: "Sign-ins, id changes, custodian changes, proofs and app access show up here as they happen.",
  signin: "Each time you sign in to an app or to this site, it shows up here.",
  id_change: "When your id changes, the old and new ids show up here.",
  custodian: "Silicons you take on, hand over or are asked to look after show up here.",
  proof: "Proofs apps get to act for you, and the ones you revoke, show up here.",
  app_access: "Apps you remove, and apps that import your account, show up here.",
  security: "Changes to how you sign in show up here.",
};

const ICONS: Record<HistoryKind, () => ReturnType<typeof LogIn>> = {
  signin: () => <LogIn size={14} stroke-width={2} />,
  id_change: () => <AtSign size={14} stroke-width={2} />,
  custodian: () => <Cpu size={14} stroke-width={2} />,
  proof: () => <ShieldCheck size={14} stroke-width={2} />,
  app_access: () => <LayoutGrid size={14} stroke-width={2} />,
  security: () => <LockKeyhole size={14} stroke-width={2} />,
};

/**
 * The history for one filter, a page at a time. Results for a new filter replace the old ones in one step (with the
 * filter they belong to), so the timeline can start over for each filter instead of mixing rows.
 */
function createHistory(filter: () => Filter) {
  const [shown, setShown] = createSignal<{ filter: Filter; items: HistoryItem[]; cursor: string | null } | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [error, setError] = createSignal<ApiError>();
  let generation = 0;
  const kind = (value: Filter) => (value === "all" ? undefined : value);
  const load = async () => {
    const token = ++generation;
    const wanted = filter();
    setLoading(true);
    setError(undefined);
    try {
      const page = await api.me.history({ limit: 50, kind: kind(wanted) });
      if (token !== generation) return;
      batch(() => {
        setShown({ filter: wanted, items: page.items, cursor: page.next_cursor });
        setLoading(false);
      });
    } catch (raw) {
      if (token !== generation) return;
      batch(() => {
        // The rows on screen belong to the previous filter: drop them, so the failure (with Try again) is all that shows
        // under the new filter's name.
        setShown(null);
        setError(ApiError.from(raw));
        setLoading(false);
      });
    }
  };
  const more = async () => {
    const current = shown();
    if (!current?.cursor || loadingMore()) return;
    const token = generation;
    setLoadingMore(true);
    try {
      const page = await api.me.history({ limit: 50, cursor: current.cursor, kind: kind(current.filter) });
      if (token !== generation) return;
      setShown({ ...current, items: [...current.items, ...page.items], cursor: page.next_cursor });
    } catch (raw) {
      if (token === generation) setError(ApiError.from(raw));
    } finally {
      setLoadingMore(false);
    }
  };
  createEffect(on(filter, () => void load()));
  return {
    shown,
    items: () => shown()?.items ?? [],
    loading,
    loadingMore,
    error,
    hasMore: () => !!shown()?.cursor,
    reload: load,
    loadMore: more,
  };
}

export default function Activity() {
  const [filter, setFilter] = createSignal<Filter>("all");
  const list = createHistory(filter);
  const now = createNow(60_000);
  const timeZone = () => currentMe()?.timezone ?? browserTimezone();

  // The custodian's Silicons, so rows about one of them name it by its si:id without a lookup.
  const silicons = createLoader(() => collectPages<ManagedSilicon>(query => api.me.silicons.list(query), 5), { immediate: false });
  createEffect(on(() => asCarbon(currentMe())?.custodian_of ?? 0, count => { if (count > 0 && !silicons.data()) void silicons.reload(); }));
  const siliconIds = createMemo(() => new Map((silicons.data() ?? []).map(item => [item.uuid, item.id] as const)));
  const context: DetailContext = {
    get me() {
      const me = currentMe();
      return me ? { uuid: me.uuid, id: me.id, kind: me.kind } : undefined;
    },
    siliconId: uuid => siliconIds().get(uuid),
  };

  const events = createMemo<TimelineEvent[]>(() =>
    list.items().map(item => {
      const rows = historyDetails(item, context);
      const logo = item.app ? (theme() === "dark" && item.app.logo_dark_url ? item.app.logo_dark_url : item.app.logo_url) : null;
      return {
        id: item.id,
        at: item.at,
        title: readableTimes(item.title),
        meta: [item.detail ? readableTimes(item.detail) : null, siliconOf(item, context), item.app && !item.title.includes(item.app.name) ? item.app.name : null].filter(Boolean).join(" · ") || undefined,
        avatar: logo ?? undefined,
        icon: ICONS[item.kind] ?? (() => <History size={14} stroke-width={2} />),
        detail: rows.length
          ? () => (
            <dl class={styles.detail}>
              <For each={rows}>{row => <div><dt>{row.label}</dt><dd>{row.value()}</dd></div>}</For>
            </dl>
          )
          : undefined,
      };
    }),
  );

  return (
    <Page width="reading">
      <PageHeader title="Activity" description={`Everything that happened to your account, newest first. Days and times are in ${timezoneLabel(timeZone())}, your timezone.`} />
      <div class={styles.toolbar}>
        <SegmentedControl label="Show" value={filter()} onValueChange={setFilter} options={FILTERS} size="sm" />
      </div>
      <Switch>
        <Match when={list.error() && !list.shown()}>
          <Alert tone="danger" title="Your activity did not load" action={<Button variant="secondary" onClick={() => void list.reload()}>Try again</Button>}>{describeError(list.error())}</Alert>
        </Match>
        <Match when={!list.shown()}>
          <div class={styles.skeleton} aria-busy="true" aria-label="Loading your activity">
            <SkeletonBlock width="180px" height="18px" radius="6px" />
            <For each={[0, 1, 2, 3, 4]}>
              {index => (
                <div class={styles.skeletonRow}>
                  <SkeletonBlock width="28px" height="28px" radius="10px" index={index} />
                  <SkeletonBlock width={`${70 - index * 6}%`} height="18px" radius="6px" index={index} />
                </div>
              )}
            </For>
          </div>
        </Match>
        <Match when={!list.items().length}>
          <div class={styles.empty}>
            <EmptyState icon={<History width={24} height={24} stroke-width={1.5} />} title="Nothing here yet" description={EMPTY[filter()]} />
          </div>
        </Match>
        <Match when={true}>
          <div class={styles.feed} aria-busy={list.loading() || undefined} data-loading={list.loading() || undefined}>
            <Show when={list.shown()?.filter} keyed>
              {(_filter: Filter) => <Timeline events={events()} now={now()} label="Account activity" timeZone={timeZone()} headingLevel={2} />}
            </Show>
          </div>
          <Show when={list.hasMore()}>
            <div class={styles.more}>
              <Button variant="secondary" onClick={() => void list.loadMore()} loading={list.loadingMore()}>Show older activity</Button>
            </div>
          </Show>
          <Show when={list.error() && list.items().length}>
            <p class={styles.error} role="alert">{describeError(list.error())}</p>
          </Show>
        </Match>
      </Switch>
    </Page>
  );
}
