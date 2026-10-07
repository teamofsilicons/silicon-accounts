/**
 * OBO end to end: a new Carbon signs into dm in a real browser, dm (the fake app server) trades the Carbon's access
 * token for an OBO proof and calls Briefcase with it, Briefcase verifies it with Silicon Accounts, and the Carbon sees
 * the proof on /proofs. Then every rule of issuing one: the subject token, the receiving app, scopes, lifetimes and
 * the app's credentials.
 */
import type { Journey } from "../../context";
import { appAccount, codeFor, json, lastSeq, newContext, shot, sleep, sql } from "../../lib";
import {
  appListing,
  appTokens,
  asApp,
  errorCode,
  familyOf,
  issueObo,
  newEmail,
  newPhone,
  row,
  secondsBetween,
  short,
  signInToApp,
  verifyAs,
  type IssuedProof,
  type MyProofItem,
  type Verification,
} from "./_helpers";

interface SaveAnswer {
  ok?: boolean;
  file?: { id: string; filename: string; owner: { uuid: string; id: string; membership_id: string } | null; uploaded_by_app: string | null; proof_id: string | null; scopes: string[] };
  proof?: Omit<IssuedProof, "proof_token" | "proof_refresh_token">;
  verification?: Verification;
  timings?: { issue_ms?: number; verify_ms?: number | null; call_ms?: number; total_ms?: number };
}

const PROOF_TOKEN = /^sap_[A-Za-z0-9_-]{43}$/;
const PROOF_REFRESH_TOKEN = /^sapr_[A-Za-z0-9_-]{43}$/;

export const journeys: Journey[] = [
  {
    name: "proofs-perf-obo-browser",
    title: "a new Carbon signs into dm in the browser (email, sign-up, the phone dm requires, consent); dm saves a file to Briefcase for it through the fake apps (dm issues the OBO proof, Briefcase verifies it), and the Carbon sees the proof on /proofs",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "obo-browser");
      const email = newEmail("obo-browser");
      const phone = newPhone();

      // dm's hosted link: dm offers phone and email; the Carbon picks email.
      await page.goto(`${env.apps}/dm/`);
      await page.locator("#signin-hosted").click();
      await page.getByRole("button", { name: "Continue", exact: true }).waitFor({ timeout: 30_000 });
      const emailField = page.getByRole("textbox", { name: "Email" });
      if (!(await emailField.isVisible())) await page.getByRole("button", { name: "Email", exact: true }).click();
      await emailField.waitFor({ timeout: 10_000 });
      let after = await lastSeq(env);
      await emailField.fill(email);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const code = await codeFor(env, email, after);
      await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
      await page.keyboard.type(code, { delay: 25 });
      const create = page.getByRole("button", { name: "Create account" });
      await create.waitFor({ timeout: 30_000 });
      await sleep(300);
      await create.click();
      // dm requires a phone number: the requirement step asks for it before consent.
      const phoneField = page.getByRole("textbox", { name: "Phone number" });
      await phoneField.waitFor({ timeout: 30_000 });
      after = await lastSeq(env);
      await phoneField.click();
      await page.keyboard.type(phone, { delay: 25 });
      await sleep(250);
      await page.getByRole("button", { name: "Send code" }).click();
      const sms = await codeFor(env, phone, after);
      await page.getByRole("group", { name: /Code/ }).first().waitFor({ timeout: 15_000 });
      await page.keyboard.type(sms, { delay: 25 });
      const share = page.getByRole("button", { name: "Share and continue" });
      await share.waitFor({ timeout: 30_000 });
      await share.click();
      await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/dm/`), { timeout: 30_000 });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const account = await appAccount(page);
      const uuid = String(account?.uuid ?? "");
      results.check("dm holds the new Carbon's sign-in (AccountForApp with the phone it required)", !!uuid && account?.phone === phone, short(account));
      await shot(env, page, "proofs-perf-obo-01-dm-signed-in");

      // OBO through the fake apps: dm issues a proof for Briefcase and calls Briefcase's API with it; Briefcase verifies.
      const filename = `report-${uuid}.txt`;
      const save = await json<SaveAnswer>(`${env.apps}/dm/actions/save-to-briefcase`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uuid, filename }) });
      const v = save.body.verification;
      results.check("dm's save-to-briefcase succeeded end to end (issue at Silicon Accounts, call to Briefcase, Briefcase's verify)", save.status === 200 && save.body.ok === true, short(save.body, 600));
      results.check("Briefcase's verification is valid and names dm → briefcase, kind obo", v?.valid === true && v.kind === "obo" && v.issuing_app?.app_id === "dm" && v.issuing_app?.name === "DM" && v.receiving_app?.app_id === "briefcase" && v.receiving_app?.name === "Briefcase", short(v));
      results.check("the verification names the Carbon: uuid, current c:id, kind carbon, its membership with the issuing app (dm:<uuid>)", v?.user?.uuid === uuid && v.user.id === account?.id && v.user.kind === "carbon" && v.user.membership_id === `dm:${uuid}`, short(v?.user));
      results.check("the verification carries the scopes dm asked for and the proof token's expiry (dm asked for 600 s)", JSON.stringify(v?.scopes) === JSON.stringify(["files.write"]) && !!v?.expires_at && v.expires_at === save.body.proof?.expires_at, `${short(v?.scopes)} ${v?.expires_at} / issued ${save.body.proof?.expires_at}`);
      const lifetime = save.body.proof ? secondsBetween(save.body.proof.expires_at, new Date().toISOString()) : Number.NaN;
      results.check("the proof token lives about 600 s from now (the access_ttl_seconds dm sent)", lifetime > 540 && lifetime <= 601, `${lifetime.toFixed(1)} s left`);
      const proofId = save.body.proof?.proof_id ?? "";
      results.check("the issue answer has the contract shape without tokens leaking into dm's own answer", !!proofId && save.body.proof?.kind === "obo" && save.body.proof.issuing_app === "dm" && save.body.proof.receiving_app === "briefcase" && save.body.proof.user?.membership_id === `dm:${uuid}` && !JSON.stringify(save.body).includes("sap_"), short(save.body.proof));
      const t = save.body.timings;
      for (const [name, value] of Object.entries(t ?? {})) if (typeof value === "number") results.metric(`OBO round trip via the fake apps: ${name}`, value);

      // What Briefcase recorded: the file, owned by the Carbon, uploaded by dm under that proof.
      const files = await json<{ items: SaveAnswer["file"][] }>(`${env.apps}/briefcase/api/files?owner=${encodeURIComponent(uuid)}`);
      const file = files.body.items?.find(item => item?.filename === filename);
      results.check("Briefcase stored the file for the Carbon (owner uuid, id and membership), uploaded by dm under the verified proof", !!file && file.owner?.uuid === uuid && file.owner.membership_id === `dm:${uuid}` && file.uploaded_by_app === "dm" && file.proof_id === proofId && JSON.stringify(file.scopes) === '["files.write"]', short(file));
      const briefcaseState = await json<{ proof_checks: Array<{ valid: boolean; kind: string | null; issuing_app: string | null; user_uuid: string | null }> }>(`${env.apps}/briefcase/_state`);
      const lastCheck = briefcaseState.body.proof_checks?.find(check => check.user_uuid === uuid);
      results.check("Briefcase's own log of the check: valid, obo, from dm, for the Carbon", lastCheck?.valid === true && lastCheck.kind === "obo" && lastCheck.issuing_app === "dm", short(lastCheck));

      // dm's listing of what it issued.
      const listed = await appListing(ctx, "dm", proofId);
      results.check("dm's proof listing has it: obo, audiences [briefcase], the Carbon, active, 600 s tokens", listed?.kind === "obo" && JSON.stringify(listed.audiences) === '["briefcase"]' && listed.user?.uuid === uuid && listed.status === "active" && listed.access_ttl_seconds === 600 && listed.revoked_at === null, short(listed));
      const foreign = await asApp(ctx, "briefcase", "GET", "/v1/apps/dm/proofs");
      results.check("Briefcase cannot list dm's proofs (it is neither dm nor dm's owner)", foreign.status === 401 || foreign.status === 403 || foreign.status === 404, `${foreign.status} ${errorCode(foreign.body)}`);

      // The account's own view: GET /v1/me/proofs and the /proofs page.
      const mine = (await (await page.request.get(`${env.site}/v1/me/proofs?limit=200`)).json()) as { items: MyProofItem[] };
      const item = mine.items.find(entry => entry.proof_id === proofId);
      results.check("GET /v1/me/proofs lists it as active: DM acting at Briefcase with files.write", item?.status === "active" && item.issuing_app.app_id === "dm" && item.receiving_app.app_id === "briefcase" && JSON.stringify(item.scopes) === '["files.write"]', short(item));
      await page.goto(`${env.site}/proofs`);
      const card = page.getByRole("article", { name: "DM acts at Briefcase for you" });
      await card.first().waitFor({ timeout: 30_000 });
      await sleep(800);
      const cardText = (await card.first().innerText()).replace(/\s+/g, " ");
      results.check("/proofs shows the card \"DM acts at Briefcase for you\" with its scope and the Active badge", /files\.write/.test(cardText) && /Active/.test(cardText) && /Revoke/.test(cardText), cardText.slice(0, 300));
      await shot(env, page, "proofs-perf-obo-02-proofs-page", true);

      // History: the issue is in the audit log under the account, and in the account's history.
      const [audited] = await sql(env, `select count(*) from audit_log where action = 'proof.issued' and target_id = '${proofId}' and account_uuid = '${uuid}' and app_id = 'dm'`);
      results.check("the issue is in the audit log (proof.issued, app dm, the Carbon's uuid)", audited?.[0] === "1", String(audited));
      const history = (await (await page.request.get(`${env.site}/v1/me/history?kind=proof&limit=50`)).json()) as { items?: unknown[] };
      results.check("the Carbon's history (kind=proof) shows the proof", JSON.stringify(history.items ?? []).includes(proofId), short(history.items?.[0]));
      await context.close();
    },
  },
  {
    name: "proofs-perf-obo-rules",
    title: "issuing an OBO proof: the contract shape and token formats, an OBO proof never outlives the sign-in, and precise refusals for wrong subject tokens, receiving apps, scopes, lifetimes, bodies and app credentials",
    async run(ctx) {
      const { env, results } = ctx;
      const dm = await signInToApp(ctx, "dm");
      const briefcase = await signInToApp(ctx, "briefcase", { session: dm.session });
      results.check("one Carbon signed into dm and (continue as) Briefcase", briefcase.uuid === dm.uuid, `${dm.uuid} / ${briefcase.uuid}`);
      const subject = (await appTokens(env, "dm", dm.uuid)).access_token;
      const briefcaseToken = (await appTokens(env, "briefcase", dm.uuid)).access_token;

      // The contract shape.
      const issued = await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: ["files.write", "files.read", "files.write"], access_ttl_seconds: 900 });
      const p = issued.body;
      results.check("201 with Cache-Control: no-store", issued.status === 201 && issued.headers.get("cache-control") === "no-store", `${issued.status} ${issued.headers.get("cache-control")}`);
      results.check("proof_token is sap_ + 43 base64url characters, proof_refresh_token sapr_ + 43", PROOF_TOKEN.test(p.proof_token ?? "") && PROOF_REFRESH_TOKEN.test(p.proof_refresh_token ?? ""), `${(p.proof_token ?? "").length} / ${(p.proof_refresh_token ?? "").length} characters`);
      results.check("kind obo, issuing dm, receiving briefcase, the Carbon with membership dm:<uuid>, duplicate scopes dropped in order", p.kind === "obo" && p.issuing_app === "dm" && p.receiving_app === "briefcase" && p.receiving_apps === undefined && p.user?.uuid === dm.uuid && p.user.id === dm.id && p.user.kind === "carbon" && p.user.membership_id === `dm:${dm.uuid}` && JSON.stringify(p.scopes) === '["files.write","files.read"]', short(p, 500));
      const family = familyOf(subject);
      const signInEnd = (await row(env, `select to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from token_families where id = '${family}'`))?.[0];
      results.check("refresh_expires_at is the end of dm's sign-in (an OBO proof never outlives the sign-in it stands on)", !!signInEnd && Math.abs(Date.parse(p.refresh_expires_at) - Date.parse(signInEnd)) <= 1, `${p.refresh_expires_at} vs sign-in ${signInEnd}`);
      const days = secondsBetween(p.refresh_expires_at, new Date().toISOString()) / 86_400;
      results.check("…which is about 900 days away", days > 899 && days <= 900.01, `${days.toFixed(3)} days`);
      const ttl = secondsBetween(p.expires_at, new Date().toISOString());
      results.check("expires_at follows access_ttl_seconds 900", ttl > 840 && ttl <= 901, `${ttl.toFixed(1)} s`);
      const stored = await row(env, `select f.access_ttl_seconds, f.subject_family_id, (select count(*) from proof_tokens t where t.family_id = f.id) from proof_families f where f.id = '${p.proof_id}'`);
      results.check("stored: 900 s tokens, the subject's sign-in, one proof token + one refresh token (hashes only)", stored?.[0] === "900" && stored[1] === family && stored[2] === "2", short(stored));
      const plaintext = await row(env, `select count(*) from proof_tokens where family_id = '${p.proof_id}' and (position('sap' in encode(token_hash, 'escape')) > 0 or length(token_hash) <> 32)`);
      results.check("proof_tokens keeps 32-byte HMACs, never the tokens", plaintext?.[0] === "0", short(plaintext));
      const valid = await verifyAs(ctx, "briefcase", p.proof_token);
      results.check("Briefcase verifies it", valid.body.valid === true && valid.body.proof_id === p.proof_id, short(valid.body));

      // Default lifetime and the bounds.
      const byDefault = await issueObo(ctx, "dm", subject, { receiving_app: "briefcase" });
      const defaultTtl = secondsBetween(byDefault.body.expires_at, new Date().toISOString());
      results.check("without access_ttl_seconds a proof token lives 1800 s, and scopes default to []", byDefault.status === 201 && defaultTtl > 1740 && defaultTtl <= 1801 && JSON.stringify(byDefault.body.scopes) === "[]", `${byDefault.status} ${defaultTtl.toFixed(1)} s ${short(byDefault.body.scopes)}`);
      for (const [value, ok] of [[60, true], [1800, true], [59, false], [1801, false], [0, false], [-5, false]] as const) {
        const answer = await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", access_ttl_seconds: value });
        const fields = (answer.body.error?.details?.fields ?? {}) as Record<string, string>;
        results.check(
          `access_ttl_seconds ${value} → ${ok ? "201" : "422 validation_failed on access_ttl_seconds"}`,
          ok ? answer.status === 201 && Math.abs(secondsBetween(answer.body.expires_at, new Date().toISOString()) - value) < 60 : answer.status === 422 && errorCode(answer.body) === "validation_failed" && typeof fields.access_ttl_seconds === "string",
          `${answer.status} ${short(answer.body.error ?? answer.body.expires_at)}`,
        );
      }

      // Scopes.
      const twenty = Array.from({ length: 20 }, (_, i) => `s${i}:x/y-z_${i}.w`);
      const many = await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: twenty });
      results.check("20 distinct scopes of every allowed character are accepted", many.status === 201 && many.body.scopes.length === 20, `${many.status} ${short(many.body.error)}`);
      const tooMany = await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: [...twenty, "s20"] });
      results.check("21 scopes → 422 on scopes", tooMany.status === 422 && typeof (tooMany.body.error?.details?.fields as Record<string, string> | undefined)?.scopes === "string", `${tooMany.status} ${short(tooMany.body.error)}`);
      const badScopes = await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: ["ok", "files write", "", "x".repeat(101), "émoji"] });
      const badFields = (badScopes.body.error?.details?.fields ?? {}) as Record<string, string>;
      results.check("bad scopes → 422 naming each one: scopes[1] (space), scopes[2] (empty), scopes[3] (101 characters), scopes[4] (non-ASCII); scopes[0] is fine", badScopes.status === 422 && !!badFields["scopes[1]"] && !!badFields["scopes[2]"] && !!badFields["scopes[3]"] && !!badFields["scopes[4]"] && !badFields["scopes[0]"], short(badFields, 600));

      // The receiving app.
      const cases: Array<[string, number, string]> = [
        ["dm", 400, "invalid_receiving_app"],
        ["accounts", 400, "invalid_receiving_app"],
        [`nope-${dm.uuid.toLowerCase()}`, 400, "unknown_receiving_app"],
      ];
      for (const [receiver, status, codeName] of cases) {
        const answer = await issueObo(ctx, "dm", subject, { receiving_app: receiver });
        results.check(`receiving_app "${receiver}" → ${status} ${codeName}`, answer.status === status && errorCode(answer.body) === codeName, `${answer.status} ${short(answer.body.error)}`);
      }
      const upper = await issueObo(ctx, "dm", subject, { receiving_app: "  BriefCase " });
      results.check("receiving_app is trimmed and lower-cased (\"  BriefCase \" → briefcase)", upper.status === 201 && upper.body.receiving_app === "briefcase", `${upper.status} ${short(upper.body.receiving_app ?? upper.body.error)}`);
      const empty = await issueObo(ctx, "dm", subject, { receiving_app: "" });
      results.check("an empty receiving_app → 422 on receiving_app", empty.status === 422 && !!(empty.body.error?.details?.fields as Record<string, string> | undefined)?.receiving_app, `${empty.status} ${short(empty.body.error)}`);
      // A disabled receiving app (as Silicon Apps would set it): refused, then accepted again once it is back.
      await sql(env, "update apps set status = 'disabled' where app_id = 'waveform'");
      try {
        const disabled = await issueObo(ctx, "dm", subject, { receiving_app: "waveform" });
        results.check("a disabled receiving app → 403 receiving_app_disabled", disabled.status === 403 && errorCode(disabled.body) === "receiving_app_disabled", `${disabled.status} ${short(disabled.body.error)}`);
      } finally {
        await sql(env, "update apps set status = 'active' where app_id = 'waveform'");
      }
      const back = await issueObo(ctx, "dm", subject, { receiving_app: "waveform" });
      results.check("…and accepted again once it is active", back.status === 201, `${back.status} ${short(back.body.error)}`);

      // The subject token.
      const wrongApp = await issueObo(ctx, "dm", briefcaseToken, { receiving_app: "briefcase" });
      results.check("dm presenting Briefcase's access token → 403 subject_token_wrong_app (details.token_app briefcase)", wrongApp.status === 403 && errorCode(wrongApp.body) === "subject_token_wrong_app" && wrongApp.body.error?.details?.token_app === "briefcase", `${wrongApp.status} ${short(wrongApp.body.error)}`);
      const refreshToken = (await appTokens(env, "dm", dm.uuid)).refresh_token ?? "";
      const notAccess = await issueObo(ctx, "dm", refreshToken, { receiving_app: "briefcase" });
      results.check("a refresh token as subject → 400 invalid_subject_token (not_an_access_token), and the message never repeats it", notAccess.status === 400 && errorCode(notAccess.body) === "invalid_subject_token" && notAccess.body.error?.details?.reason === "not_an_access_token" && !JSON.stringify(notAccess.body).includes(refreshToken.slice(4, 20)), `${notAccess.status} ${short(notAccess.body.error)}`);
      const proofAsSubject = await issueObo(ctx, "dm", p.proof_token, { receiving_app: "briefcase" });
      results.check("a proof token as subject → 400 invalid_subject_token (not_an_access_token)", proofAsSubject.status === 400 && proofAsSubject.body.error?.details?.reason === "not_an_access_token" && !JSON.stringify(proofAsSubject.body).includes(p.proof_token.slice(4, 20)), `${proofAsSubject.status} ${short(proofAsSubject.body.error)}`);
      const [head = "", payload = "", signature = ""] = subject.split(".");
      const tampered = `${head}.${payload}.${signature.slice(0, -4)}${signature.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
      const badSignature = await issueObo(ctx, "dm", tampered, { receiving_app: "briefcase" });
      results.check("a tampered access token → 400 invalid_subject_token (invalid)", badSignature.status === 400 && errorCode(badSignature.body) === "invalid_subject_token" && badSignature.body.error?.details?.reason === "invalid", `${badSignature.status} ${short(badSignature.body.error)}`);
      const forged = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
      const forgedToken = `${head}.${Buffer.from(JSON.stringify({ ...forged, sub: "zzz" })).toString("base64url")}.${signature}`;
      const forgedSub = await issueObo(ctx, "dm", forgedToken, { receiving_app: "briefcase" });
      results.check("an access token whose subject was edited → 400 invalid_subject_token (the signature no longer matches)", forgedSub.status === 400 && errorCode(forgedSub.body) === "invalid_subject_token", `${forgedSub.status} ${short(forgedSub.body.error)}`);
      const blank = await issueObo(ctx, "dm", "   ", { receiving_app: "briefcase" });
      results.check("a blank subject_token → 422 on subject_token", blank.status === 422 && !!(blank.body.error?.details?.fields as Record<string, string> | undefined)?.subject_token, `${blank.status} ${short(blank.body.error)}`);

      // The body and the caller.
      const unknownField = await asApp<IssuedProof>(ctx, "dm", "POST", "/v1/proofs/obo", { subject_token: subject, receiving_app: "briefcase", user: "c:someone-else" });
      results.check("an unknown body field → 422 (bodies are strict)", unknownField.status === 422, `${unknownField.status} ${short(unknownField.body.error)}`);
      const noAuth = await asApp<IssuedProof>(ctx, "dm", "POST", "/v1/proofs/obo", { subject_token: subject, receiving_app: "briefcase" }, { secret: null });
      results.check("no app credentials → 401 app_credentials_required", noAuth.status === 401 && errorCode(noAuth.body) === "app_credentials_required", `${noAuth.status} ${short(noAuth.body.error)}`);
      const wrongSecret = await asApp<IssuedProof>(ctx, "dm", "POST", "/v1/proofs/obo", { subject_token: subject, receiving_app: "briefcase" }, { secret: "sa_app_dm_wrong" });
      results.check("a wrong app secret → 401, and the message does not repeat it", wrongSecret.status === 401 && !JSON.stringify(wrongSecret.body).includes("sa_app_dm_wrong"), `${wrongSecret.status} ${short(wrongSecret.body.error)}`);
      const bearer = await json<IssuedProof>(`${env.site}/v1/proofs/obo`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${subject}`, "x-forwarded-for": ctx.ip }, body: JSON.stringify({ subject_token: subject, receiving_app: "briefcase" }) });
      results.check("the Carbon's own access token as the caller (Bearer) → 401: only apps issue proofs", bearer.status === 401, `${bearer.status} ${short((bearer.body as { error?: unknown }).error)}`);
      const issuedByBriefcase = await issueObo(ctx, "briefcase", briefcaseToken, { receiving_app: "dm" });
      results.check("any app the Carbon signed into may issue for it: Briefcase → dm works with Briefcase's own token", issuedByBriefcase.status === 201 && issuedByBriefcase.body.user?.membership_id === `briefcase:${dm.uuid}`, `${issuedByBriefcase.status} ${short(issuedByBriefcase.body.user ?? issuedByBriefcase.body.error)}`);
    },
  },
];
