# The browser end-to-end walk

`web/e2e` walks Silicon Accounts in a real browser (Playwright's Chromium or WebKit) against a whole local stack:
the account site (a production build of this Next.js app), accounts-api behind it, Postgres, and the testkit's mock
Google/Apple, mock email/SMS, mock Iris and fake apps. Every stack is isolated (its own ports, database and site
build), so any number of them can run at the same time: one per suite, one per agent.

```
scripts/e2e.sh                         # every suite in Chromium on a fresh stack of its own, then teardown
scripts/e2e.sh --suite silicons        # one suite (repeat --suite or comma-separate); "core" is e2e/journeys
scripts/e2e.sh b-apps silicons/        # journeys by name prefix, or <suite>/<prefix>
scripts/e2e.sh --webkit --keep         # WebKit, and leave the stack running afterwards
scripts/e2e.sh --list                  # every suite and journey
scripts/e2e-all.sh                     # every suite in parallel, one stack each, merged summary
scripts/e2e-all.sh --engines chromium,webkit core harness
pnpm -C web e2e [options] [prefix…]    # against a stack that is already running (see "Environment")
```

`scripts/e2e.sh` builds the Rust binaries (skip with `--no-build`), leases a port base, starts the stack with
`scripts/dev.sh` (a new database `accounts_e2e_<base>`, migrations, the seeded fake apps, the testkit, accounts-api,
the site built into `web/.next-<base>`), runs `e2e/run.ts`, copies the stack's logs into the artifacts, stops
everything, drops the database and deletes the site build. Its exit code is 0 only when every selected journey
passed. `--dev` serves the site with `next dev` instead of a production build.

## Suites and journeys

```
web/e2e/
  run.ts             finds journeys, runs them in one browser, writes the report (never edited to add a suite)
  lib.ts             helpers for journeys (below)          context.ts   the Journey, Ctx and Shared types
  summary.ts         merges the reports of scripts/e2e-all.sh
  journeys/*.ts      the "core" suite: the product's main journeys
  suites/<suite>/    one folder per suite; every *.ts file in it holds journeys
  suites/harness/    the harness checks itself (isolation, forwarded addresses, mock Iris)
  test/, suites/<suite>/test/   unit tests (node:test, no stack needed) of the harness and of a suite's helpers
  .artifacts/        reports, screenshots and logs (git-ignored)
```

The unit tests run with `web/node_modules/.bin/tsx --test web/e2e/test/*.test.ts web/e2e/suites/*/test/*.test.ts`.

**Adding a suite** is adding a folder: `web/e2e/suites/<suite>/` (lowercase letters, digits, `.`, `_`, `-`; not
`core`) with one or more `*.ts` files, each exporting `journey` (one) or `journeys` (an array). Files whose name starts
with `_` are helpers, never journeys; so is anything in a subfolder. run.ts finds everything on its own, so a suite
never edits run.ts, lib.ts, context.ts or another suite's folder. If a suite needs a shared helper that does not exist,
keep it in the suite (`_helpers.ts`) and say so; the harness owner moves it into lib.ts.

```ts
// web/e2e/suites/silicons/transfer.ts
import type { Journey } from "../../context";
import { api, newContext, shot, sql, tag } from "../../lib";

export const journey: Journey = {
  name: "silicons-transfer",          // unique across every suite; prefix it with the suite's name
  title: "a custodian transfers a Silicon and the new Carbon accepts on the site",
  needs: ["ada"],                     // hand-overs from other journeys (their journeys run first)
  async run(ctx) {
    const { env, results, browser, shared } = ctx;
    const context = await newContext(browser, { cookies: shared.ada!.cookies });
    const page = await context.newPage();
    results.watch(page, "transfer");  // console errors, page errors, CSP refusals, failed requests fail the journey
    // …
    results.check("the new custodian sees the request", ok, "detail for the report");
    results.metric("transfer accepted after", ms, "ms");
    await shot(env, page, "silicons-transfer-01");
    await context.close();
  },
};
```

A journey:

- has a unique `name` (selected by prefix: `scripts/e2e.sh silicons-tr`), a one-line `title`, and `run(ctx)`;
- may declare `needs` and `provides`: keys of `ctx.shared` it reads, or hands over when it passes. The core suite's
  `a-signup` provides `ada` (a Carbon signed up on the site) and `b-apps` provides `brook` (signed into briefcase and dm
  with a phone); any suite may need them. A suite's own keys carry its name (`"silicons.custodian"`). A selected
  journey brings along the journeys that provide what it needs, and a journey whose provider failed fails at once;
- may limit itself to `engines: ["chromium"]` (it is then reported as skipped in WebKit) and set `timeoutMs` (default
  10 minutes, `E2E_JOURNEY_TIMEOUT_MS`);
- makes its own data with random names (`tag()`, `randomIp()`): the database is fresh for each stack, but journeys of
  a suite share it, and `--keep` stacks are walked again;
- closes the browser contexts it opens (run.ts closes leftovers after each journey, and screenshots every open page of
  a journey that failed as `shots/FAILED-<journey>-<n>.png`).

A journey passes when it threw nothing, every check passed and its watched pages reported no problem. Checks are
data: `results.check(name, ok, detail)` never throws, so a journey keeps going and reports everything it saw.

`lib.ts` has: `newContext` (1440×900, Asia/Kolkata, its own forwarded address), `shot`, `tag`, `sleep`, `json`,
`postJson`, `api` (a call with the journey's own address, through the site or `direct` to accounts-api), `lastSeq` and
`codeFor` (codes from the mock email/SMS server), `cli` and `cliHome` (the real `accounts` CLI), `signInOnSite`,
`finishSignup`, `afterConsent`, `appAccount` (what a fake app received), `sql` and `forgetRateLimits` (the stack's
database), `randomIp`, `forwardAs`, `withBenchSlot`, `waitForCalm` and `watchStalls` (benchmarks, below). The
testkit's own helpers (`testkit/lib`) work too, pointed at `ctx.env`.

## Port bases

A stack is named by its port base, the site's port:

| port | what |
| --- | --- |
| base − 1 | accounts-api |
| base | the account site (the public origin: `http://localhost:<base>`) |
| base + 1 | mock Google/Apple (`/_requests`, `/_identities`) |
| base + 2 | mock email/SMS (`/_messages`) |
| base + 3 | the fake apps (`/<app_id>/…`) |
| base + 4 | mock Iris (`/pfp/carbon?id=…`, `/_requests`) |

`scripts/e2e.sh` takes `E2E_PORT_BASE` (or `--base`) when given; otherwise it leases the first free base of 9600,
9610, … 9990 (from `E2E_BASE_START` when set, wrapping around): a lease is the directory `.dev/locks/e2e-<base>` (made
atomically, holding the run's pid; a dead run's lease is taken over), and a base is only used when all six ports are
free. Bases are 10 apart so neighbours never overlap. `scripts/e2e-all.sh` asks run n for base 9600 + 10·n and each
run takes the next free one when that is busy, so it coexists with stacks other runs (or agents) hold. The default
`scripts/dev.sh` stack is 8589–8594, `scripts/journeys.sh` uses 9690.

## Site builds

Next.js bakes `ACCOUNTS_API_URL` into a build's rewrites, so every stack needs its own build. `next.config.ts` reads
`NEXT_DIST_DIR` (default `.next`; it must look like `.next-<name>`), and `scripts/dev.sh` builds every stack on a port
other than 8590 into `web/.next-<port>` (`NEXT_DIST_DIR` overrides it). Two builds in the same `web/` never write the
same file:

- each writes only its own directory, which Next locks while building (`lockDistDir`);
- `tsconfig.json` is left alone: such a build reads `web/.next-<port>.tsconfig.json`, a one-line config that extends
  `tsconfig.json` (next.config.ts writes it), and Next does not rewrite a config that extends another;
- its type-check pass is skipped (`pnpm -C web typecheck` is the type gate; that pass would read `next-env.d.ts`,
  which every build rewrites for its own directory), and so is Turbopack's build cache (the directory is deleted with
  the stack; a cold build takes about 5 seconds);
- `scripts/dev.sh` points `next-env.d.ts` back at `.next` after the build (a temporary file and a rename), so
  `pnpm typecheck` and editors keep working when the stack's directory is gone;
- `public/sdk/v1.js` (`pnpm build:sdk`, run by every build) is written to a temporary file and renamed into place;
- at most `ACCOUNTS_WEB_BUILD_SLOTS` (default 2) production builds run at once across stacks (`.dev/locks/web-build-<n>`;
  a build uses about six cores, so more at once only slow each other and the walks of stacks already up); the others
  wait (`dev: waiting for a build slot`).

The standalone server runs from `web/.next-<port>/standalone/server.js` with `static/` and `public/` copied beside it,
as production runs it. `scripts/e2e.sh` deletes the build at teardown unless `--keep`; for a kept stack,
`ACCOUNTS_PORT=<base> scripts/stop.sh --clean` stops it and deletes its build (`--all --clean` for every stack).

## Reports

Each run writes `web/e2e/.artifacts/<base>/`:

- `report.json`: the site, browser, base, times, totals, and per journey its suite, file, status
  (`pass`/`fail`/`skipped`), seconds, every check (`name`, `ok`, `detail`, `at_ms` since the journey started), the
  browser problems, metrics (`{name, value, unit}`), the error that stopped it and the failure screenshots;
- `report.md`: the same as a table, with the failures and metrics spelled out;
- `shots/`: the screenshots journeys take, plus `FAILED-…` ones; `logs/`: the stack's accounts-api, testkit, site and
  build logs.

`scripts/e2e-all.sh` keeps each run in `web/e2e/.artifacts/runs/<n>-<suite>-<browser>/` (`run.log`, the base it got,
and a copy of its report, shots and logs, since a later run may reuse the base) and merges them into
`web/e2e/.artifacts/summary.json` and `summary.md`: pass or fail per run, journey and check, timings, metrics, and
the end of the log of a run that never produced a report. It exits 1 when anything failed. `tsx e2e/summary.ts
<runs.json>` merges by hand.

## Mock Iris

Iris draws every account's default photo (`{iris}/pfp/carbon?id={uuid}`, `{iris}/pfp/silicon?id={uuid}`; production
keeps `ACCOUNTS_IRIS_BASE_URL=https://iris.teamofsilicons.com`). Every local stack points `ACCOUNTS_IRIS_BASE_URL` at
the testkit's mock Iris on base + 4 (`testkit/src/mock-iris.ts`): a small SVG that depends only on the id, so no page
loads a photo from the internet and screenshots are stable. The site gets the same variable: its CSP adds a loopback
`http://` Iris origin to `img-src` (production's https Iris is already covered by `https:`). `GET <iris>/_requests`
shows what was drawn and for which page.

## Forwarded addresses and rate limits

accounts-api limits per client address: 30 codes per 10 minutes (on top of 10 per destination), 120
`ids/available` and 120 telemetry calls per minute, 60 Silicon logins per minute, 10 self-created Silicons and 5 bug
reports per hour. The counters live in the stack's own database, so stacks never share them; within a stack, the e2e
stacks trust `X-Forwarded-For` (`ACCOUNTS_TRUST_FORWARDED_FOR=true`), and the site passes the header through to
accounts-api unchanged (Next adds none of its own).

- Every browser context from `newContext` gets its own random 10.x address on its calls to the site's `/v1/…` (a
  `context.route` that sets the header on those requests only: Playwright's `extraHTTPHeaders` would put it on every
  request, and Chromium then preflights cross-origin fetches such as the SDK's, which the API does not allow).
  `newContext(browser, { forwardedFor: "10.1.2.3" })` picks one (contexts sharing it share its limits), `null` sends
  none (the calls count as 127.0.0.1). The harness suite checks that a context's code lands in its own bucket.
- `api(ctx, path, init)` calls with the journey's own address (`ctx.ip`), through the site or `direct`.
- The CLI and Playwright's `page.request` reach the API as 127.0.0.1 (the CLI sends no forwarded address). A suite that
  makes many limited calls that way (more than 10 self-created Silicons or 5 reports an hour) calls
  `forgetRateLimits(env, "127.0.0.1")` between them, which is the window passing (see time travel).
- The contract numbers stay as they are: the stack runs with the production limits.

## Time travel

Each stack has a database of its own (`env.db`, `postgres://postgres@127.0.0.1:5444/accounts_e2e_<base>`), so a
journey may move time there with `sql(env, …)` (psql; rows come back as arrays of strings) instead of waiting. Move
only the rows the journey made. Examples:

```ts
// a custodian request past its 14 days: reads treat it as expired at once; the sweep (every minute) marks it
// expired and sends the webhooks
await sql(env, `update custodian_requests set expires_at = now() - interval '1 second' where id = '${requestId}'`);
// a sign-up session past its 48 hours
await sql(env, `update signup_sessions set expires_at = now() - interval '1 second' where verified_email = '${email}'`);
// an old id's 10-day reservation over, so another account may take it (handle is the full id: c:… or si:…)
await sql(env, `update handle_reservations set reserved_until = now() - interval '1 second' where handle = '${oldId}'`);
// a verification code expired, or its 1-minute lockout over
await sql(env, `update otp_challenges set expires_at = now() - interval '1 second' where destination = '${email}'`);
await sql(env, `update otp_challenges set locked_until = null where destination = '${email}'`);
// a proof token expired (proof_families.expires_at ends the whole family), a refresh family past its 900 days
await sql(env, `update proof_tokens set expires_at = now() - interval '1 second' where family_id = '${familyId}'`);
await sql(env, `update token_families set expires_at = now() - interval '1 second' where account_uuid = '${uuid}'`);
// a Silicon's STK lockout over
await sql(env, `update accounts set stk_locked_until = null where uuid = '${uuid}'`);
// the per-network limits' windows over
await forgetRateLimits(env, ip);
```

The schema is in `migrations/`; background sweeps run inside accounts-api (custodian requests every minute, cleanup
every 10 minutes, webhook retries on their backoff), so after moving time either wait for the sweep or read through
the API, whose read paths apply expiry themselves. `psql "$E2E_DB"` works by hand on a `--keep` stack.

## Benchmarks on a shared machine

Stacks share one machine and one Postgres, so a timing taken while other stacks walk, build or benchmark measures the
machine as much as the endpoint. In the run that first failed the verify latency gate (load average 46 to 112 on 14
cores, about ten stacks), GET /readyz (one database round trip) had p95 74 ms from 50 concurrent callers; on a quiet
machine it has 2 ms. A journey that times something therefore:

- holds the machine's benchmark slot while it measures: `await withBenchSlot("<base> <journey>", async slot => …)`
  (`.dev/locks/e2e-bench`, mkdir-atomic, a dead holder's slot is taken over; waits up to `E2E_BENCH_SLOT_WAIT_MS`,
  default 6 minutes, then runs without it and says so in `slot.held`). `scripts/e2e-all.sh` walks each suite in both
  browsers side by side, so without it a suite's benchmark runs at the very moment its twin's does;
- times its subject interleaved with a control on the same callers and the same path, so both see the same moments of
  the machine, and judges the subject against the control when the control shows the machine was too busy to measure
  an absolute budget (a busy machine slows both alike; extra work in the subject keeps it slower however busy it is);
- may wait for a calmer machine between runs: `await waitForCalm(maxMs)` returns once the 1-minute load average is at
  most the core count, or after `maxMs`, and says which;
- sets aside a run during which its own process stood still: `const watch = watchStalls()` … `watch.stop()` returns
  the longest stretch (ms) in which a 50 ms timer could not fire. Load delays it by milliseconds; seconds
  (`FROZEN_STALL_MS`, 5 s) mean the machine was asleep. The Mac sleeps with every stack up when it runs on battery with
  the lid closed (about 15 minutes at a time between short maintenance wakes; `pmset -g log | grep -E "Sleep|Wake"`):
  in one run a control request then "took" 900 s (the Mac slept 12:19:36–12:34:37 and accounts-api logged nothing in
  between), the run's throughput read 2 req/s, and in another a keep-alive connection was reset at wake. Such a run
  measured the sleep, so it is measured again and never judged. Long walks are best run awake (`caffeinate -i`, on
  power with the lid open).

`proofs-perf-latency-verify` does all four (a run its process stood still in is measured again, up to three tries, and
a measurement frozen every time fails as "not measured"; no request waits more than 30 s for an answer): its gate
(`suites/proofs-perf/_latency-gate.ts`) is p95 ≤ 25 ms whenever the interleaved one-query control (GET
`/v1/photos/<unknown id>`, one primary-key lookup, 404) has p95 ≤ 8 ms, and otherwise verify p50 and p95 ≤ 3 × the
control's + 1 ms (room for one more query, not for several: measured at load 48 to 172, the real verify was 0.95–1.53×
the control, a verify followed by three more queries 4.6–6.3× at p50); best of three runs, with up to
`E2E_BENCH_CALM_WAIT_MS` (default 3 minutes) of waiting for calm after busy runs. `E2E_LATENCY_GATE=strict` keeps only
p95 ≤ 25 ms, for a benchmark on a machine kept quiet on purpose (for example `E2E_LATENCY_GATE=strict scripts/e2e.sh
proofs-perf-latency-verify` with no other stack running). The gate's and the measuring's unit tests run with
`web/node_modules/.bin/tsx --test web/e2e/suites/proofs-perf/test/*.test.ts`.

## Environment

`pnpm -C web e2e` (run.ts) finds the stack from the environment. `E2E_PORT_BASE=<base>` names a stack started by
`scripts/e2e.sh --keep` (or by dev.sh with those ports); without it the defaults are `scripts/dev.sh`'s (site 8590,
database `silicon_accounts`). One by one: `E2E_SITE`, `E2E_API`, `E2E_OIDC`, `E2E_MESSAGING`, `E2E_APPS`, `E2E_IRIS`,
`E2E_DB`, `E2E_PG_BIN`, `E2E_CLI` (default `target/debug/accounts`, or `$CARGO_TARGET_DIR/debug/accounts`),
`E2E_ENGINE`, `E2E_ARTIFACTS` (default `e2e/.artifacts/<base>`), `E2E_SHOTS`. Benchmarks: `E2E_BENCH_SLOT_WAIT_MS`,
`E2E_BENCH_CALM_WAIT_MS`, `E2E_LATENCY_GATE=strict` (see above). Options: `--suite`, `--engine`, `--webkit`, `--list`,
`--list-suites`, and journey prefixes.

## Browser problems

`results.watch(page, label, expected)` turns console errors, uncaught page errors, CSP refusals and failed requests
into problems that fail the journey, except those matching `expected` (a 404 the journey asks for, an imported
fixture's unreachable photo host) or the short list of browser noise in `lib.ts` (`BENIGN`). HTTP 4xx/5xx answers are
only notes. Nothing a page loads should leave the machine; the harness suite checks it.

## Troubleshooting

- Leftover stacks: `scripts/stop.sh --all --clean`; leftover databases: `dropdb -h 127.0.0.1 -p 5444 -U postgres
  accounts_e2e_<base>`; a lease of a run that was killed is taken over by the next run that wants the base.
- "a port of base N is in use": something else holds one of base − 1 … base + 4; leave `E2E_PORT_BASE` out.
- A failed journey: `report.md` (checks, problems, error), `shots/FAILED-*.png`, and `logs/accounts-api.log`.
