/**
 * Error bodies never echo a secret: wrong or unknown codes (hosted flow, CLI, adding an email, a v2 details page), STKs,
 * the developer platform's code, verifier and refresh token, the developer site's session cookie and callback, authorization
 * codes, refresh tokens (also on reuse), SLTs, device codes, PKCE verifiers, app secrets (Basic and body), request
 * polling tokens, proof tokens and Bearer tokens all come back without the value that was sent, and never with the
 * right one. Reads never return stored secrets either: app details show `secret_set` flags, not the webhook secret or a
 * bring-your-own Google secret, and account views never carry an STK or its hash.
 */
import { randomBytes } from "node:crypto";
import type { Journey } from "../../context";
import { codeFor, lastSeq, tag } from "../../lib";
import { appCredentials, appTokens, base64url, brief, call, continueInto, createSilicon, flowOf, flowStep, publicToken, randomPhone, remember, siliconLogin, signInWithEmail, startFlow, token, viaSite, callbackOf, Jar, type Reply } from "./_helpers";

const rand = (prefix: string) => `${prefix}${base64url(randomBytes(32))}`;

export const journey: Journey = {
  name: "security-secrets",
  title: "no secret in any answer: wrong/unknown codes (also a details page's), STKs (also self-chosen ones, refused or accepted), auth codes (also the developer platform's), refresh tokens (also reused), SLTs, device codes, verifiers, app secrets, polling and proof tokens, Bearer tokens and the developer site's cookies are never echoed (nor the right values); app, proof and account reads show secret_set flags, never secrets, proof tokens, STKs or hashes",
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    const t = viaSite(ctx);
    const echoed: string[] = [];
    let probes = 0;
    /** Records a probe: `reply` must not contain any of `secrets` (the value sent, and the right one when known). */
    const probe = (label: string, reply: Reply, ...secrets: Array<string | null | undefined>) => {
      probes++;
      for (const secret of secrets) {
        if (!secret || secret.length < 6) continue;
        const core = secret.replace(/^(stk-|sa[a-z]*_|slt_|whsec_|sa_app_[a-z-]+_)/, "");
        if (reply.text.includes(secret) || (core.length >= 6 && reply.text.includes(core))) echoed.push(`${label}: ${reply.status} body contains ${secret.slice(0, 6)}…`);
      }
      if (reply.status < 400) echoed.push(`${label}: expected a refusal, got ${brief(reply)}`);
    };

    // A Carbon signed up through briefcase (its tokens), with a Silicon.
    const { tokens, carbon } = await appTokens(t, "briefcase", { label: "secrets" });
    remember(ctx, "code", carbon.code, carbon.authCode);
    remember(ctx, "access token", tokens.access_token);
    remember(ctx, "refresh token", tokens.refresh_token);
    remember(ctx, "session cookie", carbon.jar.get("sa_session"));
    const silicon = await createSilicon(t, carbon.jar, "secrets");
    remember(ctx, "stk", silicon.stk);

    // 1. Codes: a hosted flow, the CLI's code sign-in, adding an email.
    const flowJar = new Jar();
    const flow = flowOf(await startFlow(t, flowJar, { app_id: "briefcase", redirect_uri: callbackOf(env, "briefcase"), state: `s-${tag()}`, prompt: "login" }));
    let after = await lastSeq(env);
    await flowStep(t, flowJar, flow?.id ?? "", "email", { email: carbon.email });
    const realFlowCode = await codeFor(env, carbon.email, after);
    remember(ctx, "code", realFlowCode);
    const wrongFlowCode = realFlowCode === "314159" ? "271828" : "314159";
    probe("hosted flow: a wrong code", await flowStep(t, flowJar, flow?.id ?? "", "verify", { code: wrongFlowCode }), wrongFlowCode, realFlowCode);
    const view = await call(`${env.site}/v1/flows/${flow?.id}`, { jar: flowJar, ip: ctx.ip });
    results.check("the flow view after a code was sent never contains the code", view.status === 200 && !view.text.includes(realFlowCode), `${view.status}, ${view.text.length} bytes`);

    after = await lastSeq(env);
    const cliStart = await call<{ challenge_id?: string }>(`${env.site}/v1/cli/login/start`, { json: { email: carbon.email }, ip: ctx.ip });
    const realCliCode = await codeFor(env, carbon.email, after);
    remember(ctx, "code", realCliCode);
    const wrongCliCode = realCliCode === "112358" ? "132134" : "112358";
    probe("CLI code sign-in: a wrong code", await call(`${env.site}/v1/cli/login/verify`, { json: { challenge_id: cliStart.body.challenge_id, code: wrongCliCode }, ip: ctx.ip }), wrongCliCode, realCliCode);

    const extra = `sec.secrets.extra.${tag()}@example.test`;
    after = await lastSeq(env);
    const added = await call<{ challenge_id?: string }>(`${env.site}/v1/me/emails`, { json: { email: extra }, jar: carbon.jar, origin: env.site, ip: ctx.ip });
    const realAddCode = await codeFor(env, extra, after);
    remember(ctx, "code", realAddCode);
    const wrongAddCode = realAddCode === "999111" ? "111999" : "999111";
    probe("adding an email: a wrong code", await call(`${env.site}/v1/me/emails/verify`, { json: { challenge_id: added.body.challenge_id, code: wrongAddCode }, jar: carbon.jar, origin: env.site, ip: ctx.ip }), wrongAddCode, realAddCode);

    // 2. STKs and request polling tokens.
    const wrongStk = `stk-${randomBytes(6).toString("hex")}`;
    probe("Silicon sign-in: a wrong STK", await siliconLogin(t, silicon.id, wrongStk), wrongStk, silicon.stk);
    const longStk = `stk-${randomBytes(16).toString("hex")}`;
    probe("Silicon sign-in: an unknown si:id with a 32-hex STK", await siliconLogin(t, `si:nobody-${tag()}`, longStk), longStk);
    // A self-chosen STK (the Silicon's own password, 8 to 32 hex): refused for its shape or with the rest of the request.
    const tooLong = `stk-${randomBytes(17).toString("hex")}`;
    const notHex = `stk-${randomBytes(8).toString("hex")}zz`;
    const chosen = `stk-${randomBytes(16).toString("hex")}`;
    const custodianCreate = (stk: string, id = `si:chosen-${tag()}${tag()}`.slice(0, 33)) => call(`${env.site}/v1/me/silicons`, { json: { id, display_name: "Chosen", stk }, jar: carbon.jar, origin: env.site, ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}${tag()}` } });
    probe("a self-chosen STK with 34 hex digits", await custodianCreate(tooLong), tooLong);
    probe("a self-chosen STK that isn't hex", await custodianCreate(notHex), notHex);
    probe("a valid self-chosen STK with an si:id that is taken", await custodianCreate(chosen, silicon.id), chosen);
    probe("a self-created Silicon's chosen STK with a custodian that doesn't exist", await call(`${env.site}/v1/silicons`, { json: { id: `si:chosen-${tag()}${tag()}`.slice(0, 33), display_name: "Chosen", custodian: `c:nobody-${tag()}${tag()}`, stk: chosen }, ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } }), chosen);
    const chosenId = `si:chosen-${tag()}${tag()}`.slice(0, 33);
    const acceptedChosen = await custodianCreate(chosen, chosenId);
    remember(ctx, "stk", chosen, tooLong, notHex);
    const chosenLogin = await siliconLogin(t, chosenId, chosen);
    remember(ctx, "access token", chosenLogin.body.access_token);
    remember(ctx, "refresh token", chosenLogin.body.refresh_token);
    results.check("a Silicon created with its own STK gets an answer that never repeats it (stk null), and that STK signs it in", acceptedChosen.status === 201 && (acceptedChosen.body as { stk?: string | null }).stk == null && !acceptedChosen.text.includes(chosen.slice(4)) && chosenLogin.status === 200, `create ${brief(acceptedChosen)} stk=${JSON.stringify((acceptedChosen.body as { stk?: string | null }).stk)}; login ${chosenLogin.status}`);
    const pending = await call<{ request?: { id: string }; request_token?: string; stk?: string }>(`${env.site}/v1/silicons`, { json: { id: `si:secrets-${tag()}${tag()}`.slice(0, 33), display_name: "Secrets", custodian: carbon.id }, ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
    remember(ctx, "request token", pending.body.request_token);
    remember(ctx, "stk", pending.body.stk);
    const wrongPoll = rand("sarq_");
    probe("request polling with a wrong token", await call(`${env.site}/v1/silicons/requests/${pending.body.request?.id}`, { bearer: wrongPoll, ip: ctx.ip }), wrongPoll, pending.body.request_token);

    // 3. The token endpoint.
    const creds = appCredentials("briefcase");
    const unknownCode = rand("sac_");
    probe("token: an unknown authorization code", await token(t, { grant_type: "authorization_code", code: unknownCode, redirect_uri: callbackOf(env, "briefcase") }, creds), unknownCode);
    const unknownRefresh = rand("sar_");
    probe("token: an unknown refresh token", await token(t, { grant_type: "refresh_token", refresh_token: unknownRefresh }, creds), unknownRefresh);
    const rotated = await token(t, { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, creds);
    remember(ctx, "refresh token", rotated.body.refresh_token);
    remember(ctx, "access token", rotated.body.access_token);
    probe("token: a refresh token used twice (reuse detection)", await token(t, { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, creds), tokens.refresh_token, rotated.body.refresh_token);
    const unknownSlt = rand("slt_");
    probe("token: an unknown SLT", await token(t, { grant_type: "urn:silicon:params:oauth:grant-type:slt", slt: unknownSlt }, creds), unknownSlt);
    const unknownDevice = rand("sad_");
    probe("token: an unknown device code", await call(`${env.site}/v1/oauth/token`, { form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: unknownDevice, client_id: "silicon-accounts" }, ip: ctx.ip }), unknownDevice);
    const wrongSecret = `sa_app_briefcase_${base64url(randomBytes(30))}`;
    probe("token: a wrong app secret (Basic)", await token(t, { grant_type: "refresh_token", refresh_token: unknownRefresh }, ["briefcase", wrongSecret]), wrongSecret, creds[1]);
    probe("token: a wrong app secret (body)", await call(`${env.site}/v1/oauth/token`, { form: { grant_type: "refresh_token", refresh_token: unknownRefresh, client_id: "briefcase", client_secret: wrongSecret }, ip: ctx.ip }), wrongSecret, creds[1]);
    const second = await signInWithEmail(t, { email: carbon.email, appId: "briefcase", jar: carbon.jar.clone() });
    remember(ctx, "code", second.code, second.authCode);
    const wrongVerifier = base64url(randomBytes(32));
    probe("token: a wrong PKCE verifier", await token(t, { grant_type: "authorization_code", code: second.authCode ?? "", redirect_uri: callbackOf(env, "briefcase"), code_verifier: wrongVerifier }, creds), wrongVerifier, second.verifier, second.authCode);

    // 4. App credentials, proofs and Bearer tokens elsewhere.
    probe("app API: a wrong app secret", await call(`${env.site}/v1/apps/briefcase`, { basic: ["briefcase", wrongSecret], ip: ctx.ip }), wrongSecret, creds[1]);
    const garbageProof = rand("sap_");
    const verified = await call(`${env.site}/v1/proofs/verify`, { json: { proof_token: garbageProof }, basic: appCredentials("remind"), ip: ctx.ip });
    results.check("verifying an unknown proof token answers exactly {valid:false, expires_at:null} (nothing echoed)", verified.status === 200 && !verified.text.includes(garbageProof) && JSON.stringify(Object.entries(verified.body as object).sort()) === JSON.stringify([["expires_at", null], ["valid", false]]), verified.text.slice(0, 100));
    const unknownProofRefresh = rand("sapr_");
    probe("proof refresh with an unknown refresh token", await call(`${env.site}/v1/proofs/refresh`, { json: { proof_refresh_token: unknownProofRefresh }, basic: appCredentials("commit"), ip: ctx.ip }), unknownProofRefresh);
    const fakeJwt = `eyJhbGciOiJFZERTQSJ9.${base64url(Buffer.from(JSON.stringify({ sub: "x", aud: "silicon-accounts" })))}.${base64url(randomBytes(64))}`;
    probe("Bearer: a made-up JWT", await call(`${env.site}/v1/me`, { bearer: fakeJwt, ip: ctx.ip }), fakeJwt);
    probe("Bearer: briefcase's refresh token on /v1/me", await call(`${env.site}/v1/me`, { bearer: rotated.body.refresh_token ?? unknownRefresh, ip: ctx.ip }), rotated.body.refresh_token);
    const madeUpSession = rand("sas_");
    probe("a made-up session cookie", await call(`${env.site}/v1/me`, { headers: { cookie: `sa_session=${madeUpSession}` }, ip: ctx.ip }), madeUpSession);
    // v2: a wrong code on an app's details page (adding a missing phone), the developer platform's code exchange, and
    //     the developer site's BFF.
    const crmJar = carbon.jar.clone();
    let crm = flowOf(await startFlow(t, crmJar, { app_id: "legacy-crm", redirect_uri: callbackOf(env, "legacy-crm"), state: `crm-${tag()}` }));
    crm = flowOf(await flowStep(t, crmJar, crm?.id ?? "", "continue")) ?? crm;
    const detailPhone = randomPhone();
    after = await lastSeq(env);
    const detailAdded = await flowStep(t, crmJar, crm?.id ?? "", "details/add", { phone: detailPhone });
    const realDetailCode = await codeFor(env, detailPhone, after);
    remember(ctx, "code", realDetailCode);
    results.check("the details page's view after a code was sent to a missing phone never contains the code", detailAdded.status === 200 && !!flowOf(detailAdded)?.details?.challenge && !detailAdded.text.includes(realDetailCode), `${detailAdded.status}, challenge ${JSON.stringify(flowOf(detailAdded)?.details?.challenge ?? null).slice(0, 120)}`);
    const wrongDetailCode = realDetailCode === "135790" ? "246802" : "135790";
    probe("details page: a wrong code for a missing phone", await flowStep(t, crmJar, crm?.id ?? "", "details/verify", { code: wrongDetailCode }), wrongDetailCode, realDetailCode);
    const devFlow = await continueInto(t, carbon.jar, "developer");
    remember(ctx, "code", devFlow.code);
    const wrongDevVerifier = base64url(randomBytes(32));
    probe("developer platform: its code with a wrong PKCE verifier", await publicToken(t, "developer", { grant_type: "authorization_code", code: devFlow.code, redirect_uri: devFlow.redirect, code_verifier: wrongDevVerifier }), devFlow.code, wrongDevVerifier, devFlow.verifier);
    const devGarbage = rand("sar_");
    probe("developer platform: an unknown refresh token", await publicToken(t, "developer", { grant_type: "refresh_token", refresh_token: devGarbage }), devGarbage);
    const forgedSeal = `v1.${base64url(randomBytes(90))}`;
    probe("developer site: a forged session cookie", await call(`${env.developer}/api/accounts/apps/briefcase`, { headers: { cookie: `sa_dev_session=${forgedSeal}` }, ip: ctx.ip }), forgedSeal);
    probe("developer site: a callback with a made-up code and state", await call(`${env.developer}/auth/callback?code=${devGarbage.replace("sar_", "sac_")}&state=${tag()}${tag()}`, { ip: ctx.ip }).then(reply => ({ ...reply, status: reply.status === 303 ? 400 : reply.status, text: `${reply.text} ${reply.headers.get("location") ?? ""}` })), devGarbage.replace("sar_", "sac_"));
    results.check(`${probes} refusals echo neither the secret that was sent nor the right one (codes ×3, STKs ×2, chosen STKs ×4, polling token, auth code, refresh ×2, SLT, device code, app secret ×3, verifier, proof refresh, Bearer ×2, session cookie; v2: a details page's code, the developer platform's code, verifier and refresh token, the developer site's session cookie and callback)`, echoed.length === 0, echoed.join(" | ") || `${probes} probes`);

    // 5. An idempotent replay is only ever for the same caller: another account (or network) re-sending the same
    //    Idempotency-Key and body never gets the first caller's answer, which carries a freshly made STK.
    const key = `sec-idem-${tag()}${tag()}`;
    const siliconBody = { id: `si:idem-${tag()}${tag()}`.slice(0, 33), display_name: "Idempotent" };
    const original = await call<{ stk?: string }>(`${env.site}/v1/me/silicons`, { json: siliconBody, jar: carbon.jar, origin: env.site, ip: ctx.ip, headers: { "idempotency-key": key } });
    remember(ctx, "stk", original.body.stk);
    const replaySame = await call<{ stk?: string }>(`${env.site}/v1/me/silicons`, { json: siliconBody, jar: carbon.jar, origin: env.site, ip: ctx.ip, headers: { "idempotency-key": key } });
    const other = await signInWithEmail(t, { label: "idem" });
    remember(ctx, "session cookie", other.jar.get("sa_session"));
    const replayOther = await call<{ stk?: string }>(`${env.site}/v1/me/silicons`, { json: siliconBody, jar: other.jar, origin: env.site, ip: ctx.ip, headers: { "idempotency-key": key } });
    results.check("POST /v1/me/silicons replays its answer (with the new STK) to the same Carbon only: another Carbon sending the same Idempotency-Key and body gets its own answer, never the STK", original.status === 201 && replaySame.headers.get("idempotent-replayed") === "true" && replaySame.body.stk === original.body.stk && !replayOther.text.includes(original.body.stk ?? "~") && replayOther.headers.get("idempotent-replayed") !== "true", `first ${original.status}; same Carbon ${replaySame.status} replayed=${replaySame.headers.get("idempotent-replayed")}; other Carbon ${brief(replayOther)}`);
    const anonKey = `sec-idem-${tag()}${tag()}`;
    const anonBody = { id: `si:idem-${tag()}${tag()}`.slice(0, 33), display_name: "Anonymous", custodian: carbon.id };
    const firstIp = `10.77.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    const anon = await call<{ stk?: string; request_token?: string }>(`${env.site}/v1/silicons`, { json: anonBody, ip: firstIp, headers: { "idempotency-key": anonKey } });
    remember(ctx, "stk", anon.body.stk);
    remember(ctx, "request token", anon.body.request_token);
    const anonOther = await call<{ stk?: string; request_token?: string }>(`${env.site}/v1/silicons`, { json: anonBody, ip: `10.78.${Math.floor(Math.random() * 250)}.9`, headers: { "idempotency-key": anonKey } });
    results.check("a self-created Silicon's answer (STK + request polling token) is never replayed to another network sending the same Idempotency-Key and body", anon.status === 201 && !anonOther.text.includes(anon.body.stk ?? "~") && !anonOther.text.includes(anon.body.request_token ?? "~"), `first ${anon.status}; other network ${brief(anonOther)}`);

    // 6. Reads never return stored secrets.
    const hook = await call<{ secret?: string }>(`${env.site}/v1/apps/spacestation/webhook`, { method: "PUT", json: { url: `${env.apps}/spacestation/webhooks` }, basic: appCredentials("spacestation"), ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
    remember(ctx, "webhook secret", hook.body.secret);
    const appRead = await call<{ webhook?: { secret_set?: boolean } }>(`${env.site}/v1/apps/spacestation`, { basic: appCredentials("spacestation"), ip: ctx.ip });
    const deliveries = await call(`${env.site}/v1/apps/spacestation/webhook/deliveries`, { basic: appCredentials("spacestation"), ip: ctx.ip });
    await call(`${env.site}/v1/apps/spacestation/webhook`, { method: "DELETE", basic: appCredentials("spacestation"), ip: ctx.ip });
    results.check("a webhook secret is shown once when set (whsec_…), and the app's details and deliveries show only secret_set", (hook.body.secret ?? "").startsWith("whsec_") && appRead.body.webhook?.secret_set === true && !appRead.text.includes(hook.body.secret ?? "~") && !/whsec_/.test(appRead.text) && !/whsec_/.test(deliveries.text), `set ${hook.status}; details ${appRead.status} secret_set=${appRead.body.webhook?.secret_set}; deliveries ${deliveries.status}`);
    const acme = await call(`${env.site}/v1/apps/acme-notes`, { basic: appCredentials("acme-notes"), ip: ctx.ip });
    const config = await call(`${env.site}/v1/apps/acme-notes/signin-config/history`, { basic: appCredentials("acme-notes"), ip: ctx.ip });
    results.check("a bring-your-own Google secret never comes back (acme-notes' details and config history show client_secret_set, not GOCSPX-…)", acme.status === 200 && !/GOCSPX-|-----BEGIN/.test(acme.text) && /client_secret_set/.test(acme.text) && !/GOCSPX-|-----BEGIN/.test(config.text), `details ${acme.status}, history ${config.status}`);
    // Proofs: the token and the refresh token are shown once, when issued; listings never carry them.
    const issued = await call<{ proof_id?: string; proof_token?: string; proof_refresh_token?: string }>(`${env.site}/v1/proofs/app-verification`, { json: { receiving_app: "remind" }, basic: appCredentials("commit"), ip: ctx.ip, headers: { "idempotency-key": `sec-${tag()}` } });
    remember(ctx, "proof token", issued.body.proof_token, issued.body.proof_refresh_token);
    const listed = await call(`${env.site}/v1/apps/commit/proofs?limit=100`, { basic: appCredentials("commit"), ip: ctx.ip });
    results.check("an app verification proof's token and refresh token come back once, when it is made, and the app's proof listing never carries any proof token (sap_/sapr_)", issued.status === 201 && (issued.body.proof_token ?? "").startsWith("sap_") && listed.status === 200 && listed.text.includes(issued.body.proof_id ?? "~") && !/\bsapr?_[A-Za-z0-9_-]{20,}/.test(listed.text), `issued ${issued.status}; listing ${listed.status}, ${listed.text.length} bytes`);
    const meCarbon = await call(`${env.site}/v1/me/silicons`, { jar: carbon.jar, ip: ctx.ip });
    const login = await siliconLogin(t, silicon.id, silicon.stk);
    remember(ctx, "access token", login.body.access_token);
    remember(ctx, "refresh token", login.body.refresh_token);
    const meSilicon = await call(`${env.site}/v1/me`, { bearer: login.body.access_token, ip: ctx.ip });
    const leaks = [meCarbon, meSilicon].filter(reply => reply.text.includes(silicon.stk) || /\$argon2|stk_hash|"stk"\s*:\s*"stk-/.test(reply.text));
    results.check("neither the custodian's Silicon list nor the Silicon's own /v1/me carries its STK or an STK hash", meCarbon.status === 200 && meSilicon.status === 200 && leaks.length === 0, `${meCarbon.status}/${meSilicon.status}; ${leaks.length} leaks`);
  },
};
