# silicon-accounts-worker (`accounts_worker`)

Background work of Silicon Accounts. `accounts-api` runs it when `ACCOUNTS_WORKER_ENABLED=true`
(`spawn_background_until(state, shutdown)`); any number of nodes may run it at once.

## Claims (`pipeline`)

Webhook deliveries and outbound messages are claimed with `FOR UPDATE SKIP LOCKED` for 60 s
(the webhook `locked_until` lease; core's message claim, `delivery::CLAIM_SECONDS`). A worker never holds a claim it isn't
working on: each loop claims only as many rows as it has free send slots (16 webhooks, 8
messages) and starts each one the moment it is claimed, so no claim runs down while its row waits
in a queue, and no other node can claim a row while it is being sent. A send is cut at its 10 s
HTTP timeout; work still running 50 s after its claim (only a stalled database gets there) is
abandoned rather than allowed to outlive the claim. A slow endpoint only ever holds its own slot.

On shutdown a loop stops claiming at once and lets the sends in flight finish (about one 10 s
send timeout at most). A node that crashes, or is stopped harder than that, leaves its claims to
run out and another node retries them: delivery is at-least-once, and webhook receivers dedupe by
`event_id`.

## Webhook delivery (`webhooks`)

- Each attempt uses the target's **current** URL and **current** secret (app webhook in
  `app_signin_configs`, or a Silicon's own webhook in `silicon-accounts`) and POSTs the stored
  `webhook_events.payload` as-is with `Content-Type: application/json`,
  `User-Agent: SiliconAccounts-Webhooks/1`, `X-Accounts-Event-Id`, `X-Accounts-Event-Type`,
  `X-Accounts-Delivery-Id`, `X-Accounts-Timestamp` (unix seconds) and
  `X-Accounts-Signature: v1=<hex HMAC-SHA256(key = the whole whsec_… string, "{timestamp}.{raw body}")>`.
- 2xx within 10 s → `delivered`. Anything else (status, timeout, connection error) is recorded in
  `webhook_attempts` and `last_error` (precise text, e.g. `HTTP 500 Internal Server Error: … Response
  body: …`) and retried after 10 s, 30 s, 1 min, 5 min, 15 min, 30 min, then hourly until 72 h after
  the event → `failed` (replayable). A replayed delivery gets a fresh 72 h of retries, counted from
  the replay (`requeued_at`, set by the apps crate's replay; a replay made before that column
  existed is measured along the retry schedule). Results are recorded only while the worker still
  holds the lease.
- Not sent: a disabled app (held and retried, so it resumes if re-enabled), a target without a
  webhook URL or signing secret (failed at once with a hint to set one and replay).
- Redirects are not followed and no proxy is used.
- **SSRF guard** (`ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=false`, the production default, which production
  can't turn off): only https; local host names and literal IPs that aren't deliverable are
  refused; host names resolve through `GuardedResolver` (core's `normalize::resolve_checked`),
  which refuses the host when it doesn't resolve or any address isn't deliverable — inside the
  connector, so the checked address is the connected one. Deliverable (`is_deliverable_ip`) is
  core's `normalize::is_public_ip`, the same rule core applies when a webhook URL is set:
  IPv4-mapped, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses count as the IPv4 address
  they carry, nothing outside global unicast `2000::/3` passes (IPv4-compatible, IPv4-translated,
  local NAT64, discard-only, ULA, link/site-local, multicast), nor do `2001::/23` (Teredo,
  benchmarking, ORCHID) and the documentation ranges. The refusal stored in `last_error` (which app
  owners read) never names the resolved addresses or whether the name resolved at all; the server
  log has them.

## Outbound email and SMS (`messages`)

Sends pending `outbound_messages` through core's sender (Postmark / Twilio) with core's
`claim_due` + `deliver_claimed`: retries with the webhook backoff, at most 8 attempts, OTP messages
stop once their code expired. Core records a result only while its claim still holds; a send that
finished after another node claimed the message again is `claim_lost` (not recorded; counted in
`SendSummary::claim_lost`). With `ACCOUNTS_DELIVERY=local` nothing is sent; leftover `pending`
messages are marked `local` (the dev outbox shows them).

## Cleanup (`cleanup`)

Every 10 minutes (first sweep 30 s after start), in batches of 5,000 rows: sign-in flows 1 day
after expiry; authorization codes, short-lived tokens and device codes 7 days after expiry; OTP
challenges 1 day after expiry; expired idempotency keys; id reservations 1 day after they ended;
sign-up sessions 7 days after expiry or use; rate-limit windows older than a day. Retention matches
the owning crates' own sweeps. History is never deleted.

## Telemetry

Space Station events carry source `worker`, a step and a progress: `webhook.<outcome>` (1.0 once
delivered or failed for good, else the share of the 72 h retry window used),
`message.<outcome>` (1.0 once sent or failed, else the share of the 8 attempts used),
`cleanup.swept` (1.0).

## Tests

```bash
CARGO_TARGET_DIR=target/server cargo test -p silicon-accounts-worker   # needs scripts/dev-db.sh
```

They run real deliveries against an axum receiver on 127.0.0.1: signatures, headers, retries on
500 with time travel, the 72 h window, replay windows, rotated secrets and moved URLs, removed
webhooks, disabled apps, Silicon webhooks, the SSRF guard (incl. NAT64/6to4/IPv4-compatible
literals, a `localhost.` name that resolves to loopback and an unresolvable name, with no address
in the stored text), parallel workers and lease takeover. The loops are run with slow receivers
and senders to check that a claim is held only while its row is being sent (never more claims
than send slots, each send starting right after its claim), that two nodes never send a message
twice, that work past the claim budget is abandoned and left to its claim, and that a graceful
stop claims nothing new and finishes the sends in flight.
