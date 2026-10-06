/**
 * Webhooks: where Silicon Accounts tells the app that something changed about an account that signed into it (id
 * changes, updates, sign-outs, removed access, deletions, Silicon custodian changes). Set or change the URL (a new
 * whsec_ signing secret is shown once), rotate the secret, send a test ping, and see every delivery with its attempts
 * and payload. Failed deliveries can be replayed, one by one, selected, or all at once.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { Pencil, RefreshCw, RotateCw, Send, Trash2, Webhook } from "lucide-solid";
import { api, ApiError, APP_EVENT_TYPES, createPagedList, request, seg, type DeliveryStatus, type ReplayResult, type WebhookDelivery, type WebhookDeliveryDetail } from "../../../api";
import { Accordion } from "../../../arc/accordion/accordion";
import { ActionButton } from "../../../arc/action-button/action-button";
import { Alert } from "../../../arc/alert/alert";
import { Badge } from "../../../arc/badge/badge";
import { Button } from "../../../arc/button/button";
import { CodeBlock } from "../../../arc/code-block/code-block";
import { ConfirmMorph } from "../../../arc/confirm-morph/confirm-morph";
import { CopyButton } from "../../../arc/copy-button/copy-button";
import { Drawer, DrawerContent } from "../../../arc/drawer/drawer";
import { EmptyState } from "../../../arc/empty-state/empty-state";
import { Input } from "../../../arc/input/input";
import { JsonViewer } from "../../../arc/json-viewer/json-viewer";
import { SegmentedControl } from "../../../arc/segmented-control/segmented-control";
import { Skeleton } from "../../../arc/skeleton/skeleton";
import { SortableDataTable, type DataColumn } from "../../../arc/sortable-data-table/sortable-data-table";
import { DescriptionItem, DescriptionList, Section, Surface } from "../../../app/layout/layout";
import { notify, notifyError } from "../../../app/notify";
import { formatDateTime, formatRelative, plural } from "../../../lib/format";
import { useDeveloperApp } from "../lib/context";
import { actionKey } from "../lib/keys";
import { DELIVERY_STATUS, EVENT_DESCRIPTION } from "../lib/labels";
import { webhookUrlProblem } from "../lib/validate";
import { SecretReveal } from "../parts/SecretReveal";
import styles from "./webhooks.module.css";

type Filter = "all" | DeliveryStatus;
type Row = { id: string; type: string; status: DeliveryStatus; attempts: number; response: string | null; created: number; next: number | null; replays: number; delivery: WebhookDelivery };
type DeliveryItem = WebhookDelivery & { url?: string; account_uuid?: string | null; last_attempt_at?: string | null };
type Detail = WebhookDeliveryDetail & { delivery: DeliveryItem & { attempt_count?: number; payload_redacted?: boolean; payload_redacted_reason?: string } };
/** What `POST …/webhook/replay` answers (crates/apps webhooks.rs): the ids queued again, and why the others were not. */
type Replay = ReplayResult & { remaining?: number; not_replayable?: number };
type SkippedEntry = string | { delivery_id?: string; id?: string; reason?: string; message?: string };

const skippedId = (entry: SkippedEntry) => (typeof entry === "string" ? entry : String(entry.delivery_id ?? entry.id ?? ""));
const skippedWhy = (entry: SkippedEntry) => (typeof entry === "string" ? null : entry.message ?? entry.reason ?? null);
const replayedIds = (result: Replay) => (Array.isArray(result.replayed) ? result.replayed.map(String) : []);
const skippedOf = (result: Replay): SkippedEntry[] => (Array.isArray(result.skipped) ? (result.skipped as SkippedEntry[]) : []);

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Retrying" },
  { value: "delivered", label: "Delivered" },
];

const VERIFY_TS = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body exactly as received (a Buffer or string), before JSON.parse.
export function verifyAccountsWebhook(headers: Headers, rawBody: string, secret: string): boolean {
  const timestamp = headers.get("x-accounts-timestamp") ?? "";
  const signature = headers.get("x-accounts-signature") ?? "";
  // Refuse old deliveries so a captured request can't be replayed (5 minutes here).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = "v1=" + createHmac("sha256", secret).update(\`\${timestamp}.\${rawBody}\`).digest("hex");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// Deduplicate on X-Accounts-Event-Id: retries and replays keep the same event_id.`;

const VERIFY_RUST = `// Cargo.toml: silicon-accounts-client
use silicon_accounts_client::verify_and_parse_webhook;

let event = verify_and_parse_webhook(
    &secret,                 // the whole "whsec_…" string
    timestamp_header,        // X-Accounts-Timestamp
    signature_header,        // X-Accounts-Signature: v1=<hex>
    &raw_body,               // the body bytes exactly as received
    std::time::Duration::from_secs(300),
)?;
// event.event_id deduplicates; event.payload is typed (WebhookPayload::Unknown for new types).`;

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function responseOf(delivery: WebhookDelivery): string | null {
  if (delivery.last_status) return `HTTP ${delivery.last_status}`;
  if (delivery.last_error) return delivery.last_error;
  return null;
}

function DeliveryDrawerBody(props: { appId: string; id: string; onReplay: (ids: string[]) => Promise<Replay> }) {
  const [detail, setDetail] = createSignal<Detail>();
  const [error, setError] = createSignal<ApiError>();
  const [replayIssue, setReplayIssue] = createSignal<string | null>(null);
  let generation = 0;
  let reloadTimer = 0;
  onCleanup(() => window.clearTimeout(reloadTimer));
  const load = (id: string, quiet = false) => {
    const mine = ++generation;
    if (!quiet) {
      setDetail(undefined);
      setError(undefined);
    }
    api.apps.webhook.delivery(props.appId, id)
      .then(value => { if (mine === generation) setDetail(value as Detail); })
      .catch(raw => { if (mine === generation && !quiet) setError(ApiError.from(raw)); });
  };
  createEffect(on(() => props.id, id => {
    setReplayIssue(null);
    load(id);
  }));
  // Only a failed or delivered delivery whose account still lets the app see it can be sent again.
  const replayable = (delivery: Detail["delivery"]) => delivery.status !== "pending" && !delivery.payload_redacted;
  const replay = async () => {
    setReplayIssue(null);
    const id = props.id;
    const result = await props.onReplay([id]);
    if (!replayedIds(result).includes(id)) {
      const skipped = skippedOf(result).find(entry => skippedId(entry) === id);
      const why = (skipped && skippedWhy(skipped)) ?? "Silicon Accounts did not queue this delivery again.";
      setReplayIssue(why);
      load(id, true);
      throw new Error(why);
    }
    // Show the new state (queued again) once the button has confirmed in place.
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => load(id, true), 1600);
  };
  return (
    <Switch fallback={<Skeleton lines={6} label="Loading the delivery" />}>
      <Match when={error()}>{failure => <Alert tone="danger" title="The delivery could not be loaded">{failure().message} {failure().hint}</Alert>}</Match>
      <Match when={detail()}>
        {value => {
          const delivery = () => value().delivery;
          const status = () => DELIVERY_STATUS[delivery().status] ?? { label: delivery().status, tone: "neutral" as const };
          return (
            <div class={styles.drawer}>
              <div class={styles.drawerHead}>
                <Badge tone={status().tone} dot={delivery().status === "delivered"}>{status().label}</Badge>
                <span class={styles.muted}>{plural(delivery().attempt_count ?? delivery().attempts, "attempt")}{delivery().manual_replays ? ` · replayed ${plural(delivery().manual_replays, "time")}` : ""}</span>
                <Show when={replayable(delivery())}>
                  <ActionButton label="Replay" pendingLabel="Queuing" successLabel="Queued" onAction={replay} onActionError={() => undefined} />
                </Show>
              </div>
              <Show when={replayIssue()}>{why => <Alert tone="warning" title="Not replayed" onDismiss={() => setReplayIssue(null)}>{why()}</Alert>}</Show>
              <Show when={delivery().status === "pending"}>
                <p class={styles.muted}>{delivery().manual_replays > 0 && (delivery().attempt_count ?? delivery().attempts) === 0 ? "Queued again: it goes out within seconds, to the current URL and signed with the current secret." : "Still being retried, so there is nothing to replay: the next attempt goes out on its own."}</p>
              </Show>
              <DescriptionList>
                <DescriptionItem label="Event"><code class={styles.code}>{delivery().type}</code></DescriptionItem>
                <DescriptionItem label="Event id"><span class={styles.copyLine}><code class={styles.code}>{delivery().event_id}</code><CopyButton value={delivery().event_id} label="Copy event id" iconOnly size="xs" variant="plain" /></span></DescriptionItem>
                <DescriptionItem label="Delivery id"><span class={styles.copyLine}><code class={styles.code}>{delivery().id}</code><CopyButton value={delivery().id} label="Copy delivery id" iconOnly size="xs" variant="plain" /></span></DescriptionItem>
                <Show when={delivery().url}>{url => <DescriptionItem label="Sent to"><code class={styles.code}>{url()}</code></DescriptionItem>}</Show>
                <DescriptionItem label="Created">{formatDateTime(delivery().created_at)}</DescriptionItem>
                <Show when={delivery().delivered_at}>{at => <DescriptionItem label="Delivered">{formatDateTime(at())}</DescriptionItem>}</Show>
                <Show when={delivery().next_attempt_at}>{at => <DescriptionItem label="Next attempt">{formatRelative(at())} ({formatDateTime(at())})</DescriptionItem>}</Show>
              </DescriptionList>
              <section class={styles.attempts} aria-label="Attempts">
                <h3 class={styles.subTitle}>Attempts</h3>
                <Show when={value().attempts.length} fallback={<p class={styles.muted}>No attempt yet; the first one goes out within seconds.</p>}>
                  <ol class={styles.attemptList} role="list">
                    <For each={value().attempts}>
                      {(attempt, index) => {
                        const code = () => (attempt.status_code ?? attempt.status) as number | null | undefined;
                        const ok = () => typeof code() === "number" && (code() as number) >= 200 && (code() as number) < 300;
                        return (
                          <li class={styles.attempt}>
                            <span class={styles.attemptNumber}>{index() + 1}</span>
                            <Badge size="sm" tone={ok() ? "success" : "danger"}>{code() ? `HTTP ${code()}` : "No response"}</Badge>
                            <span class={styles.attemptError}>{ok() ? "Delivered" : String(attempt.error ?? "Failed")}</span>
                            <span class={styles.attemptMeta}>{attempt.duration_ms !== undefined && attempt.duration_ms !== null ? `${attempt.duration_ms} ms · ` : ""}{formatDateTime(String(attempt.attempted_at ?? attempt.at ?? ""))}</span>
                          </li>
                        );
                      }}
                    </For>
                  </ol>
                </Show>
              </section>
              <section class={styles.attempts} aria-label="Payload">
                <h3 class={styles.subTitle}>Payload</h3>
                <Show when={delivery().payload_redacted}>
                  <Alert tone="info" title="Account details are hidden">{delivery().payload_redacted_reason ?? "This account no longer has access to the app, so only its uuid and membership id are shown, and this delivery can't be replayed."}</Alert>
                </Show>
                <Show when={value().payload} fallback={<p class={styles.muted}>No payload stored.</p>}>
                  {payload => <JsonViewer data={payload()} rootName="event" defaultExpandDepth={2} maxHeight={340} label="Webhook payload" />}
                </Show>
              </section>
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

export default function WebhooksTab() {
  const ctx = useDeveloperApp();
  const webhook = () => ctx.app().webhook ?? { url: null, secret_set: false };
  const strict = () => ctx.meta()?.environment === "production";
  const [url, setUrl] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [urlError, setUrlError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [secret, setSecret] = createSignal<{ value: string; reason: "set" | "rotated" } | null>(null);
  const [filter, setFilter] = createSignal<Filter>("all");
  const [selected, setSelected] = createSignal<string[]>([]);
  const [open, setOpen] = createSignal<string | null>(null);
  const [replayResult, setReplayResult] = createSignal<Replay | null>(null);
  // One key per logical action, reused by its retries: a set or rotation whose answer was lost shows the same secret
  // again (for 10 minutes) instead of making another one, and a ping or replay is never sent twice.
  const keys = { set: actionKey(), rotate: actionKey(), test: actionKey(), replay: actionKey() };
  const webhookPath = (suffix = "") => `/v1/apps/${seg(ctx.appId)}/webhook${suffix}`;

  const list = createPagedList(query => api.apps.webhook.deliveries(ctx.appId, { ...query, status: filter() === "all" ? undefined : (filter() as DeliveryStatus) }), { limit: 50, immediate: false });
  createEffect(on(filter, () => { setSelected([]); void list.reset(); }));

  const rows = createMemo<Row[]>(() => list.items().map(delivery => ({
    id: delivery.id,
    type: delivery.type,
    status: delivery.status,
    attempts: delivery.attempts,
    response: responseOf(delivery),
    created: new Date(delivery.created_at).getTime(),
    next: delivery.next_attempt_at ? new Date(delivery.next_attempt_at).getTime() : delivery.delivered_at ? new Date(delivery.delivered_at).getTime() : null,
    replays: delivery.manual_replays,
    delivery,
  })));

  const saveUrl = async () => {
    const value = url().trim();
    const problem = webhookUrlProblem(value, strict());
    setUrlError(problem);
    if (problem) return;
    setSaving(true);
    try {
      const result = await request<{ url: string; secret: string }>(webhookPath(), { method: "PUT", body: { url: value }, idempotencyKey: keys.set.for(value) });
      keys.set.done();
      setSecret({ value: result.secret, reason: "set" });
      setEditing(false);
      setUrl("");
      ctx.setApp({ ...ctx.app(), webhook: { url: result.url, secret_set: true } });
      void ctx.reload();
    } catch (raw) {
      const error = ApiError.from(raw);
      setUrlError(error.fields.url ?? `${error.message}${error.hint ? ` ${error.hint}` : ""}`);
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    const result = await request<{ secret: string }>(webhookPath("/rotate-secret"), { method: "POST", body: {}, idempotencyKey: keys.rotate.for("rotate") });
    keys.rotate.done();
    setSecret({ value: result.secret, reason: "rotated" });
    ctx.setApp({ ...ctx.app(), webhook: { url: webhook().url, secret_set: true } });
  };

  const remove = async () => {
    await api.apps.webhook.remove(ctx.appId);
    setSecret(null);
    ctx.setApp({ ...ctx.app(), webhook: { url: null, secret_set: false } });
    void list.reset();
  };

  const ping = async () => {
    try {
      const result = await request<{ event_id: string }>(webhookPath("/test"), { method: "POST", body: {}, idempotencyKey: keys.test.for("test") });
      keys.test.done();
      notify.success("Test ping queued", `Event ${shortId(result.event_id)} goes to ${webhook().url} now. It appears in the deliveries below.`);
      window.setTimeout(() => void list.reset(), 1200);
    } catch (raw) {
      notifyError(raw, "The test ping was not sent");
      throw raw;
    }
  };

  const replay = async (body: { delivery_ids: string[] } | { status: "failed" }, report = true): Promise<Replay> => {
    try {
      const result = (await api.apps.webhook.replay(ctx.appId, body, { idempotencyKey: keys.replay.for(JSON.stringify(body)) })) as Replay;
      keys.replay.done();
      // The drawer explains its own replay in place; the page reports the ones started from the list.
      if (report) setReplayResult(result);
      setSelected([]);
      void list.reset();
      return result;
    } catch (raw) {
      notifyError(raw, "Nothing was replayed");
      throw raw;
    }
  };

  const replayedCount = () => {
    const value = replayResult()?.replayed;
    return Array.isArray(value) ? value.length : value ?? 0;
  };
  const skipped = () => {
    const result = replayResult();
    return result ? skippedOf(result) : [];
  };

  const columns: DataColumn<Row>[] = [
    {
      key: "type",
      label: "Event",
      render: (_, row) => (
        <span class={styles.event}>
          <code class={styles.code}>{row.type}</code>
          <span class={styles.eventId}>{shortId(row.delivery.event_id)}</span>
        </span>
      ),
      width: "26%",
    },
    {
      key: "status",
      label: "Status",
      render: value => {
        const status = DELIVERY_STATUS[value as DeliveryStatus] ?? { label: String(value), tone: "neutral" as const };
        return <Badge size="sm" tone={status.tone} dot={value === "delivered"}>{status.label}</Badge>;
      },
      width: 120,
    },
    { key: "attempts", label: "Attempts", width: 96, numeric: true },
    { key: "response", label: "Last response", render: value => (value ? <span class={styles.response} title={String(value)}>{String(value)}</span> : <span class={styles.muted}>None yet</span>), width: "18%" },
    { key: "created", label: "Created", render: (_, row) => <span title={formatDateTime(row.delivery.created_at)}>{formatRelative(row.created)}</span>, width: 130 },
    {
      key: "next",
      label: "Next or delivered",
      render: (_, row) => (row.delivery.status === "pending" && row.delivery.next_attempt_at
        ? <span title={formatDateTime(row.delivery.next_attempt_at)}>{new Date(row.delivery.next_attempt_at).getTime() <= Date.now() ? "retrying now" : `retry ${formatRelative(row.delivery.next_attempt_at)}`}</span>
        : row.delivery.delivered_at ? <span title={formatDateTime(row.delivery.delivered_at)}>{formatRelative(row.delivery.delivered_at)}</span> : <span class={styles.muted}>Gave up</span>),
      sortValue: row => row.next,
      width: 150,
    },
    { key: "id", label: "Details", sortable: false, render: (_, row) => <Button size="sm" variant="ghost" onClick={() => setOpen(row.id)} aria-label={`Open delivery ${shortId(row.id)} of ${row.type}`}>Open</Button>, width: 92 },
  ];

  return (
    <div class={styles.webhooks}>
      <Section title="Endpoint" description="Silicon Accounts POSTs JSON here whenever something changes about an account that signed into this app. Deliveries are signed and retried until they succeed.">
        <Surface class={styles.endpoint}>
          <Show
            when={webhook().url && !editing()}
            fallback={
              <form class={styles.urlForm} onSubmit={event => { event.preventDefault(); void saveUrl(); }} novalidate>
                <Input
                  label={webhook().url ? "New webhook URL" : "Webhook URL"}
                  type="url"
                  mono
                  placeholder="https://app.example.com/webhooks/accounts"
                  value={url()}
                  onInput={event => { setUrl(event.currentTarget.value); setUrlError(null); }}
                  error={urlError()}
                  description={strict() ? "https, reachable from the internet." : "https in production; http and local hosts work in this environment."}
                />
                <div class={styles.urlActions}>
                  <Show when={webhook().url}><Button variant="ghost" onClick={() => { setEditing(false); setUrl(""); setUrlError(null); }}>Cancel</Button></Show>
                  <Button type="submit" loading={saving()}>{webhook().url ? "Save the new URL" : "Save the webhook URL"}</Button>
                </div>
                <p class={styles.muted}>Saving gives you a new signing secret, shown once.</p>
              </form>
            }
          >
            <div class={styles.current}>
              <span class={styles.currentIcon} aria-hidden="true"><Webhook size={18} stroke-width={1.75} /></span>
              <div class={styles.currentText}>
                <code class={styles.currentUrl}>{webhook().url}</code>
                <span class={styles.muted}>{webhook().secret_set ? "Signed with a whsec_ secret (stored encrypted, never shown again)" : "No signing secret stored: rotate it to get one"}</span>
              </div>
              <CopyButton value={webhook().url ?? ""} label="Copy URL" iconOnly size="xs" variant="plain" />
            </div>
            <div class={styles.endpointActions}>
              <ActionButton label="Send test ping" pendingLabel="Sending" successLabel="Ping queued" onAction={ping} />
              <Button variant="secondary" onClick={() => { setEditing(true); setUrl(webhook().url ?? ""); }}><Pencil size={14} stroke-width={1.75} aria-hidden="true" />Change URL</Button>
              <ConfirmMorph label="Rotate secret" icon={<RotateCw size={16} stroke-width={1.75} />} prompt="Rotate? The old secret stops working now." confirmLabel="Rotate" pendingLabel="Rotating" doneLabel="Rotated" tone="neutral" onConfirm={rotate} onError={error => notifyError(error, "The secret was not rotated")} />
              <ConfirmMorph label="Remove webhook" icon={<Trash2 size={16} stroke-width={1.75} />} prompt="Remove it? Pending deliveries fail." confirmLabel="Remove" pendingLabel="Removing" doneLabel="Removed" onConfirm={remove} onError={error => notifyError(error, "The webhook was not removed")} />
            </div>
          </Show>
        </Surface>
        <Show when={secret()}>
          {value => (
            <SecretReveal
              title={value().reason === "set" ? "Your webhook signing secret" : "Your new webhook signing secret"}
              description={value().reason === "set" ? "Use it to check the X-Accounts-Signature header of every delivery." : "The previous secret no longer signs anything. Update your receiver now."}
              secrets={[{ label: "Signing secret", value: value().value, note: "HMAC-SHA256 key: the whole whsec_ string." }]}
              onDone={() => setSecret(null)}
            />
          )}
        </Show>
      </Section>

      <Section title="Receiving deliveries" description="What arrives, how to check it came from Silicon Accounts, and when it is retried.">
        <Accordion
          defaultOpen={-1}
          multiple
          items={[
            {
              id: "verify",
              title: "Verify the signature",
              content: (
                <div class={styles.verify}>
                  <p class={styles.paragraph}>Each delivery carries <code>X-Accounts-Event-Id</code>, <code>X-Accounts-Event-Type</code>, <code>X-Accounts-Delivery-Id</code>, <code>X-Accounts-Timestamp</code> (unix seconds) and <code>X-Accounts-Signature: v1=&lt;hex&gt;</code>, the HMAC-SHA256 of <code>{"{timestamp}.{raw body}"}</code> keyed by the whole <code>whsec_</code> secret.</p>
                  <CodeBlock filename="Node" language="ts" code={VERIFY_TS} maxLines={14} />
                  <CodeBlock filename="Rust (silicon-accounts-client)" language="ts" code={VERIFY_RUST} />
                </div>
              ),
            },
            {
              id: "events",
              title: "Events",
              content: (
                <dl class={styles.events}>
                  <For each={[...APP_EVENT_TYPES]}>{type => <div><dt><code>{type}</code></dt><dd>{EVENT_DESCRIPTION[type] ?? ""}</dd></div>}</For>
                </dl>
              ),
            },
            {
              id: "retries",
              title: "Retries and replays",
              content: (
                <div class={styles.verify}>
                  <p class={styles.paragraph}>A 2xx answer within 10 seconds counts as delivered. Otherwise the delivery is retried after 10 s, 30 s, 1 min, 5 min, 15 min and 30 min, then every hour, until 72 hours after it was created; then it is failed and can be replayed here.</p>
                  <p class={styles.paragraph}>A replay keeps the event id and payload, goes to the current URL and is signed with the current secret. Deliveries about an account that no longer has access to the app are never replayed.</p>
                </div>
              ),
            },
          ]}
        />
      </Section>

      <Section
        title="Deliveries"
        description="Newest first. Select failed ones to replay them, or replay every failed delivery at once."
        actions={<Button size="sm" variant="ghost" onClick={() => void list.reset()} aria-label="Refresh deliveries"><RefreshCw size={14} stroke-width={1.75} aria-hidden="true" />Refresh</Button>}
      >
        <div class={styles.deliveryToolbar}>
          <SegmentedControl label="Show deliveries" size="sm" value={filter()} onValueChange={setFilter} options={FILTERS} />
          <div class={styles.replayActions}>
            <Show when={selected().length}>
              <Button size="sm" variant="secondary" disabled={selected().length > 100} onClick={() => void replay({ delivery_ids: selected() }).catch(() => undefined)}><Send size={14} stroke-width={1.75} aria-hidden="true" />Replay {selected().length} selected</Button>
            </Show>
            <ConfirmMorph label="Replay all failed" prompt="Replay every failed delivery?" confirmLabel="Replay" pendingLabel="Replaying" doneLabel="Queued" tone="neutral" onConfirm={() => replay({ status: "failed" })} />
          </div>
        </div>
        <Show when={replayResult()}>
          {result => (
            <Alert tone={skipped().length ? "warning" : "success"} title={`${plural(replayedCount(), "delivery", "deliveries")} queued again`} onDismiss={() => setReplayResult(null)}>
              <Show when={skipped().length}>
                <p class={styles.paragraph}>{plural(skipped().length, "delivery was", "deliveries were")} skipped:</p>
                <ul class={styles.skipped} role="list">
                  <For each={skipped().slice(0, 6)}>{entry => <li>{shortId(skippedId(entry))}{skippedWhy(entry) ? `: ${skippedWhy(entry)}` : ""}</li>}</For>
                </ul>
              </Show>
              <Show when={(result().remaining ?? 0) > 0}><p class={styles.paragraph}>{plural(result().remaining ?? 0, "failed delivery is", "failed deliveries are")} still waiting; replay again to send the next 100.</p></Show>
            </Alert>
          )}
        </Show>
        <Show when={list.error()}>{error => <Alert tone="danger" title="Deliveries could not be loaded" action={<Button size="sm" variant="secondary" onClick={() => void list.reset()}>Try again</Button>}>{error().message} {error().hint}</Alert>}</Show>
        <Switch>
          <Match when={list.loading() && !list.items().length}><Skeleton lines={5} label="Loading deliveries" /></Match>
          <Match when={!list.items().length && !list.error()}>
            <Surface padding="none">
              <EmptyState
                icon={<Webhook size={24} stroke-width={1.5} />}
                title={filter() === "all" ? "No deliveries yet" : `No ${FILTERS.find(entry => entry.value === filter())?.label.toLowerCase()} deliveries`}
                description={webhook().url ? "Events appear here as soon as something changes about an account that signed into this app. Send a test ping to see one now." : "Set a webhook URL first; deliveries appear here once events are sent."}
              />
            </Surface>
          </Match>
          <Match when={true}>
            <SortableDataTable
              rows={rows()}
              columns={columns}
              rowKey="id"
              caption={`Webhook deliveries of ${ctx.app().name}`}
              selectable
              selectedKeys={selected()}
              onSelectionChange={setSelected}
              itemName={{ one: "delivery", other: "deliveries" }}
              defaultSort={{ key: "created", direction: "desc" }}
            />
            <Show when={list.hasMore()}><Button size="sm" variant="secondary" loading={list.loadingMore()} onClick={() => void list.loadMore()}>Load more</Button></Show>
          </Match>
        </Switch>
      </Section>

      <Drawer open={!!open()} onOpenChange={value => { if (!value) setOpen(null); }}>
        <Show when={open()}>
          {id => {
            const row = () => rows().find(entry => entry.id === id());
            return (
              <DrawerContent title={row()?.type ?? "Delivery"} description={`Delivery ${shortId(id())}`} size="lg">
                <DeliveryDrawerBody appId={ctx.appId} id={id()} onReplay={ids => replay({ delivery_ids: ids }, false)} />
              </DrawerContent>
            );
          }}
        </Show>
      </Drawer>
    </div>
  );
}
