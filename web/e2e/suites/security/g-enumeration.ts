/**
 * Enumeration resistance. Silicon sign-in answers an unknown si:id and a wrong STK with the very same 401 (status,
 * code, message, hint, headers), after the same Argon2id work (no timing oracle), also for a Silicon whose custodian
 * hasn't accepted yet; the hosted sign-in treats a known and an unknown email the same until the code is proven; and
 * account lookups need an app or a session. Two documented, deliberate exceptions are recorded as notes: the
 * 10-failures lock exists only for real Silicons, and the CLI's headless code sign-in says when no Carbon has an
 * address (02-api.md).
 */
import { randomBytes } from "node:crypto";
import type { Journey } from "../../context";
import { forgetRateLimits, randomIp, tag } from "../../lib";
import { brief, call, callbackOf, createSilicon, errorOf, flowOf, flowStep, median, randomPhone, remember, siliconLogin, signInWithEmail, signInWithPhone, startFlow, viaSite, Jar, type Reply } from "./_helpers";

/** The parts of a refusal a prober could compare. */
const shape = (reply: Reply) => {
  const error = errorOf(reply);
  return JSON.stringify({ status: reply.status, code: error.code, message: error.message, hint: error.hint, details: error.details ?? null, type: reply.headers.get("content-type"), retry: reply.headers.get("retry-after") });
};

export const journey: Journey = {
  name: "security-enumeration",
  title: "enumeration: Silicon sign-in gives an unknown si:id and a wrong STK the identical 401 (message, hint, headers, timing), also for a pending Silicon; the hosted flow treats known and unknown emails alike until the code; lookups need credentials; the CLI's documented address oracle is throttled at 60 per 10 minutes per network; the lock-only-for-real-ids and CLI account_not_found behaviours are recorded as notes; adding an address on an app's details page is counted like the account site's add (no unlimited in-use oracle)",
  engines: ["chromium"],
  timeoutMs: 600_000,
  async run(ctx) {
    const { env, results } = ctx;
    const t = viaSite(ctx);
    const custodian = await signInWithEmail(t, { label: "enum" });
    remember(ctx, "session cookie", custodian.jar.get("sa_session"));
    remember(ctx, "code", custodian.code);
    const silicon = await createSilicon(t, custodian.jar, "enum");
    remember(ctx, "stk", silicon.stk);
    const ghost = `si:ghost-${tag()}${tag()}`;
    const wrong = "stk-0123456789ab";

    // 1. The same answer for "no such Silicon" and "wrong STK", in every combination of STK lengths.
    const pairs: Array<[string, string, string]> = [
      ["12-hex STK", wrong, wrong],
      ["32-hex STK", `stk-${"a1".repeat(16)}`, `stk-${"a1".repeat(16)}`],
      ["8-hex vs 32-hex", "stk-deadbeef", `stk-${"0f".repeat(16)}`],
      ["bare hex without stk-", "0123456789ab", "0123456789ab"],
    ];
    const differences: string[] = [];
    const echoes: string[] = [];
    let sample = "";
    for (const [label, unknownStk, wrongStk] of pairs) {
      const unknown = await siliconLogin(t, ghost, unknownStk, randomIp());
      const known = await siliconLogin(t, silicon.id, wrongStk, randomIp());
      sample = `${errorOf(known).code}: ${errorOf(known).message}`;
      if (shape(unknown) !== shape(known)) differences.push(`${label}: unknown ${shape(unknown)} ≠ wrong ${shape(known)}`);
      if (unknown.status !== 401 || errorOf(unknown).code !== "invalid_credentials") differences.push(`${label}: ${brief(unknown)}`);
      for (const [reply, presented] of [[unknown, unknownStk], [known, wrongStk]] as const) if (reply.text.includes(presented.replace(/^stk-/, "")) || reply.text.includes(silicon.stk)) echoes.push(`${label} echoes an STK`);
    }
    results.check(`an unknown si:id and a known si:id with a wrong STK get byte-identical refusals (status, code, message, hint, details, headers) for ${pairs.length} STK shapes`, differences.length === 0, differences.join(" | ") || sample);
    results.check("…and no refusal echoes the presented STK or the real one", echoes.length === 0, echoes.join(" | ") || "no STK in any body");
    // A success ends the run of wrong STKs (10 in a row would lock the Silicon).
    await siliconLogin(t, silicon.id, silicon.stk, randomIp());

    // 2. Timing: the unknown id pays the same Argon2id cost (5 wrong STKs stay under the 10-failure lock).
    const unknownMs: number[] = [];
    const wrongMs: number[] = [];
    for (let i = 0; i < 5; i++) {
      unknownMs.push((await siliconLogin(t, `si:ghost-${tag()}${tag()}`, wrong, randomIp())).ms);
      wrongMs.push((await siliconLogin(t, silicon.id, `stk-${randomBytes(6).toString("hex")}`, randomIp())).ms);
    }
    const ratio = median(unknownMs) / Math.max(1, median(wrongMs));
    results.metric("silicon login unknown id median", median(unknownMs));
    results.metric("silicon login wrong STK median", median(wrongMs));
    results.metric("silicon login unknown/wrong time ratio", ratio, "ratio");
    results.check("no timing oracle: an unknown si:id takes about as long as a wrong STK (median ratio between 0.5 and 2)", ratio >= 0.5 && ratio <= 2, `unknown ${unknownMs.map(Math.round).join("/")} ms (median ${Math.round(median(unknownMs))}), wrong STK ${wrongMs.map(Math.round).join("/")} ms (median ${Math.round(median(wrongMs))}), ratio ${ratio.toFixed(2)}`);
    await call(`${env.site}/v1/silicons/login`, { json: { id: silicon.id, stk: silicon.stk }, ip: ctx.ip });

    // 3. A Silicon still waiting for its custodian: a wrong STK gets the same answer; only the right STK learns why.
    const pendingId = `si:pending-${tag()}${tag()}`.slice(0, 33);
    const selfCreated = await call<{ stk?: string | null; request_token?: string }>(`${env.site}/v1/silicons`, { json: { id: pendingId, display_name: "Pending", custodian: custodian.id }, ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
    remember(ctx, "stk", selfCreated.body.stk);
    remember(ctx, "request token", selfCreated.body.request_token);
    const pendingWrong = await siliconLogin(t, pendingId, wrong, randomIp());
    const pendingUnknown = await siliconLogin(t, `si:ghost-${tag()}${tag()}`, wrong, randomIp());
    const pendingRight = await siliconLogin(t, pendingId, selfCreated.body.stk ?? "", randomIp());
    results.check("a Silicon whose custodian hasn't accepted gets the same 401 for a wrong STK (its pending state is told only to the right STK: 403 custodian_pending)", selfCreated.status === 201 && shape(pendingWrong) === shape(pendingUnknown) && pendingRight.status === 403 && errorOf(pendingRight).code === "custodian_pending", `create ${selfCreated.status}; wrong ${brief(pendingWrong)}; right ${brief(pendingRight)}`);

    // 4. The hosted sign-in: a known and an unknown email look the same until the code is proven.
    const step = async (email: string) => {
      const jar = new Jar();
      const flow = flowOf(await startFlow(t, jar, { app_id: "briefcase", redirect_uri: callbackOf(env, "briefcase"), state: `e-${tag()}` }));
      const sent = await flowStep(t, jar, flow?.id ?? "", "email", { email });
      const bad = await flowStep(t, jar, flow?.id ?? "", "verify", { code: "000000" });
      return { sent, bad, view: flowOf(sent) };
    };
    const knownFlow = await step(custodian.email);
    const unknownFlow = await step(`sec.enum.nobody.${tag()}${tag()}@example.test`);
    const viewShape = (view: ReturnType<typeof flowOf>) => JSON.stringify({ step: view?.step, keys: Object.keys(view ?? {}).sort(), signup: view?.signup ?? null, signed_in_as: view?.signed_in_as ?? null, masked: (view?.challenge?.destination ?? "").replace(/^[^*]*/, "").replace(/@.*/, "@…"), channel: view?.challenge?.channel });
    results.check("POST /v1/flows/{id}/email answers a known and an unknown address the same (200 verify_code, same view, same masking)", knownFlow.sent.status === 200 && unknownFlow.sent.status === 200 && viewShape(knownFlow.view) === viewShape(unknownFlow.view), `${viewShape(knownFlow.view)} vs ${viewShape(unknownFlow.view)}`);
    results.check("…and a wrong code gets the same 422 for both", shape(knownFlow.bad) === shape(unknownFlow.bad) && knownFlow.bad.status === 422, `${brief(knownFlow.bad)} | ${brief(unknownFlow.bad)}`);
    results.metric("hosted email step (known address)", knownFlow.sent.ms);
    results.metric("hosted email step (unknown address)", unknownFlow.sent.ms);

    // 5. Looking accounts up needs an app or a session.
    const byId = await call(`${env.site}/v1/accounts/by-id/${encodeURIComponent(custodian.id)}`, { ip: ctx.ip });
    const byUuid = await call(`${env.site}/v1/accounts/${encodeURIComponent(custodian.uuid)}`, { ip: ctx.ip });
    const siliconLookup = await call(`${env.site}/v1/accounts/by-id/${encodeURIComponent(silicon.id)}`, { ip: ctx.ip });
    results.check("anonymous account lookups (by c:id, by uuid, a Silicon by si:id) are refused 401: profiles can't be harvested without credentials", [byId, byUuid, siliconLookup].every(reply => reply.status === 401 && !reply.text.includes(custodian.email)), [byId, byUuid, siliconLookup].map(brief).join(" | "));

    // 6. Notes on two deliberate behaviours (recorded, not judged).
    const lockSilicon = await createSilicon(t, custodian.jar, "lock");
    remember(ctx, "stk", lockSilicon.stk);
    const lockIp = randomIp();
    const knownAnswers: number[] = [];
    const ghostAnswers: number[] = [];
    const lockGhost = `si:ghost-${tag()}${tag()}`;
    for (let i = 0; i < 10; i++) {
      const [known, unknown] = await Promise.all([siliconLogin(t, lockSilicon.id, wrong, lockIp), siliconLogin(t, lockGhost, wrong, randomIp())]);
      knownAnswers.push(known.status);
      ghostAnswers.push(unknown.status);
    }
    const whileLocked = await siliconLogin(t, lockSilicon.id, lockSilicon.stk, randomIp());
    results.check("(note) 10 wrong STKs lock a real Silicon (423 login_locked, even for the right STK) while an unknown si:id keeps answering 401, so a prober who sends 10 guesses can tell them apart; si:ids are public anyway (GET /v1/ids/available says taken)", true, `real: ${knownAnswers.join(",")}, right STK during the lock ${whileLocked.status} ${errorOf(whileLocked).code}; unknown: ${ghostAnswers.join(",")}`);
    const available = await call<{ available?: boolean; reason?: string }>(`${env.site}/v1/ids/available?id=${encodeURIComponent(lockSilicon.id)}`, { ip: ctx.ip });
    results.check("(note) the availability endpoint itself says a si:id is taken (by design)", available.status === 200, `${lockSilicon.id}: available=${available.body.available} reason=${available.body.reason}`);
    const cliKnown = await call(`${env.site}/v1/cli/login/start`, { json: { email: custodian.email }, ip: ctx.ip });
    const cliUnknown = await call(`${env.site}/v1/cli/login/start`, { json: { email: `sec.enum.cli.${tag()}@example.test` }, ip: ctx.ip });
    results.check("(note) the CLI's headless code sign-in tells a known address (a code is sent) from an unknown one (404 account_not_found), as 02-api.md specifies", true, `known ${cliKnown.status}, unknown ${brief(cliUnknown)}`);
    await forgetRateLimits(env, ctx.ip);

    // 7. That oracle is throttled per network: 60 lookups per 10 minutes, unknown addresses included (no code is sent
    //    for them, so only this limit stops a prober from testing a list of addresses).
    const prober = randomIp();
    const probes: Reply[] = [];
    for (let start = 0; start < 60; start += 15) probes.push(...(await Promise.all(Array.from({ length: 15 }, (_, k) => call(`${env.site}/v1/cli/login/start`, { json: { email: `sec.enum.probe.${start + k}.${tag()}@example.test` }, ip: prober })))));
    const probe61 = await call(`${env.site}/v1/cli/login/start`, { json: { email: `sec.enum.probe.61.${tag()}@example.test` }, ip: prober });
    const probeKnown = await call(`${env.site}/v1/cli/login/start`, { json: { email: custodian.email }, ip: prober });
    const elsewhere = await call(`${env.site}/v1/cli/login/start`, { json: { email: `sec.enum.probe.other.${tag()}@example.test` }, ip: randomIp() });
    const retry = Number(probe61.headers.get("retry-after"));
    const answered = probes.filter(reply => reply.status === 404 && errorOf(reply).code === "account_not_found").length;
    results.check("the CLI's address lookup is throttled per network: 60 lookups of unknown addresses are answered (404), the 61st and a known address after it get 429 rate_limited with Retry-After (≤ 600 s), and another network is unaffected", answered === 60 && probe61.status === 429 && errorOf(probe61).code === "rate_limited" && retry >= 1 && retry <= 600 && Number(errorOf(probe61).details?.retry_after_seconds) === retry && probeKnown.status === 429 && elsewhere.status === 404, `${answered}/60 answered 404; 61st ${brief(probe61)} (Retry-After ${probe61.headers.get("retry-after")}); known address after it ${probeKnown.status}; another network ${elsewhere.status}`);
    await forgetRateLimits(env, prober);

    // 8. Adding a missing email or phone on an app's details page (v2: POST /v1/flows/{id}/details/add) answers 409
    //    phone_in_use / email_in_use when another account has the address, before any code is sent. The account site's
    //    own "add a phone" answers the same 409 and therefore counts every attempt first (20 per account, 30 per network
    //    every 10 minutes: "otherwise anyone signed in could check, without limit, whether an address has an account");
    //    the details page is the same question and must not be an unlimited way around that.
    const known = await signInWithPhone(t, { phone: randomPhone() });
    remember(ctx, "session cookie", known.jar.get("sa_session"));
    remember(ctx, "code", known.code);
    const phoneProber = await signInWithEmail(t, { label: "phoneprober" });
    remember(ctx, "session cookie", phoneProber.jar.get("sa_session"));
    remember(ctx, "code", phoneProber.code);
    const probeJar = phoneProber.jar.clone();
    const crm = flowOf(await startFlow(t, probeJar, { app_id: "legacy-crm", redirect_uri: callbackOf(env, "legacy-crm"), state: `crm-${tag()}` }));
    const onPage = flowOf(await flowStep(t, probeJar, crm?.id ?? "", "continue"));
    const phoneRow = onPage?.details?.fields.find(field => field.field === "phone");
    const detailsIp = randomIp();
    const detailsAnswers: Reply[] = [];
    for (let i = 0; i < 35; i++) detailsAnswers.push(await call(`${env.site}/v1/flows/${onPage?.id}/details/add`, { json: { phone: known.phone }, jar: probeJar, origin: env.site, ip: detailsIp }));
    const inUse = detailsAnswers.filter(reply => reply.status === 409 && errorOf(reply).code === "phone_in_use").length;
    const limited = detailsAnswers.filter(reply => reply.status === 429).length;
    // Control: the account site's own add-a-phone, same Carbon, same number.
    const controlIp = randomIp();
    const controlAnswers: Reply[] = [];
    for (let i = 0; i < 22; i++) controlAnswers.push(await call(`${env.site}/v1/me/phones`, { json: { phone: known.phone }, jar: phoneProber.jar, origin: env.site, ip: controlIp, headers: { "idempotency-key": `sec-${tag()}${tag()}` } }));
    const controlInUse = controlAnswers.filter(reply => reply.status === 409).length;
    const controlLimited = controlAnswers.filter(reply => reply.status === 429).length;
    results.check("control: on the account site a signed-in Carbon asking to add a phone another account has gets 409 phone_in_use at most 20 times, then 429 (every attempt is counted before the answer)", controlInUse <= 20 && controlLimited > 0, `${controlInUse} × 409, ${controlLimited} × 429 of ${controlAnswers.length}${controlAnswers[controlAnswers.length - 1] ? `; last ${brief(controlAnswers[controlAnswers.length - 1]!)}` : ""}`);
    results.check("adding a missing phone on an app's details page is counted the same way: 35 tries with a phone another account has (legacy-crm's optional phone) get at most 20 answers of 409 phone_in_use before 429, so the page is no unlimited way to learn whether a phone number has an account", phoneRow?.missing === true && limited > 0 && inUse <= 20, `page ${onPage?.step} (phone ${phoneRow ? `${phoneRow.mode}, missing ${phoneRow.missing}` : "not on the page"}); ${inUse} × 409 phone_in_use, ${limited} × 429 of ${detailsAnswers.length}; last ${detailsAnswers[detailsAnswers.length - 1] ? brief(detailsAnswers[detailsAnswers.length - 1]!) : "none"}`);
    await forgetRateLimits(env, detailsIp);
    await forgetRateLimits(env, controlIp);
  },
};
