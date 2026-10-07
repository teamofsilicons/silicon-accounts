/**
 * The service never logs secrets. Runs last in the suite: it makes a fresh set of secrets of every kind (codes, wrong
 * codes, STKs, wrong STKs, session/flow/sign-up cookies, access/refresh/id tokens, authorization codes, SLTs, request
 * polling tokens, webhook secrets, app secrets sent with Basic auth) and adds every secret the suite's other journeys
 * handled, then scans the stack's own accounts-api and site logs for any of them, and for anything shaped like a
 * secret (prefixed tokens, STKs, JWTs, Authorization headers, provider and messaging credentials).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { codeFor, lastSeq, sleep, tag } from "../../lib";
import { ROOT, appCredentials, appTokens, base64url, call, callbackOf, createSilicon, flowOf, flowStep, remember, remembered, siliconLogin, stackLog, startFlow, viaSite, Jar } from "./_helpers";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const journey: Journey = {
  name: "security-logs",
  title: "no secret in the logs: after making every kind of secret (and the ones the suite's other journeys handled), the stack's accounts-api and site logs contain none of them and nothing shaped like one (prefixed tokens, STKs, JWTs, Authorization headers, provider credentials)",
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
      for (const [name, text] of [["accounts-api.log", apiLog], ["web.log", webLog]] as const) {
        const line = text.split("\n").find(entry => pattern.test(entry));
        if (line) found.push(`${kind} in ${name}: ${line.replace(pattern, "<SECRET>").slice(0, 220)}`);
      }
    }
    results.check(`none of the ${secrets.length} secrets the suite handled appears in the accounts-api or site log (${[...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ")})`, found.length === 0, found.slice(0, 5).join(" | ") || `${secrets.length} secrets, 0 found`);

    // 2. Anything shaped like a secret.
    const credentials = JSON.parse(readFileSync(join(ROOT, "testkit/dev-credentials.json"), "utf8")) as { managed: { google: { client_secret: string } }; messaging: { postmark: { server_token: string }; twilio: { auth_token: string } } };
    const shapes: Array<[string, RegExp]> = [
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
    const shaped: string[] = [];
    for (const [label, pattern] of shapes) {
      for (const [name, text] of [["accounts-api.log", apiLog], ["web.log", webLog]] as const) {
        const line = text.split("\n").find(entry => pattern.test(entry));
        if (line) shaped.push(`${label} in ${name}: ${line.replace(pattern, "<MATCH>").slice(0, 220)}`);
      }
    }
    results.check(`nothing shaped like a secret is in the logs (${shapes.length} shapes: prefixed tokens, webhook/app secrets, STKs, JWTs, Authorization headers, Google/Postmark/Twilio credentials, private keys)`, shaped.length === 0, shaped.slice(0, 5).join(" | ") || `${apiLog.length + webLog.length} bytes scanned`);
    results.metric("log bytes scanned", apiLog.length + webLog.length, "bytes");
    results.metric("secrets checked", secrets.length, "count");
  },
};
