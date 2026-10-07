/**
 * Per-network rate limits, at their contract numbers: GET /v1/ids/available (120 per minute), POST /v1/reports (5 per
 * hour, a replayed Idempotency-Key costs nothing, a new key doesn't help, only accepted reports are mailed), Silicon
 * sign-in (60 attempts per minute, counted before any Argon2 work) and Silicon self-creation (10 per hour). Every
 * refusal is 429 `rate_limited` with Retry-After and details.retry_after_seconds; a forged left-most X-Forwarded-For
 * entry doesn't buy a new bucket (the right-most, the load balancer's, counts); other networks are unaffected; and the
 * window passing (time travel: the buckets' rows) lets the network in again.
 */
import type { Journey } from "../../context";
import { forgetRateLimits, randomIp, sleep, tag } from "../../lib";
import { brief, call, errorOf, remember, signInWithEmail, viaSite, type Reply } from "./_helpers";

/** What is wrong with a 429 (empty: nothing). */
function limitProblems(reply: Reply, perWindow: string, maxRetry: number): string[] {
  const problems: string[] = [];
  const error = errorOf(reply);
  if (reply.status !== 429) problems.push(`status ${reply.status}`);
  if (error.code !== "rate_limited") problems.push(`code ${error.code}`);
  const retry = Number(reply.headers.get("retry-after"));
  if (!Number.isInteger(retry) || retry < 1 || retry > maxRetry) problems.push(`Retry-After ${reply.headers.get("retry-after")}`);
  if (Number(error.details?.retry_after_seconds) !== retry) problems.push(`details.retry_after_seconds ${String(error.details?.retry_after_seconds)} ≠ Retry-After ${retry}`);
  if (!(error.message ?? "").includes(perWindow)) problems.push(`message "${error.message}" doesn't state "${perWindow}"`);
  return problems;
}

async function burst<T>(count: number, width: number, one: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; start < count; start += width) out.push(...(await Promise.all(Array.from({ length: Math.min(width, count - start) }, (_, k) => one(start + k)))));
  return out;
}

export const journey: Journey = {
  name: "security-rate-limits",
  title: "rate limits: ids/available 120/min, reports 5/hour (idempotent replay free, new key no help, only accepted reports mailed), Silicon sign-in 60/min before Argon2, self-creation 10/hour; 429 + Retry-After + details; a forged left-most X-Forwarded-For doesn't escape; other networks unaffected; the window passing lets the network in",
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    const t = viaSite(ctx);

    // 1. GET /v1/ids/available: 120 per minute per network.
    const ip = randomIp();
    const started = Date.now();
    const allowed = await burst(120, 20, i => call(`${env.site}/v1/ids/available?id=${encodeURIComponent(`c:rl-${tag()}-${i}`)}`, { ip }));
    const over = await call(`${env.site}/v1/ids/available?id=c:rl-over-${tag()}`, { ip });
    results.metric("120 ids/available calls took", Date.now() - started);
    const notOk = allowed.filter(reply => reply.status !== 200);
    results.check("ids/available: 120 calls in a minute from one network are answered", notOk.length === 0, notOk.slice(0, 3).map(brief).join(" | ") || "120 × 200");
    const overProblems = limitProblems(over, "120 per minute", 60);
    results.check("…the 121st is 429 rate_limited with Retry-After (≤ 60 s), the same details.retry_after_seconds, and says the limit", overProblems.length === 0, overProblems.join("; ") || `${brief(over)} (Retry-After ${over.headers.get("retry-after")})`);
    const forged = await call(`${env.site}/v1/ids/available?id=c:rl-forged-${tag()}`, { headers: { "x-forwarded-for": `203.0.113.${1 + Math.floor(Math.random() * 250)}, ${ip}` } });
    const forgedDirect = await call(`${env.api}/v1/ids/available?id=c:rl-forged-${tag()}`, { headers: { "x-forwarded-for": `198.51.100.7, ${ip}` } });
    results.check("a forged left-most X-Forwarded-For entry doesn't escape the limit (the right-most entry, the one the load balancer appends, counts): 429 through the site and direct", forged.status === 429 && forgedDirect.status === 429, `${brief(forged)} / ${brief(forgedDirect)}`);
    const neighbour = await call(`${env.site}/v1/ids/available?id=c:rl-other-${tag()}`, { ip: randomIp() });
    results.check("another network is unaffected (200)", neighbour.status === 200, brief(neighbour));
    await forgetRateLimits(env, ip);
    const later = await call(`${env.site}/v1/ids/available?id=c:rl-later-${tag()}`, { ip });
    results.check("once the window has passed (time travel: the bucket's row) the network is answered again", later.status === 200, brief(later));

    // 2. POST /v1/reports: 5 per hour per network.
    const reportIp = randomIp();
    const runTag = `sec-rl-${tag()}${tag()}`;
    const report = (n: number, key: string) => call<{ report_id?: string; status?: string; recipients?: number }>(`${env.site}/v1/reports`, { json: { message: `Security suite rate-limit probe ${runTag} #${n}` }, ip: reportIp, headers: { "idempotency-key": key } });
    const firstKey = `sec-${tag()}${tag()}`;
    const first = await report(1, firstKey);
    const replayed = await report(1, firstKey);
    results.check("a report is accepted (201 queued to 3 recipients) and replaying its Idempotency-Key returns the same report (Idempotent-Replayed: true)", first.status === 201 && first.body.recipients === 3 && replayed.status === 201 && replayed.body.report_id === first.body.report_id && replayed.headers.get("idempotent-replayed") === "true", `${brief(first)} ${first.body.report_id}; replay ${replayed.status} ${replayed.body.report_id} replayed=${replayed.headers.get("idempotent-replayed")}`);
    const more: Reply[] = [];
    for (let n = 2; n <= 5; n++) more.push(await report(n, `sec-${tag()}${tag()}`));
    results.check("…the replay cost nothing: 4 more distinct reports (5 in all) are accepted", more.every(reply => reply.status === 201), more.map(reply => reply.status).join(","));
    const sixth = await report(6, `sec-${tag()}${tag()}`);
    const sixthProblems = limitProblems(sixth, "5 per hour", 3600);
    results.check("…the 6th distinct report in the hour is 429 rate_limited with Retry-After (≤ 3600 s) and says the limit", sixthProblems.length === 0, sixthProblems.join("; ") || `${brief(sixth)} (Retry-After ${sixth.headers.get("retry-after")})`);
    const freshKey = await report(7, `sec-${tag()}${tag()}`);
    const forgedReport = await call(`${env.site}/v1/reports`, { json: { message: `forged ${runTag}` }, headers: { "x-forwarded-for": `203.0.113.77, ${reportIp}`, "idempotency-key": `sec-${tag()}` } });
    results.check("…neither a new Idempotency-Key nor a forged left-most X-Forwarded-For gets another one through (429)", freshKey.status === 429 && forgedReport.status === 429, `${brief(freshKey)} / ${brief(forgedReport)}`);
    const recipients = ["saketdev12@gmail.com", "shubhastro2@gmail.com", "bugs@teamofsilicons.com"];
    const mailed = async () => Promise.all(recipients.map(async to => ((await call<{ items?: unknown[] }>(`${env.messaging}/_messages?to=${encodeURIComponent(to)}&contains=${encodeURIComponent(runTag)}&limit=50`)).body.items ?? []).length));
    let counts = await mailed();
    for (let waited = 0; waited < 40 && counts.some(count => count < 5); waited++) {
      await sleep(500);
      counts = await mailed();
    }
    await sleep(2000);
    counts = await mailed();
    results.check("only the 5 accepted reports were mailed: exactly 5 emails to each of the 3 recipients (none for the refused ones)", counts.every(count => count === 5), recipients.map((to, i) => `${to}: ${counts[i]}`).join(", "));
    await forgetRateLimits(env, reportIp);
    const afterWindow = await report(8, `sec-${tag()}${tag()}`);
    results.check("once the hour has passed (time travel) the network may report again", afterWindow.status === 201, brief(afterWindow));

    // 3. Silicon sign-in: 60 attempts per minute per network, counted before the id is even read (no Argon2 cost).
    const loginIp = randomIp();
    const attempts = await burst(60, 20, () => call(`${env.site}/v1/silicons/login`, { json: { id: "si:x", stk: "stk-0123456789ab" }, ip: loginIp }));
    const loginOver = await call(`${env.site}/v1/silicons/login`, { json: { id: `si:rl-${tag()}`, stk: "stk-0123456789ab" }, ip: loginIp });
    const loginProblems = limitProblems(loginOver, "60 per minute", 60);
    results.check("Silicon sign-in: 60 attempts per minute from a network are let through to be judged (even malformed ones), the 61st is 429 with Retry-After", attempts.every(reply => reply.status === 422) && loginProblems.length === 0, `${attempts.filter(reply => reply.status === 422).length}/60 judged (422 invalid_id); 61st: ${loginProblems.join("; ") || brief(loginOver)}`);
    await forgetRateLimits(env, loginIp);

    // 4. Silicon self-creation: 10 per hour per network (successful ones count).
    const custodian = await signInWithEmail(t, { label: "ratelimit" });
    remember(ctx, "session cookie", custodian.jar.get("sa_session"));
    remember(ctx, "code", custodian.code);
    const createIp = randomIp();
    const created: Reply[] = [];
    for (let i = 0; i < 10; i++) {
      const reply = await call<{ stk?: string | null; request_token?: string }>(`${env.site}/v1/silicons`, { json: { id: `si:rl-${tag()}${tag()}`.slice(0, 33), display_name: `Limit ${i}`, custodian: custodian.id }, ip: createIp, headers: { "idempotency-key": `sec-${tag()}${tag()}` } });
      remember(ctx, "stk", reply.body.stk);
      remember(ctx, "request token", reply.body.request_token);
      created.push(reply);
    }
    const eleventh = await call(`${env.site}/v1/silicons`, { json: { id: `si:rl-${tag()}${tag()}`.slice(0, 33), display_name: "Limit 11", custodian: custodian.id }, ip: createIp, headers: { "idempotency-key": `sec-${tag()}` } });
    const createProblems = limitProblems(eleventh, "per hour", 3600);
    results.check("Silicon self-creation: 10 in an hour from one network are created, the 11th is 429 with Retry-After", created.every(reply => reply.status === 201) && createProblems.length === 0, `${created.map(reply => reply.status).join(",")}; 11th: ${createProblems.join("; ") || brief(eleventh)}`);
    await forgetRateLimits(env, createIp);

    // 5. Request size limits: a public endpoint refuses an oversized body before reading it (64 KB by default), with a
    //    declared length and when streamed without one, through the site and straight at accounts-api.
    const big = JSON.stringify({ id: "si:x", stk: "stk-0123456789ab", client_label: "x".repeat(70 * 1024) });
    const declared = await call(`${env.site}/v1/silicons/login`, { body: big, contentType: "application/json", ip: randomIp() });
    const declaredDirect = await call(`${env.api}/v1/silicons/login`, { body: big, contentType: "application/json", ip: randomIp() });
    let streamed = 0;
    try {
      const chunks = [new TextEncoder().encode(big.slice(0, 40_000)), new TextEncoder().encode(big.slice(40_000))];
      const response = await fetch(`${env.api}/v1/silicons/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": randomIp() },
        body: new ReadableStream({ pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); } }),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      streamed = response.status;
      await response.text();
    } catch (error) {
      streamed = (error as Error).message.includes("fetch failed") ? -1 : 0;
    }
    const sized = (reply: Reply) => reply.status === 413 && errorOf(reply).code === "payload_too_large" && Number(errorOf(reply).details?.limit_bytes) === 65_536;
    results.check("an oversized body (70 KB) to a public endpoint is refused 413 payload_too_large (limit 65536 bytes) with a declared length (site and direct) and when streamed without one", sized(declared) && sized(declaredDirect) && (streamed === 413 || streamed === -1), `site ${brief(declared)}; direct ${declaredDirect.status}; streamed ${streamed === -1 ? "connection closed" : streamed}`);
  },
};
