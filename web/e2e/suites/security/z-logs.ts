/**
 * Secrets at rest and in the logs. These journeys run last in the suite and use every secret its other journeys
 * handled (shared under SECRETS_KEY).
 *
 * security-at-rest dumps the stack's database and looks for any of those secrets, and for anything shaped like one:
 * the service keeps cookies, refresh tokens, authorization codes, SLTs and request tokens as hashes, STKs as Argon2id
 * hashes, webhook and provider secrets encrypted, and seals idempotent answers that carry a new secret ("a database
 * read reveals no secret"). It then checks the one-time codes: the challenge keeps only a hash, so a live code must not
 * be readable from the database either, or a read of it (a replica, a backup, a support query) is enough to sign in as
 * any Carbon.
 *
 * security-logs makes a fresh set of secrets of every kind (codes, wrong codes, STKs, wrong STKs, session/flow/sign-up
 * cookies, access/refresh/id tokens, authorization codes, SLTs, request polling tokens, webhook secrets, app secrets
 * sent with Basic auth), then scans the stack's own accounts-api and site logs for every secret the suite handled, and
 * for anything shaped like a secret (prefixed tokens, STKs, JWTs, Authorization headers, provider and messaging
 * credentials).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { codeFor, lastSeq, sleep, sql, tag } from "../../lib";
import { ROOT, appCredentials, appTokens, base64url, brief, call, callbackOf, createSilicon, dumpDatabase, flowOf, flowStep, remember, remembered, signInWithEmail, siliconLogin, stackLog, startFlow, viaSite, Jar } from "./_helpers";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The table of the COPY block of a pg_dump text that holds `index`. */
function tableAt(dump: string, index: number): string {
  const copy = dump.lastIndexOf("\nCOPY ", index);
  return copy < 0 ? "?" : (/^COPY ([^ ]+)/.exec(dump.slice(copy + 1, copy + 200))?.[1] ?? "?");
}

/** Shapes of secrets, for the logs and the database. */
function secretShapes(credentials: { managed: { google: { client_secret: string } }; messaging: { postmark: { server_token: string }; twilio: { auth_token: string } } }): Array<[string, RegExp]> {
  return [
    ["a prefixed token (sas_/saf_/sau_/sar_/sac_/slt_/sad_/sap_/sapr_/sarq_)", /\b(sas|saf|sau|sar|sac|slt|sad|sap|sapr|sarq)_[A-Za-z0-9_-]{30,}/],
    ["a webhook secret", /whsec_[A-Za-z0-9_-]{16,}/],
    ["an app secret", /sa_app_[a-z0-9-]+_[A-Za-z0-9]{30,}/],
    ["an STK", /\bstk-[0-9a-f]{8,32}\b/],
    ["a JWT", /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/],
    ["an Authorization header", /authorization["']?\s*[:=]\s*["']?(basic|bearer)\s+[A-Za-z0-9]/i],
    ["the managed Google client secret", new RegExp(escapeRegExp(credentials.managed.google.client_secret))],
    ["the Postmark server token", new RegExp(escapeRegExp(credentials.messaging.postmark.server_token))],
    ["the Twilio auth token", new RegExp(escapeRegExp(credentials.messaging.twilio.auth_token))],
    ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
}

const atRest: Journey = {
  name: "security-at-rest",
  title: "secrets at rest: a dump of the stack's database holds none of the secrets the suite handled (STKs, cookies, access/refresh/id tokens, auth codes, SLTs, request/proof tokens, webhook and app secrets) and nothing shaped like one; a live verification code isn't readable from it either, so a read of the database can't sign anyone in",
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    const t = viaSite(ctx);
    const credentials = JSON.parse(readFileSync(join(ROOT, "testkit/dev-credentials.json"), "utf8")) as Parameters<typeof secretShapes>[0];

    // A Carbon (the victim), and an attacker who starts a sign-in of their own for the victim's email: the victim's
    // inbox gets a code, live for 10 minutes.
    const victim = await signInWithEmail(t, { label: "atrest" });
    remember(ctx, "session cookie", victim.jar.get("sa_session"));
    remember(ctx, "code", victim.code);
    const attacker = new Jar();
    const attack = flowOf(await startFlow(t, attacker, { app_id: "silicon-accounts", redirect_uri: `${env.site}/sign-in`, state: `ar-${tag()}`, prompt: "login" }));
    const after = await lastSeq(env);
    const sent = await flowStep(t, attacker, attack?.id ?? "", "email", { email: victim.email });
    const mailed = await codeFor(env, victim.email, after);
    remember(ctx, "code", mailed);
    remember(ctx, "sa_flow cookie", attacker.get("sa_flow"));

    // 1. The database, as a dump would show it.
    const dump = await dumpDatabase(env);
    const secrets = remembered(ctx).filter(({ value }) => !/^\d{6}$/.test(value));
    const kinds = new Map<string, number>();
    for (const { kind } of secrets) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    const stored: string[] = [];
    for (const { kind, value } of secrets) {
      const at = dump.indexOf(value);
      if (at >= 0) stored.push(`${kind} in ${tableAt(dump, at)}`);
    }
    results.check(`none of the ${secrets.length} secrets the suite handled is stored in clear in the database (${[...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ")})`, secrets.length > 0 && stored.length === 0, stored.slice(0, 8).join(" | ") || `${dump.length} bytes of pg_dump scanned`);
    const shaped: string[] = [];
    for (const [label, pattern] of secretShapes(credentials)) {
      const match = pattern.exec(dump);
      if (match) shaped.push(`${label} in ${tableAt(dump, match.index)}`);
    }
    results.check("nothing shaped like a secret is in the database (prefixed tokens, webhook/app secrets, STKs, JWTs, Authorization headers, provider credentials, private keys)", shaped.length === 0, shaped.join(" | ") || `${dump.length} bytes scanned`);
    const sealed = await sql(env, "select count(*) filter (where response ? '$sealed'), count(*) from idempotency_keys");
    results.metric("idempotent answers stored sealed", Number(sealed[0]?.[0] ?? 0), "count");
    results.metric("database dump scanned", dump.length, "bytes");

    // 2. One-time codes: the challenge keeps a hash, so the live code must not be readable from anywhere else.
    const hashed = await sql(env, `select count(*) from otp_challenges where destination = '${victim.email}' and expires_at > now()`);
    const outbox = await sql(env, `select purpose, status, (text_body like '%${mailed}%')::text, (coalesce(html_body, '') like '%${mailed}%')::text from outbound_messages where to_address = '${victim.email}' order by created_at`);
    const holding = outbox.filter(row => row[2] === "true" || row[3] === "true");
    const allCodes = await sql(env, "select purpose, status, count(*) from outbound_messages where purpose like 'otp%' and text_body ~ '[0-9]{6}' group by 1, 2 order by 1, 2");
    results.check(
      "a live verification code is not stored in clear: only its challenge's hash is (outbound_messages keeps no readable code once the email is handed to the provider)",
      sent.status === 200 && holding.length === 0,
      `${hashed[0]?.[0] ?? "?"} live challenge(s) for the victim (hashed); outbound_messages rows holding the live code ${mailed}: ${holding.map(row => `${row[0]} ${row[1]} (text${row[3] === "true" ? " + html" : ""})`).join(", ") || "none"}; code emails in the whole outbox that still show their code: ${allCodes.map(row => `${row[0]}/${row[1]} ${row[2]}`).join(", ") || "none"}`,
    );

    // 3. What that means: with nothing but a read of the database, the attacker finishes their own sign-in as the victim.
    const read = await sql(env, `select substring(text_body from '[0-9]{6}') from outbound_messages where to_address = '${victim.email}' and purpose = 'otp_signin' order by created_at desc limit 1`);
    const fromDatabase = read[0]?.[0] ?? "";
    let outcome = "no code in the database to try";
    let signedInAsVictim = false;
    if (/^\d{6}$/.test(fromDatabase)) {
      const verified = await flowStep(t, attacker, attack?.id ?? "", "verify", { code: fromDatabase });
      const session = await call<{ account?: { uuid: string; id: string } }>(`${env.site}/v1/session`, { jar: attacker, ip: ctx.ip });
      remember(ctx, "session cookie", attacker.get("sa_session"));
      signedInAsVictim = session.status === 200 && session.body.account?.uuid === victim.uuid;
      outcome = `code ${fromDatabase === mailed ? "= the mailed one" : "≠ the mailed one"} read from outbound_messages; verify ${brief(verified)} → flow ${flowOf(verified)?.step}; attacker's browser now ${session.status === 200 ? `signed in as ${session.body.account?.id} (${session.body.account?.uuid === victim.uuid ? "THE VICTIM" : "someone else"})` : `not signed in (${session.status})`}`;
    }
    results.check("a read of the database is not enough to sign in as a Carbon: an attacker who starts a sign-in for the victim's email can't finish it with anything the database holds", !signedInAsVictim, outcome);
  },
};

const logs: Journey = {
  name: "security-logs",
  title: "no secret in the logs: after making every kind of secret (and the ones the suite's other journeys handled), the stack's accounts-api, account site and developer site logs contain none of them and nothing shaped like one (prefixed tokens, STKs, JWTs, Authorization headers, provider credentials)",
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    const t = viaSite(ctx);
    const logPath = stackLog(env);
    if (!logPath) {
      results.check("the stack's accounts-api log exists (.dev/logs/<base>/accounts-api.log)", false, `no log for base ${env.base}`);
      return;
    }
    const sizeBefore = readFileSync(logPath, "utf8").length;

    // Every kind of secret, through the API.
    const { tokens, carbon } = await appTokens(t, "briefcase", { scope: "openid email", label: "logs" });
    remember(ctx, "code", carbon.code, carbon.authCode);
    remember(ctx, "access token", tokens.access_token);
    remember(ctx, "refresh token", tokens.refresh_token);
    remember(ctx, "id token", tokens.id_token);
    for (const name of ["sa_session", "sa_flow"]) remember(ctx, `${name} cookie`, carbon.jar.get(name));
    for (const cookie of carbon.jar.seen) if (cookie.value) remember(ctx, `${cookie.name} cookie`, cookie.value);
    const silicon = await createSilicon(t, carbon.jar, "logs");
    remember(ctx, "stk", silicon.stk);
    const login = await siliconLogin(t, silicon.id, silicon.stk);
    remember(ctx, "access token", login.body.access_token);
    remember(ctx, "refresh token", login.body.refresh_token);
    const wrongStk = `stk-${randomBytes(6).toString("hex")}`;
    await siliconLogin(t, silicon.id, wrongStk);
    remember(ctx, "wrong stk", wrongStk);
    const slt = await call<{ slt?: string }>(`${env.site}/v1/me/short-lived-tokens`, { json: { app_id: "remind" }, bearer: login.body.access_token, ip: ctx.ip });
    remember(ctx, "slt", slt.body.slt);
    const exchanged = await call<{ access_token?: string; refresh_token?: string }>(`${env.site}/v1/oauth/token`, { form: { grant_type: "urn:silicon:params:oauth:grant-type:slt", slt: slt.body.slt ?? "" }, basic: appCredentials("remind"), ip: ctx.ip });
    remember(ctx, "access token", exchanged.body.access_token);
    remember(ctx, "refresh token", exchanged.body.refresh_token);
    const pending = await call<{ stk?: string | null; request_token?: string }>(`${env.site}/v1/silicons`, { json: { id: `si:logs-${tag()}${tag()}`.slice(0, 33), display_name: "Logs", custodian: carbon.id }, ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
    remember(ctx, "stk", pending.body.stk);
    remember(ctx, "request token", pending.body.request_token);
    const hook = await call<{ secret?: string }>(`${env.site}/v1/apps/spacestation/webhook`, { method: "PUT", json: { url: `${env.apps}/spacestation/webhooks` }, basic: appCredentials("spacestation"), ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
    remember(ctx, "webhook secret", hook.body.secret);
    await call(`${env.site}/v1/apps/spacestation/webhook`, { method: "DELETE", basic: appCredentials("spacestation"), ip: ctx.ip });
    const wrongSecret = `sa_app_briefcase_${base64url(randomBytes(30))}`;
    await call(`${env.site}/v1/apps/briefcase`, { basic: ["briefcase", wrongSecret], ip: ctx.ip });
    remember(ctx, "wrong app secret", wrongSecret);
    remember(ctx, "app secret", appCredentials("briefcase")[1], appCredentials("remind")[1], appCredentials("spacestation")[1]);
    const flowJar = new Jar();
    const flow = flowOf(await startFlow(t, flowJar, { app_id: "briefcase", redirect_uri: callbackOf(env, "briefcase"), state: `l-${tag()}`, prompt: "login" }));
    const after = await lastSeq(env);
    await flowStep(t, flowJar, flow?.id ?? "", "email", { email: carbon.email });
    const code = await codeFor(env, carbon.email, after);
    remember(ctx, "code", code);
    const wrongCode = code === "424242" ? "242424" : "424242";
    await flowStep(t, flowJar, flow?.id ?? "", "verify", { code: wrongCode });
    remember(ctx, "wrong code", wrongCode);
    await call(`${env.site}/v1/me`, { bearer: `${tokens.access_token.slice(0, -4)}AAAA`, ip: ctx.ip });

    // Give the logger a moment, then read everything the stack logged.
    await sleep(1500);
    const apiLog = readFileSync(logPath, "utf8");
    const webLogPath = stackLog(env, "web");
    const webLog = webLogPath ? readFileSync(webLogPath, "utf8") : "";
    const developerLogPath = stackLog(env, "developer");
    const developerLog = developerLogPath ? readFileSync(developerLogPath, "utf8") : "";
    const logFiles: Array<[string, string]> = [["accounts-api.log", apiLog], ["web.log", webLog], ["developer.log", developerLog]];
    const grew = apiLog.length - sizeBefore;
    const requestLines = apiLog.split("\n").filter(line => /route=\/v1\//.test(line)).length;
    results.check("the stack's accounts-api log is being written (this journey's requests are in it)", grew > 0 && requestLines > 20, `${logPath.replace(`${ROOT}/`, "")}: ${apiLog.split("\n").length} lines, ${requestLines} request lines, grew ${grew} bytes during this journey`);

    // 1. Every secret the suite saw.
    const secrets = remembered(ctx);
    const kinds = new Map<string, number>();
    for (const { kind } of secrets) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    const found: string[] = [];
    for (const { kind, value } of secrets) {
      const pattern = /^\d{6}$/.test(value) ? new RegExp(`(?<![0-9])${value}(?![0-9])`) : new RegExp(escapeRegExp(value));
      for (const [name, text] of logFiles) {
        const line = text.split("\n").find(entry => pattern.test(entry));
        if (line) found.push(`${kind} in ${name}: ${line.replace(pattern, "<SECRET>").slice(0, 220)}`);
      }
    }
    results.check(`none of the ${secrets.length} secrets the suite handled appears in the accounts-api, account site or developer site log (${[...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ")})`, found.length === 0, found.slice(0, 5).join(" | ") || `${secrets.length} secrets, 0 found`);

    // 2. Anything shaped like a secret.
    const shapes = secretShapes(JSON.parse(readFileSync(join(ROOT, "testkit/dev-credentials.json"), "utf8")) as Parameters<typeof secretShapes>[0]);
    const shaped: string[] = [];
    for (const [label, pattern] of shapes) {
      for (const [name, text] of logFiles) {
        const line = text.split("\n").find(entry => pattern.test(entry));
        if (line) shaped.push(`${label} in ${name}: ${line.replace(pattern, "<MATCH>").slice(0, 220)}`);
      }
    }
    results.check(`nothing shaped like a secret is in the logs (${shapes.length} shapes: prefixed tokens, webhook/app secrets, STKs, JWTs, Authorization headers, Google/Postmark/Twilio credentials, private keys)`, shaped.length === 0, shaped.slice(0, 5).join(" | ") || `${apiLog.length + webLog.length + developerLog.length} bytes scanned (${developerLogPath ? "with" : "WITHOUT"} the developer site's log)`);
    results.metric("log bytes scanned", apiLog.length + webLog.length + developerLog.length, "bytes");
    results.metric("secrets checked", secrets.length, "count");
  },
};

export const journeys: Journey[] = [atRest, logs];
