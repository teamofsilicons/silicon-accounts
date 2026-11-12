"use client";

/**
 * /__activity: the Activity page as it is, beside three other ways to draw the same history (Anil, 2026-11-12: "it's
 * pretty good; a playground with 2 or 3 alternative designs"). All four read the real history (GET /v1/me/history), the
 * first page of 50, in the account's timezone; nothing here acts.
 *
 *   Now                 the page: a section per day, the kind's icon, the time at the end
 *   B · Who leads       one list with light day dividers; who acted leads each row (your photo, the app, the Silicon)
 *   C · Worth a look    what may need you first (failed sign-ins, new permissions), then the rest with repeats folded
 *   D · Compact         a dense log: one line per event, filtered by who (Everyone, You, Silicons, Apps)
 */
import { useState, type ReactNode } from "react";
import { History, LogIn, ShieldAlert } from "lucide-react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@teamofsilicons/silicon-ui/tabs";
import { Activity } from "@/components/account/activity/activity";
import { siliconOf, type DetailContext } from "@/components/account/activity/history-details";
import { AppMark } from "@/components/account/parts/app-mark";
import { withAppIcon } from "@/components/account/parts/app-icons";
import { asCarbon, readableTimes } from "@/components/account/parts/common";
import { useEverySilicon } from "@/components/account/parts/queries";
import { Tile } from "@/components/account/parts/rows";
import { SiliconMark } from "@/components/account/parts/silicon-mark";
import type { HistoryItem, Me } from "@/lib/api/types";
import { useHistory } from "@/lib/query/account";
import { useMe } from "@/lib/query/session";
import styles from "./activity-lab.module.css";

const FIRST_PARTY = "silicon-accounts";

type Actor = { kind: "you" } | { kind: "app"; app: NonNullable<HistoryItem["app"]> } | { kind: "silicon"; uuid: string; id: string };

/** Who acted, as far as the row says: an app it names, a Silicon it is about, else you. */
function actorOf(item: HistoryItem, ctx: DetailContext): Actor {
  if (item.app && item.app.app_id !== FIRST_PARTY) return { kind: "app", app: item.app };
  const meta = item.meta && typeof item.meta === "object" ? item.meta : {};
  const silicon = meta.silicon && typeof meta.silicon === "object" ? (meta.silicon as { uuid?: string }) : null;
  const uuid = silicon?.uuid ?? (meta.target_kind === "silicon" && typeof meta.target_id === "string" ? meta.target_id : null);
  const id = siliconOf(item, ctx);
  if (uuid && id) return { kind: "silicon", uuid, id };
  return { kind: "you" };
}

/** What may need you: a failed sign-in, or an app getting permission to act for you. */
const worthALook = (item: HistoryItem) => /^Failed sign-in/i.test(item.title) || / got a proof to act for you at /.test(item.title);

function ActorMark({ actor, me, size = 28 }: { actor: Actor; me: Me | undefined; size?: number }) {
  if (actor.kind === "app") return <AppMark app={withAppIcon(actor.app)} size={size} className={styles.mark} decorative />;
  if (actor.kind === "silicon") return <SiliconMark seed={actor.uuid} size={size} />;
  return <Avatar name={me?.display_name ?? "You"} src={me?.pfp_url} size="sm" />;
}

const actorName = (actor: Actor) => (actor.kind === "app" ? actor.app.name : actor.kind === "silicon" ? actor.id : "You");

/** The row's sentence, led by who acted, without saying the name twice when the service's title already starts with it. */
function Sentence({ actor, title }: { actor: Actor; title: string }) {
  const name = actorName(actor);
  if (title.startsWith(`${name} `)) return <><strong>{name}</strong>{title.slice(name.length)}</>;
  return <><strong>{name}</strong> · {title}</>;
}

interface Day { key: string; label: string; items: HistoryItem[] }

function daysOf(items: HistoryItem[], timeZone: string, now: number): Day[] {
  const key = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);
  const today = key(now);
  const yesterday = key(now - 86_400_000);
  const days: Day[] = [];
  for (const item of items) {
    const k = key(Date.parse(item.at));
    const last = days[days.length - 1];
    if (last?.key === k) last.items.push(item);
    else days.push({ key: k, label: k === today ? "Today" : k === yesterday ? "Yesterday" : new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${k}T12:00:00Z`)), items: [item] });
  }
  return days;
}

export function ActivityLab() {
  const history = useHistory(null);
  const me = useMe();
  const silicons = useEverySilicon();
  const [now] = useState(() => Date.now());
  const timeZone = me.data?.timezone ?? "UTC";
  const carbon = asCarbon(me.data);
  const siliconIds = new Map((carbon ? silicons.data?.items ?? [] : []).map(item => [item.uuid, item.id] as const));
  const ctx: DetailContext = { me: me.data ? { uuid: me.data.uuid, id: me.data.id, kind: me.data.kind } : undefined, siliconId: uuid => siliconIds.get(uuid) };
  const items = history.data?.pages[0]?.items ?? [];
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const detailOf = (item: HistoryItem) => (item.detail ? readableTimes(item.detail, { timeZone }) : null);
  const days = daysOf(items, timeZone, now);
  const ready = !!history.data && !!me.data;

  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Activity designs</h1>
        <p className={styles.lede}>Your real history (the newest 50), four ways. Only the page as it is (Now) is built; the others are drawings. Nothing here acts.</p>
      </header>
      <Tabs defaultValue="b" className={styles.tabs}>
        <TabsList aria-label="Designs">
          <TabsTrigger value="now">Now</TabsTrigger>
          <TabsTrigger value="b">B · Who leads</TabsTrigger>
          <TabsTrigger value="c">C · Worth a look</TabsTrigger>
          <TabsTrigger value="d">D · Compact</TabsTrigger>
        </TabsList>
        <TabsContent value="now"><div className={styles.frame}><Activity /></div></TabsContent>
        <TabsContent value="b">{ready ? <WhoLeads days={days} ctx={ctx} me={me.data} time={time} detailOf={detailOf} /> : <Loading />}</TabsContent>
        <TabsContent value="c">{ready ? <WorthALook items={items} days={days} ctx={ctx} me={me.data} time={time} detailOf={detailOf} /> : <Loading />}</TabsContent>
        <TabsContent value="d">{ready ? <Compact items={items} ctx={ctx} me={me.data} timeZone={timeZone} now={now} time={time} detailOf={detailOf} /> : <Loading />}</TabsContent>
      </Tabs>
    </main>
  );
}

function Loading() {
  return <div className={styles.page}><Skeleton label="Loading" lines={6} avatar /></div>;
}

interface Shared { ctx: DetailContext; me: Me | undefined; time: Intl.DateTimeFormat; detailOf: (item: HistoryItem) => string | null }

/** One event as a row: who leads, the sentence, its detail line, the time. */
function EventRow({ item, ctx, me, time, detailOf, flag, action }: Shared & { item: HistoryItem; flag?: ReactNode; action?: ReactNode }) {
  const actor = actorOf(item, ctx);
  const detail = detailOf(item);
  return (
    <li className={styles.row} data-flag={flag ? "" : undefined}>
      <ActorMark actor={actor} me={me} />
      <span className={styles.text}>
        <span className={styles.sentence}><Sentence actor={actor} title={item.title} /></span>
        {detail ? <span className={styles.detail}>{detail}</span> : null}
      </span>
      {flag}
      {action}
      <time className={styles.time} dateTime={item.at}>{time.format(Date.parse(item.at))}</time>
    </li>
  );
}

/* B: one list, day dividers inside it, who leads ------------------------------------------------------------------- */

function WhoLeads({ days, ...shared }: Shared & { days: Day[] }) {
  return (
    <div className={styles.page}>
      <p className={styles.lede}>What you, your Silicons and your apps did, newest first.</p>
      <ul data-sq="surface" className={styles.list}>
        {days.map(day => (
          <DayBlock key={day.key} label={day.label}>
            {day.items.map(item => <EventRow key={item.id} item={item} {...shared} />)}
          </DayBlock>
        ))}
      </ul>
    </div>
  );
}

function DayBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <li className={styles.divider} role="presentation"><span>{label}</span></li>
      {children}
    </>
  );
}

/* C: what may need you first, then the rest with repeats folded ------------------------------------------------------ */

function WorthALook({ items, days, ...shared }: Shared & { items: HistoryItem[]; days: Day[] }) {
  const flagged = items.filter(worthALook);
  return (
    <div className={styles.page}>
      {flagged.length ? (
        <section className={styles.look} aria-labelledby="look-title">
          <div className={styles.lookHead}>
            <h2 id="look-title" className={styles.h2}>Worth a look</h2>
            <Badge size="sm" tone="warning">{flagged.length}</Badge>
          </div>
          <ul data-sq="surface" className={`${styles.list} ${styles.lookList}`}>
            {flagged.slice(0, 4).map(item => (
              <EventRow
                key={item.id}
                item={item}
                {...shared}
                flag={<span className={styles.flagIcon} aria-hidden="true"><ShieldAlert size={16} strokeWidth={2} /></span>}
                action={<Button variant="secondary" size="sm">{/^Failed/.test(item.title) ? "Not You?" : "Review"}</Button>}
              />
            ))}
          </ul>
        </section>
      ) : (
        <p className={styles.allClear}>Nothing unusual in your recent activity.</p>
      )}
      <h2 className={styles.h2}>Everything</h2>
      <ul data-sq="surface" className={styles.list}>
        {days.map(day => (
          <DayBlock key={day.key} label={day.label}>
            {fold(day.items).map(group => group.length > 1
              ? <FoldedRow key={group[0]!.id} group={group} {...shared} />
              : <EventRow key={group[0]!.id} item={group[0]!} {...shared} />)}
          </DayBlock>
        ))}
      </ul>
    </div>
  );
}

/** Consecutive events with the same words, folded into one. */
function fold(items: HistoryItem[]): HistoryItem[][] {
  const groups: HistoryItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.title === item.title) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

function FoldedRow({ group, ctx, me, time }: Shared & { group: HistoryItem[] }) {
  const [open, setOpen] = useState(false);
  const first = group[0]!;
  const actor = actorOf(first, ctx);
  return (
    <li className={styles.row}>
      <ActorMark actor={actor} me={me} />
      <span className={styles.text}>
        <span className={styles.sentence}><Sentence actor={actor} title={first.title} /> <span className={styles.times}>×{group.length}</span></span>
        {open ? <span className={styles.detail}>{group.map(item => time.format(Date.parse(item.at))).join(", ")}</span> : null}
      </span>
      <Button variant="link" size="sm" onClick={() => setOpen(value => !value)}>{open ? "Hide" : "Show All"}</Button>
      <time className={styles.time} dateTime={first.at}>{time.format(Date.parse(first.at))}</time>
    </li>
  );
}

/* D: a dense log, filtered by who ------------------------------------------------------------------------------------ */

type Who = "everyone" | "you" | "silicons" | "apps";

function Compact({ items, ctx, me, timeZone, now, time, detailOf }: Shared & { items: HistoryItem[]; timeZone: string; now: number }) {
  const [who, setWho] = useState<Who>("everyone");
  const shown = items.filter(item => {
    const actor = actorOf(item, ctx);
    return who === "everyone" || (who === "you" && actor.kind === "you") || (who === "silicons" && actor.kind === "silicon") || (who === "apps" && actor.kind === "app");
  });
  const days = daysOf(shown, timeZone, now);
  return (
    <div className={styles.page}>
      <SegmentedControl label="Who" value={who} onValueChange={value => setWho(value as Who)} options={[{ value: "everyone", label: "Everyone" }, { value: "you", label: "You" }, { value: "silicons", label: "Silicons" }, { value: "apps", label: "Apps" }]} />
      {days.length ? days.map(day => (
        <section key={day.key} className={styles.compactDay} aria-label={day.label}>
          <h2 className={styles.compactHead}>{day.label}</h2>
          <ul className={styles.compactList}>
            {day.items.map(item => {
              const actor = actorOf(item, ctx);
              const detail = detailOf(item);
              return (
                <li key={item.id} className={styles.compactRow} data-flag={worthALook(item) ? "" : undefined}>
                  <time className={styles.compactTime} dateTime={item.at}>{time.format(Date.parse(item.at))}</time>
                  <ActorMark actor={actor} me={me} size={20} />
                  <span className={styles.compactText}>{item.title}{detail ? <span className={styles.compactDetail}> · {detail}</span> : null}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )) : (
        <p className={styles.allClear}><Tile><History size={16} strokeWidth={2} /></Tile> Nothing from {who === "you" ? "you" : who} in your recent activity.</p>
      )}
      <p className={styles.legend}><LogIn size={14} strokeWidth={2} aria-hidden="true" /> A dense log: every event on one line, the time first, who acted beside it.</p>
    </div>
  );
}
