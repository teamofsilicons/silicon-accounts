/**
 * Identity home (/ when signed in, and /identity): your identity as an object. The card carries your photo (drop a new
 * one on it), your display name (edit it in place), your id (change it; the old one stays reserved for you for 10
 * days), your uuid, the time where you are, and a stamp for every app you have signed into. Turn it over for your
 * emails, phone numbers and date of birth. Beside it: counts that open each section and your latest activity.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { ArrowLeft, ArrowRight, Inbox } from "lucide-solid";
import { api, collectPages, type HistoryItem, type Me, type MyApp, type ProfileUpdate } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { AnimatedCounter } from "../../arc/animated-counter/animated-counter";
import { Badge } from "../../arc/badge/badge";
import { Button } from "../../arc/button/button";
import { Dialog, DialogContent } from "../../arc/dialog/dialog";
import { InlineEdit } from "../../arc/inline-edit/inline-edit";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { TextMorph } from "../../arc/text-morph/text-morph";
import { useSquircle } from "../../arc/lib/squircle";
import { IdentityCard, IdentityField, LiveClock, StampRow, useIdentityCard, type StampProps } from "../../app/identity/IdentityCard";
import { Page, PageHeader } from "../../app/layout/layout";
import { registerCommands } from "../../app/commands";
import { paths } from "../../app/navigation";
import { refreshMe, setMe } from "../../app/session";
import { formatDate, formatPhone, formatRelative, kindNoun, plural } from "../../lib/format";
import { timezoneLabel, utcOffset } from "../../lib/timezones";
import { theme } from "../../theme/theme";
import { asCarbon, asSilicon, createLoader, createNow, currentMe, describeError, meError, readableTimes, reasonError, reportFailure } from "./parts/common";
import { DobEditor, TimezoneEditor } from "./parts/DetailEditors";
import { IdChangeForm } from "./parts/IdChangeForm";
import { PhotoControl } from "./parts/PhotoControl";
import styles from "./identity.module.css";
import "./parts/telemetry";

const RESERVED_DAYS = 10;

/** Saves part of the profile and puts the server's answer in place everywhere (dock, card, pages). */
async function saveProfile(patch: ProfileUpdate): Promise<Me> {
  const next = await api.me.update(patch);
  setMe(next);
  return next;
}

function validateName(next: string): string | null {
  if (!next) return "Enter a display name.";
  if (next.length > 100) return `A display name can be at most 100 characters (this one has ${next.length}).`;
  if (/[\u0000-\u001f\u007f]/.test(next)) return "Remove tabs, line breaks and other control characters.";
  return null;
}

export default function Identity() {
  const account = currentMe;
  const apps = createLoader(() => collectPages<MyApp>(query => api.me.apps.list(query), 5));
  const recent = createLoader(() => api.me.history({ limit: 4 }).then(page => page.items));
  const requests = createLoader(() => api.me.custodianRequests.list({ limit: 50 }).then(page => page.items), { immediate: false });
  createEffect(on(() => account()?.kind, kind => { if (kind === "carbon") void requests.reload(); }));

  const [changingId, setChangingId] = createSignal(false);
  const [reserved, setReserved] = createSignal<{ id: string; until: number } | null>(null);
  let idInput: HTMLInputElement | undefined;

  registerCommands(() => [
    { id: "identity.change-id", label: "Change your id", description: "Pick a new c:id; the old one stays reserved for you for 10 days", group: "Identity", keywords: ["id", "handle", "username", "rename"], run: () => setChangingId(true) },
  ]);

  const stamps = createMemo<StampProps[]>(() =>
    (apps.data() ?? [])
      .filter(item => item.status === "active")
      .map(item => ({
        name: item.app.name,
        logoUrl: theme() === "dark" && item.app.logo_dark_url ? item.app.logo_dark_url : item.app.logo_url,
        seed: item.app.app_id,
        href: `${paths.apps}#app-${item.app.app_id}`,
      })),
  );

  return (
    <Page>
      <PageHeader title="Your identity" description="One account for every app you use. Apps keep your uuid; your id is yours to change." />
      <Switch fallback={<LayoutSkeleton />}>
        <Match when={meError()}>
          {error => (
            <Alert tone="danger" title="Your account did not load" action={<Button variant="secondary" onClick={() => refreshMe()}>Try again</Button>}>
              {describeError(error())}
            </Alert>
          )}
        </Match>
        <Match when={account()}>
          {me => (
            <div class={styles.layout}>
              <IdentityCard
                label={`Identity card of ${me().id ?? me().display_name}`}
                front={<Front account={me()} stamps={stamps()} appsLoading={apps.loading()} appsError={!apps.data() && !!apps.error()} onRetryApps={() => void apps.reload()} reserved={reserved()} onChangeId={() => setChangingId(true)} />}
                back={<Back account={me()} />}
              />
              <Glance
                account={me()}
                apps={apps.data()}
                appsError={!apps.data() && !!apps.error()}
                recent={recent.data()}
                recentError={!!recent.error()}
                requests={requests.data()?.length ?? 0}
                requestsError={!requests.data() && !!requests.error()}
              />
              <Dialog open={changingId()} onOpenChange={setChangingId}>
                <DialogContent
                  title="Change your id"
                  description={me().id ? `Your id is ${me().id} now.` : "Pick the id people will type to find you."}
                  onOpenAutoFocus={event => { event.preventDefault(); queueMicrotask(() => idInput?.focus()); }}
                >
                  <IdChangeForm
                    prefix={me().kind === "carbon" ? "c:" : "si:"}
                    currentId={me().id}
                    uuid={me().uuid}
                    subject="self"
                    inputRef={el => (idInput = el)}
                    submit={id => api.me.changeId(id).then(next => setMe(next))}
                    onChanged={(_, previous) => {
                      setChangingId(false);
                      if (previous) setReserved({ id: previous, until: Date.now() + RESERVED_DAYS * 86_400_000 });
                    }}
                    onCancel={() => setChangingId(false)}
                  />
                </DialogContent>
              </Dialog>
            </div>
          )}
        </Match>
      </Switch>
    </Page>
  );
}

/* --------------------------------------------------- the card --------------------------------------------------- */

/** Ids longer than this get the card's whole row, so they show in full instead of fading out at the column's edge. */
const LONG_ID = 12;

function Front(props: { account: Me; stamps: StampProps[]; appsLoading: boolean; appsError: boolean; onRetryApps: () => void; reserved: { id: string; until: number } | null; onChangeId: () => void }) {
  const card = useIdentityCard();
  const id = () => props.account.id ?? "";
  const saveName = async (next: string) => {
    try {
      await saveProfile({ display_name: next });
    } catch (error) {
      reportFailure(error, "Your display name did not change");
      throw reasonError(error);
    }
  };
  return (
    <div class={styles.front}>
      <div class={styles.who}>
        <PhotoControl account={props.account} onChange={next => setMe(next)} />
        <div class={styles.names}>
          <InlineEdit as="h2" variant="display" label="Display name" value={props.account.display_name} onSave={saveName} validate={validateName} maxLength={100} />
          <div class={styles.badges}>
            <Badge tone={props.account.status === "active" ? "success" : "warning"} dot>{kindNoun(props.account.kind)}</Badge>
            <span class={styles.since}>since {formatDate(props.account.created_at)}</span>
          </div>
        </div>
      </div>
      <div class={styles.fields}>
        <div class={styles.field} data-wide={id().length > LONG_ID || undefined}>
          <IdentityField label="Id" value={id()} copyLabel="Copy id">
            {/* A very long id fades out at the edge (TextMorph's soft mask) instead of running under the next field. */}
            <span class={styles.idValue} title={id() || undefined}><TextMorph class={styles.idMorph}>{id() || "No id yet"}</TextMorph></span>
          </IdentityField>
          <button ref={el => useSquircle(el)} type="button" class={styles.fieldAction} onClick={() => props.onChangeId()}>Change id</button>
          <Show when={props.reserved}>
            {note => <span class={styles.fieldNote}><span class="mono">{note().id}</span> is reserved for you until {formatDate(note().until)}.</span>}
          </Show>
        </div>
        <div class={styles.field}>
          <IdentityField label="uuid" value={props.account.uuid} mono copyLabel="Copy uuid" />
          <span class={styles.fieldNote}>Never changes. Apps know you by it.</span>
        </div>
        <div class={styles.field}>
          <IdentityField label="Local time" value={props.account.timezone}>
            <LiveClock timeZone={props.account.timezone} />
          </IdentityField>
          <TimezoneEditor value={props.account.timezone} onSave={timezone => saveProfile({ timezone })} />
        </div>
      </div>
      <div class={styles.foot}>
        <Switch fallback={<StampsSkeleton />}>
          <Match when={props.appsError}>
            <span class={styles.stampsError} role="alert">
              <span>Your apps did not load, so their stamps are missing.</span>
              <button ref={el => useSquircle(el)} type="button" class={styles.fieldAction} onClick={() => props.onRetryApps()}>Try again</button>
            </span>
          </Match>
          <Match when={!props.appsLoading}>
            <Show when={props.stamps.length} fallback={<span class={styles.noStamps}>Apps you sign into get a stamp here.</span>}>
              <StampRow apps={props.stamps} label="Apps you have signed into" />
            </Show>
          </Match>
        </Switch>
        <Button variant="secondary" size="sm" onClick={card.toggle}>Details<ArrowRight size={16} stroke-width={1.75} aria-hidden="true" /></Button>
      </div>
    </div>
  );
}

function Back(props: { account: Me }) {
  const card = useIdentityCard();
  const carbon = () => asCarbon(props.account);
  const silicon = () => asSilicon(props.account);
  return (
    <div class={styles.back}>
      <div class={styles.backHead}>
        <h2 class={styles.backTitle}>Details</h2>
        <Button variant="ghost" size="sm" onClick={card.toggle}><ArrowLeft size={16} stroke-width={1.75} aria-hidden="true" />Back</Button>
      </div>
      <dl class={styles.details}>
        <Show when={carbon()}>
          {c => (
            <>
              <Row label="Emails">
                <For each={c().emails} fallback={<span class={styles.muted}>No email yet</span>}>
                  {email => <span class={styles.contact}><span class={styles.contactText}>{email.email}</span><Show when={email.is_primary}><Badge size="sm" tone="info">Primary</Badge></Show></span>}
                </For>
              </Row>
              <Row label="Phone numbers">
                <For each={c().phones} fallback={<span class={styles.muted}>No phone number yet</span>}>
                  {phone => <span class={styles.contact}><span class={styles.contactText}>{formatPhone(phone.phone)}</span><Show when={phone.is_primary}><Badge size="sm" tone="info">Primary</Badge></Show></span>}
                </For>
              </Row>
            </>
          )}
        </Show>
        <Row label="Date of birth">
          <span class={styles.valueLine}>
            <span>{formatDate(props.account.dob)}</span>
            <Show when={carbon()}><DobEditor value={props.account.dob} onSave={dob => saveProfile({ dob })} /></Show>
          </span>
          <Show when={silicon()}><span class={styles.muted}>A Silicon's date of birth is the day its account was created, so it never changes.</span></Show>
        </Row>
        <Row label="Timezone">
          <span>{timezoneLabel(props.account.timezone)} · UTC{utcOffset(props.account.timezone)}</span>
        </Row>
        <Show when={silicon()}>
          {s => (
            <>
              <Row label="Custodian"><span class="mono">{s().custodian?.id ?? "Waiting for a custodian to accept"}</span></Row>
              <Row label="Webhook"><span class={styles.contactText}>{s().webhook_url ?? "Not set"}</span></Row>
              <Row label="STK rotated">{s().stk_rotated_at ? formatDate(s().stk_rotated_at) : "Never"}</Row>
            </>
          )}
        </Show>
      </dl>
      <Show when={carbon()}>
        <A href={paths.signInMethods} class={styles.backLink}>Add or remove emails and phone numbers<ArrowRight size={16} stroke-width={1.75} aria-hidden="true" /></A>
      </Show>
    </div>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/* --------------------------------------------------- beside it --------------------------------------------------- */

interface GlanceProps {
  account: Me;
  apps: MyApp[] | undefined;
  /** The apps list failed to load (the count shows a dash instead of waiting forever). */
  appsError: boolean;
  recent: HistoryItem[] | undefined;
  recentError: boolean;
  requests: number;
  requestsError: boolean;
}

/** A quiet column beside the card: counts that open each section, requests waiting for you, and recent activity. */
function Glance(props: GlanceProps) {
  const now = createNow(30_000);
  const carbon = () => asCarbon(props.account);
  const rows = (): Array<{ label: string; value: number | undefined; failed?: boolean; href: string }> => [
    { label: "Apps you are signed into", value: props.apps?.filter(item => item.status === "active").length, failed: props.appsError, href: paths.apps },
    ...(carbon()
      ? [
        { label: "Silicons in your care", value: carbon()!.custodian_of, href: paths.silicons },
        { label: "Emails and phone numbers", value: carbon()!.emails.length + carbon()!.phones.length, href: paths.signInMethods },
      ]
      : []),
  ];
  return (
    <aside class={styles.glance} aria-label="At a glance">
      <Show when={props.requests > 0 || props.requestsError}>
        <A href={paths.silicons} ref={el => useSquircle(el)} class={styles.waiting}>
          <Inbox size={20} stroke-width={1.75} aria-hidden="true" />
          <span class={styles.waitingText}>
            <Show
              when={!props.requestsError}
              fallback={<>
                <span class={styles.waitingTitle}>Custodian requests did not load</span>
                <span class={styles.waitingMeta}>A Silicon may be waiting for you. Open the Silicons page to see your requests.</span>
              </>}
            >
              <span class={styles.waitingTitle}>{plural(props.requests, "custodian request")} waiting for you</span>
              <span class={styles.waitingMeta}>Accept or decline them on the Silicons page.</span>
            </Show>
          </span>
          <ArrowRight class={styles.glanceArrow} size={16} stroke-width={1.75} aria-hidden="true" />
        </A>
      </Show>
      <div class={styles.counts}>
        <For each={rows()}>
          {row => (
            <A href={row.href} class={styles.glanceRow}>
              <span class={styles.glanceValue}>
                <Switch fallback={<SkeletonBlock width="2ch" height="28px" radius="6px" />}>
                  <Match when={row.value !== undefined}>
                    <AnimatedCounter value={row.value ?? 0} size="inline" />
                  </Match>
                  <Match when={row.failed}>
                    <span aria-hidden="true">–</span>
                    <span class="sr-only">Did not load.</span>
                  </Match>
                </Switch>
              </span>
              <span class={styles.glanceLabel}>
                {row.label}
                <Show when={row.failed && row.value === undefined}><span class={styles.glanceFailed}>Did not load. Open the page to try again.</span></Show>
              </span>
              <ArrowRight class={styles.glanceArrow} size={16} stroke-width={1.75} aria-hidden="true" />
            </A>
          )}
        </For>
      </div>
      <section class={styles.recent} aria-labelledby="identity-recent">
        <div class={styles.recentHead}>
          <h2 id="identity-recent" class={styles.recentTitle}>Recent activity</h2>
          <A href={paths.activity} class={styles.recentAll}>All activity</A>
        </div>
        <Switch>
          <Match when={props.recentError}>
            <p class={styles.muted}>Recent activity did not load. Open Activity to try again.</p>
          </Match>
          <Match when={!props.recent}>
            <div class={styles.recentList}>
              <For each={[0, 1, 2]}>{index => <SkeletonBlock width="100%" height="40px" radius="10px" index={index} />}</For>
            </div>
          </Match>
          <Match when={props.recent?.length === 0}>
            <p class={styles.muted}>Nothing yet. Sign-ins and changes to your account show up here.</p>
          </Match>
          <Match when={props.recent}>
            {items => (
              <ol class={styles.recentList} role="list">
                <For each={items().slice(0, 4)}>
                  {item => (
                    <li class={styles.recentItem}>
                      <span class={styles.recentText}>{readableTimes(item.title)}</span>
                      <time class={styles.recentTime} dateTime={item.at}>{formatRelative(item.at, now())}</time>
                    </li>
                  )}
                </For>
              </ol>
            )}
          </Match>
        </Switch>
      </section>
    </aside>
  );
}

/* --------------------------------------------------- skeletons --------------------------------------------------- */

function StampsSkeleton() {
  return (
    <span class={styles.stampsSkeleton} aria-hidden="true">
      <For each={[0, 1, 2, 3]}>{index => <SkeletonBlock width="40px" height="40px" radius="12px" index={index} />}</For>
    </span>
  );
}

function LayoutSkeleton() {
  return (
    <div class={styles.layout} aria-busy="true" aria-label="Loading your identity">
      <SkeletonBlock width="min(100%, 640px)" height="392px" radius="var(--radius-surface)" />
      <div class={styles.glance}>
        <For each={[0, 1, 2]}>{index => <SkeletonBlock width="100%" height="56px" radius="12px" index={index + 1} />}</For>
      </div>
    </div>
  );
}
