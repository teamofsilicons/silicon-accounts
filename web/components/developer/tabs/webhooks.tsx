"use client";

/**
 * Webhooks: where Silicon Accounts tells the app that something changed about an account that signed into it (id
 * changes, updates, sign-outs, removed access, deletions, Silicon custodian changes). Set or change the URL (a new
 * whsec_ signing secret is shown once), rotate the secret, send a test ping, and see every delivery with its attempts
 * and payload. Failed deliveries can be replayed one by one, selected, or all at once; whatever the server skipped is
 * named with its reason. Every set, rotation, ping and replay keeps one Idempotency-Key until it succeeds, so a retry
 * after a lost answer never rotates twice or sends a second ping.
 */
import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, RefreshCw, RotateCw, Send, Trash2, Webhook } from "lucide-react";
import { Accordion } from "@/components/arc/accordion/accordion";
import { ActionButton } from "@/components/arc/action-button/action-button";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { CodeBlock } from "@/components/arc/code-block/code-block";
import { ConfirmMorph } from "@/components/arc/confirm-morph/confirm-morph";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { Drawer, DrawerContent } from "@/components/arc/drawer/drawer";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Input } from "@/components/arc/input/input";
import { JsonViewer } from "@/components/arc/json-viewer/json-viewer";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { SortableDataTable, type DataColumn } from "@/components/arc/sortable-data-table/sortable-data-table";
import { DescriptionItem, DescriptionList, Section, Surface } from "@/components/foundation/layout/layout";
import { api } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import { APP_EVENT_TYPES, type DeliveryStatus, type ReplayRequest, type ReplayResult, type WebhookDelivery } from "@/lib/api/types";
import { formatDateTime, formatRelative, plural } from "@/lib/format";
import { useIdempotentMutation } from "@/lib/query/idempotency";
import { useRemoveWebhook, useRotateWebhookSecret, useTestWebhook, useWebhookDelivery } from "@/lib/query/developer";
import { queryKeys } from "@/lib/query/keys";
import { useDeveloperApp } from "../lib/context";
import { EVENT_DESCRIPTION, deliveryStatus, shortId } from "../lib/labels";
import { useDeliveryList } from "../lib/queries";
import { webhookUrlProblem } from "../lib/validate";
import { SecretReveal } from "../parts/secret-reveal";
import styles from "./webhooks.module.css";

type Filter = "all" | DeliveryStatus;
type Row = { id: string; type: string; status: DeliveryStatus; attempts: number; response: string | null; created: number; next: number | null; delivery: WebhookDelivery };

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

function responseOf(delivery: WebhookDelivery): string | null {
  if (delivery.last_status) return `HTTP ${delivery.last_status}`;
  if (delivery.last_error) return delivery.last_error;
  return null;
}

/** Why the server did not queue a delivery again, in its own words. */
function skipFor(result: ReplayResult, id: string): string | null {
  if (result.replayed.map(String).includes(id)) return null;
  const skipped = result.skipped.find(entry => String(entry.delivery_id) === id);
  return skipped?.message ?? skipped?.reason ?? "Silicon Accounts did not queue this delivery again.";
}

function DeliveryDrawerBody({ appId, id, onReplay }: { appId: string; id: string; onReplay: (ids: string[]) => Promise<ReplayResult> }) {
  const detail = useWebhookDelivery(appId, id);
  const client = useQueryClient();
  const [replayIssue, setReplayIssue] = useState<string | null>(null);
  if (detail.error) return <Alert tone="danger" title="The delivery could not be loaded">{detail.error.message} {detail.error.hint}</Alert>;
  const delivery = detail.data;
  if (!delivery) return <Skeleton lines={6} label="Loading the delivery" />;
  const status = deliveryStatus(delivery.status);
  // Only a failed or delivered delivery whose account still lets the app see it can be sent again.
  const replayable = delivery.status !== "pending" && !delivery.payload_redacted;
  const attemptCount = delivery.attempt_count ?? delivery.attempts.length;
  const replay = async () => {
    setReplayIssue(null);
    const result = await onReplay([delivery.id]);
    const why = skipFor(result, String(delivery.id));
    if (why) {
      setReplayIssue(why);
      void client.invalidateQueries({ queryKey: queryKeys.app.delivery(appId, id) });
      throw new Error(why);
    }
    // Show the new state (queued again) once the button has confirmed in place.
    window.setTimeout(() => void client.invalidateQueries({ queryKey: queryKeys.app.delivery(appId, id) }), 1600);
  };
  return (
    <div className={styles.drawer}>
      <div className={styles.drawerHead}>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className={styles.muted}>{plural(attemptCount, "attempt")}{delivery.manual_replays ? ` · replayed ${plural(delivery.manual_replays, "time")}` : ""}</span>
        {replayable ? <ActionButton label="Replay this delivery" pendingLabel="Queuing" successLabel="Queued" onAction={replay} onActionError={() => undefined} /> : null}
      </div>
      {replayIssue ? <Alert tone="warning" title="Not replayed" onDismiss={() => setReplayIssue(null)}>{replayIssue}</Alert> : null}
      {delivery.status === "pending" ? (
        <p className={styles.muted}>{delivery.manual_replays > 0 && attemptCount === 0 ? "Queued again: it goes out within seconds, to the current URL and signed with the current secret." : "Still being retried, so there is nothing to replay: the next attempt goes out on its own."}</p>
      ) : null}
      <DescriptionList>
        <DescriptionItem label="Event"><code className={styles.code}>{delivery.type}</code></DescriptionItem>
        <DescriptionItem label="Event id"><span className={styles.copyLine}><code className={styles.code}>{delivery.event_id}</code><CopyButton value={delivery.event_id} label="Copy event id" iconOnly variant="plain" /></span></DescriptionItem>
        <DescriptionItem label="Delivery id"><span className={styles.copyLine}><code className={styles.code}>{delivery.id}</code><CopyButton value={delivery.id} label="Copy delivery id" iconOnly variant="plain" /></span></DescriptionItem>
        {delivery.url ? <DescriptionItem label="Sent to"><code className={styles.code}>{delivery.url}</code></DescriptionItem> : null}
        <DescriptionItem label="Created">{formatDateTime(delivery.created_at)}</DescriptionItem>
        {delivery.delivered_at ? <DescriptionItem label="Delivered">{formatDateTime(delivery.delivered_at)}</DescriptionItem> : null}
        {delivery.next_attempt_at ? <DescriptionItem label="Next attempt">{formatRelative(delivery.next_attempt_at)} ({formatDateTime(delivery.next_attempt_at)})</DescriptionItem> : null}
      </DescriptionList>
      <section className={styles.attempts} aria-label="Attempts">
        <h3 className={styles.subTitle}>Attempts</h3>
        {delivery.attempts.length ? (
          <ol className={styles.attemptList} role="list">
            {delivery.attempts.map((attempt, index) => {
              const code = attempt.status_code;
              const ok = typeof code === "number" && code >= 200 && code < 300;
              return (
                <li key={`${attempt.attempted_at}-${index}`} className={styles.attempt}>
                  <span className={styles.attemptNumber}>{index + 1}</span>
                  <Badge size="sm" tone={ok ? "success" : "danger"}>{code ? `HTTP ${code}` : "No response"}</Badge>
                  <span className={styles.attemptError} title={attempt.error ?? undefined}>{ok ? "Delivered" : attempt.error ?? "Failed"}</span>
                  <span className={styles.attemptMeta}>{`${attempt.duration_ms} ms · ${formatDateTime(attempt.attempted_at)}`}</span>
                </li>
              );
            })}
          </ol>
        ) : <p className={styles.muted}>No attempt yet; the first one goes out within seconds.</p>}
      </section>
      <section className={styles.attempts} aria-label="Payload">
        <h3 className={styles.subTitle}>Payload</h3>
        {delivery.payload_redacted ? (
          <Alert tone="info" title="Account details are hidden">{delivery.payload_redacted_reason ?? "This account no longer has access to the app, so only its uuid and membership id are shown, and this delivery can't be replayed."}</Alert>
        ) : null}
        {delivery.payload ? <JsonViewer data={delivery.payload} rootName="event" defaultExpandDepth={2} maxHeight={340} label="Webhook payload" /> : <p className={styles.muted}>No payload stored.</p>}
      </section>
    </div>
  );
}

export function WebhooksTab() {
  const ctx = useDeveloperApp();
  const client = useQueryClient();
  const { appId } = ctx;
  const webhook = ctx.app.webhook ?? { url: null, secret_set: false };
  const strict = ctx.meta?.environment === "production";
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState(false);
  // The URL field takes focus when the reader asked for it (Change URL) or just removed the webhook, not on arrival.
  const [focusUrl, setFocusUrl] = useState(false);
  const changeButton = useRef<HTMLButtonElement>(null);
  const [urlError, setUrlError] = useState<string | undefined>();
  const [secret, setSecret] = useState<{ value: string; reason: "set" | "rotated" } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [opened, setOpened] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);

  const list = useDeliveryList(appId, { status: filter === "all" ? undefined : filter });
  const deliveries = useMemo(() => list.data?.pages.flatMap(page => page.items) ?? [], [list.data]);
  const refreshDeliveries = () => void client.invalidateQueries({ queryKey: queryKeys.app.root(appId).concat("deliveries") });

  const setWebhook = useIdempotentMutation((value: string, idempotencyKey) => api.apps.webhook.set(appId, value, { idempotencyKey }), { meta: { toast: false } });
  const rotateSecret = useRotateWebhookSecret(appId);
  const removeWebhook = useRemoveWebhook(appId);
  const testWebhook = useTestWebhook(appId);
  const replayDeliveries = useIdempotentMutation((body: ReplayRequest, idempotencyKey) => api.apps.webhook.replay(appId, body, { idempotencyKey }), {
    onSuccess: refreshDeliveries,
    meta: { errorTitle: "Nothing was replayed" },
  });

  const saveUrl = async () => {
    const value = url.trim();
    const problem = webhookUrlProblem(value, strict);
    setUrlError(problem ?? undefined);
    if (problem) return;
    try {
      const result = await setWebhook.mutateAsync(value);
      setSecret({ value: result.secret, reason: "set" });
      setEditing(false);
      setFocusUrl(false);
      setUrl("");
      ctx.setApp(current => ({ ...current, webhook: { url: result.url, secret_set: true } }));
      void ctx.reload();
      refreshDeliveries();
    } catch (raw) {
      const error = ApiError.from(raw);
      setUrlError(error.fields.url ?? [error.message, error.hint].filter(Boolean).join(" "));
    }
  };

  const rotate = async () => {
    const result = await rotateSecret.mutateAsync();
    setSecret({ value: result.secret, reason: "rotated" });
    ctx.setApp(current => ({ ...current, webhook: { ...current.webhook, secret_set: true } }));
  };

  const remove = async () => {
    await removeWebhook.mutateAsync();
    setSecret(null);
    setFocusUrl(true);
    ctx.setApp(current => ({ ...current, webhook: { url: null, secret_set: false } }));
  };

  const ping = async () => {
    await testWebhook.mutateAsync();
    window.setTimeout(refreshDeliveries, 1200);
  };

  const replay = async (body: ReplayRequest, report = true): Promise<ReplayResult> => {
    const result = await replayDeliveries.mutateAsync(body);
    // The drawer explains its own replay in place; the page reports the ones started from the list.
    if (report) setReplayResult(result);
    setSelected([]);
    return result;
  };

  const rows = useMemo<Row[]>(() => deliveries.map(delivery => ({
    id: delivery.id,
    type: delivery.type,
    status: delivery.status,
    attempts: delivery.attempts,
    response: responseOf(delivery),
    created: new Date(delivery.created_at).getTime(),
    next: delivery.next_attempt_at ? new Date(delivery.next_attempt_at).getTime() : delivery.delivered_at ? new Date(delivery.delivered_at).getTime() : null,
    delivery,
  })), [deliveries]);

  const openDelivery = (id: string) => {
    setOpened(id);
    setDrawerOpen(true);
  };

  const columns: DataColumn<Row>[] = [
    {
      key: "type",
      label: "Event",
      render: (_, row) => (
        <span className={styles.event}>
          <code className={styles.code}>{row.type}</code>
          <span className={styles.eventId} title={row.delivery.event_id}>{shortId(row.delivery.event_id)}</span>
        </span>
      ),
      width: "26%",
    },
    { key: "status", label: "Status", render: value => { const status = deliveryStatus(String(value)); return <Badge size="sm" tone={status.tone}>{status.label}</Badge>; }, width: 120 },
    { key: "attempts", label: "Attempts", width: 96, numeric: true },
    { key: "response", label: "Last response", render: value => (value ? <span className={styles.response} title={String(value)}>{String(value)}</span> : <span className={styles.muted}>None yet</span>), width: "18%" },
    { key: "created", label: "Created", render: (_, row) => <span title={formatDateTime(row.delivery.created_at)}>{formatRelative(row.delivery.created_at)}</span>, width: 130 },
    {
      key: "next",
      label: "Next or delivered",
      render: (_, row) => (row.delivery.status === "pending" && row.delivery.next_attempt_at
        ? <span title={formatDateTime(row.delivery.next_attempt_at)}>{new Date(row.delivery.next_attempt_at).getTime() <= Date.now() ? "retrying now" : `retry ${formatRelative(row.delivery.next_attempt_at)}`}</span>
        : row.delivery.delivered_at ? <span title={formatDateTime(row.delivery.delivered_at)}>{`delivered ${formatRelative(row.delivery.delivered_at)}`}</span> : <span className={styles.muted}>Gave up</span>),
      width: 196,
    },
    { key: "id", label: "Details", sortable: false, render: (_, row) => <Button size="sm" variant="ghost" onClick={() => openDelivery(row.id)} aria-label={`Open delivery ${shortId(row.id)} of ${row.type}`}>Open</Button>, width: 92 },
  ];

  const openedRow = rows.find(row => row.id === opened);
  const skipped = replayResult?.skipped ?? [];
  const replayed = replayResult?.replayed.length ?? 0;

  return (
    <div className={styles.webhooks}>
      <Section title="Endpoint" description="Silicon Accounts POSTs JSON here whenever something changes about an account that signed into this app. Deliveries are signed and retried until they succeed.">
        <Surface className={styles.endpoint}>
          {webhook.url && !editing ? (
            <>
              <div className={styles.current}>
                <span className={styles.currentIcon} aria-hidden="true"><Webhook size={18} strokeWidth={1.75} /></span>
                <div className={styles.currentText}>
                  <code className={styles.currentUrl}>{webhook.url}</code>
                  <span className={styles.muted}>{webhook.secret_set ? "Signed with a whsec_ secret (stored encrypted, never shown again)" : "No signing secret stored: rotate it to get one"}</span>
                </div>
                <CopyButton value={webhook.url} label="Copy URL" iconOnly variant="plain" />
              </div>
              <div className={styles.endpointActions}>
                <ActionButton label="Send test ping" pendingLabel="Sending" successLabel="Ping queued" onAction={ping} onActionError={() => undefined} />
                <Button ref={changeButton} variant="secondary" onClick={() => { setEditing(true); setFocusUrl(true); setUrl(webhook.url ?? ""); setUrlError(undefined); }}><Pencil size={14} strokeWidth={1.75} aria-hidden="true" />Change URL</Button>
                <ConfirmMorph label="Rotate secret" icon={<RotateCw size={16} strokeWidth={1.75} />} prompt="Rotate? The old secret stops working now." confirmLabel="Rotate" pendingLabel="Rotating" doneLabel="Rotated" tone="neutral" onConfirm={rotate} />
                <ConfirmMorph label="Remove webhook" icon={<Trash2 size={16} strokeWidth={1.75} />} prompt="Remove it? Pending deliveries fail." confirmLabel="Remove" pendingLabel="Removing" doneLabel="Removed" onConfirm={remove} />
              </div>
            </>
          ) : (
            <form className={styles.urlForm} noValidate onSubmit={event => { event.preventDefault(); void saveUrl(); }}>
              <Input
                label={webhook.url ? "New webhook URL" : "Webhook URL"}
                type="url"
                className={styles.mono}
                placeholder="https://app.example.com/webhooks/accounts"
                value={url}
                onChange={event => { setUrl(event.currentTarget.value); setUrlError(undefined); }}
                error={urlError}
                autoFocus={focusUrl}
                description={strict ? "https, reachable from the internet." : "https in production; http and local hosts work in this environment."}
              />
              <div className={styles.urlActions}>
                {webhook.url ? <Button variant="ghost" onClick={() => { setEditing(false); setFocusUrl(false); setUrl(""); setUrlError(undefined); requestAnimationFrame(() => changeButton.current?.focus()); }}>Cancel</Button> : null}
                <Button type="submit" loading={setWebhook.isPending}>{webhook.url ? "Save the new URL" : "Save the webhook URL"}</Button>
              </div>
              <p className={styles.muted}>Saving gives you a new signing secret, shown once.</p>
            </form>
          )}
        </Surface>
        {secret ? (
          <SecretReveal
            title={secret.reason === "set" ? "Your webhook signing secret" : "Your new webhook signing secret"}
            description={secret.reason === "set" ? "Use it to check the X-Accounts-Signature header of every delivery." : "The previous secret no longer signs anything. Update your receiver now."}
            secrets={[{ label: "Signing secret", value: secret.value, note: "HMAC-SHA256 key: the whole whsec_ string." }]}
            onDone={() => setSecret(null)}
          />
        ) : null}
      </Section>

      <Section title="Receiving deliveries" description="What arrives, how to check it came from Silicon Accounts, and when it is retried.">
        <Accordion
          defaultOpen={-1}
          items={[
            {
              title: "Verify the signature",
              content: (
                <div className={styles.verify}>
                  <p className={styles.paragraph}>Each delivery carries <code>X-Accounts-Event-Id</code>, <code>X-Accounts-Event-Type</code>, <code>X-Accounts-Delivery-Id</code>, <code>X-Accounts-Timestamp</code> (unix seconds) and <code>X-Accounts-Signature: v1=&lt;hex&gt;</code>, the HMAC-SHA256 of <code>{"{timestamp}.{raw body}"}</code> keyed by the whole <code>whsec_</code> secret.</p>
                  <div className={styles.wrapCode}><CodeBlock filename="Node" language="ts" code={VERIFY_TS} maxLines={14} /></div>
                  <div className={styles.wrapCode}><CodeBlock filename="Rust (silicon-accounts-client)" language="rust" code={VERIFY_RUST} /></div>
                </div>
              ),
            },
            {
              title: "Events",
              content: (
                <dl className={styles.events}>
                  {APP_EVENT_TYPES.map(type => <div key={type}><dt><code>{type}</code></dt><dd>{EVENT_DESCRIPTION[type] ?? ""}</dd></div>)}
                </dl>
              ),
            },
            {
              title: "Retries and replays",
              content: (
                <div className={styles.verify}>
                  <p className={styles.paragraph}>A 2xx answer within 10 seconds counts as delivered. Otherwise the delivery is retried after 10 s, 30 s, 1 min, 5 min, 15 min and 30 min, then every hour, until 72 hours after it was created (or after its last replay); then it is failed and can be replayed here.</p>
                  <p className={styles.paragraph}>A replay keeps the event id and payload, goes to the current URL and is signed with the current secret. Deliveries with the data of an account that no longer has access to the app are never replayed.</p>
                </div>
              ),
            },
          ]}
        />
      </Section>

      <Section
        title="Deliveries"
        description="Newest first. Select failed ones to replay them, or replay every failed delivery at once."
        actions={<Button size="sm" variant="ghost" onClick={refreshDeliveries} aria-label="Refresh deliveries"><RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />Refresh</Button>}
      >
        <div className={styles.deliveryToolbar}>
          <SegmentedControl label="Show deliveries" value={filter} onValueChange={value => { setFilter(value as Filter); setSelected([]); }} options={FILTERS} />
          <div className={styles.replayActions}>
            {selected.length ? (
              <Button size="sm" variant="secondary" loading={replayDeliveries.isPending} disabled={selected.length > 100} onClick={() => void replay({ delivery_ids: selected }).catch(() => undefined)}>
                <Send size={14} strokeWidth={1.75} aria-hidden="true" />{`Replay ${selected.length} selected`}
              </Button>
            ) : null}
            <ConfirmMorph label="Replay all failed" prompt="Replay every failed delivery?" confirmLabel="Replay" pendingLabel="Replaying" doneLabel="Done" tone="neutral" onConfirm={() => replay({ status: "failed" })} disabled={!webhook.url} />
          </div>
        </div>
        {replayResult ? (
          <Alert
            tone={replayed ? (skipped.length ? "warning" : "success") : skipped.length || replayResult.not_replayable ? "warning" : "info"}
            title={replayed ? `${plural(replayed, "delivery", "deliveries")} queued again` : skipped.length || replayResult.not_replayable ? "Nothing was replayed" : "Nothing to replay"}
            onDismiss={() => setReplayResult(null)}
          >
            {!replayed && !skipped.length && !replayResult.not_replayable ? (
              <span className={styles.alertLine}>No delivery has failed. Deliveries that are still being retried go out on their own; once one fails for good it can be replayed here.</span>
            ) : null}
            {skipped.length ? (
              <>
                <span className={styles.alertLine}>{plural(skipped.length, "delivery was", "deliveries were")} skipped:</span>
                <span className={styles.skippedList}>
                  {skipped.slice(0, 6).map(entry => <span key={entry.delivery_id}><code className={styles.code}>{shortId(entry.delivery_id)}</code>: {entry.message ?? entry.reason}</span>)}
                  {skipped.length > 6 ? <span>and {skipped.length - 6} more.</span> : null}
                </span>
              </>
            ) : null}
            {replayResult.remaining > 0 ? <span className={styles.alertLine}>{plural(replayResult.remaining, "failed delivery is", "failed deliveries are")} still waiting; replay again to send the next 100.</span> : null}
            {replayResult.not_replayable > 0 ? <span className={styles.alertLine}>{plural(replayResult.not_replayable, "failed delivery", "failed deliveries")} will never be sent: the accounts they are about no longer let this app see their data.</span> : null}
          </Alert>
        ) : null}
        {list.error ? (
          <Alert tone="danger" title="Deliveries could not be loaded">
            {list.error.message} {list.error.hint}
            <span className={styles.alertActions}><Button size="sm" variant="secondary" onClick={() => void list.refetch()}>Try again</Button></span>
          </Alert>
        ) : null}
        {list.isPending ? <Skeleton lines={5} label="Loading deliveries" /> : !rows.length && !list.error ? (
          <Surface padding="none">
            <EmptyState
              icon={<Webhook size={24} strokeWidth={1.5} />}
              title={filter === "all" ? "No deliveries yet" : `No ${FILTERS.find(entry => entry.value === filter)?.label.toLowerCase()} deliveries`}
              description={webhook.url ? "Events appear here as soon as something changes about an account that signed into this app. Send a test ping to see one now." : "Set a webhook URL first; deliveries appear here once events are sent."}
            />
          </Surface>
        ) : rows.length ? (
          <>
            <div className={styles.tableFrame} aria-busy={list.isPlaceholderData || undefined}>
              <SortableDataTable
                rows={rows}
                columns={columns}
                rowKey="id"
                caption={`Webhook deliveries of ${ctx.app.name}`}
                selectable
                selectedKeys={selected}
                onSelectionChange={setSelected}
                itemName={{ one: "delivery", other: "deliveries" }}
                defaultSort={{ key: "created", direction: "desc" }}
              />
            </div>
            {list.hasNextPage ? <Button size="sm" variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more deliveries</Button> : null}
          </>
        ) : null}
      </Section>

      <Drawer open={drawerOpen && !!opened} onOpenChange={setDrawerOpen}>
        {opened ? (
          <DrawerContent title={openedRow?.type ?? "Delivery"} description={`Delivery ${shortId(opened)}`} className={styles.wideDrawer}>
            <DeliveryDrawerBody appId={appId} id={opened} onReplay={ids => replay({ delivery_ids: ids }, false)} />
          </DrawerContent>
        ) : null}
      </Drawer>
    </div>
  );
}
