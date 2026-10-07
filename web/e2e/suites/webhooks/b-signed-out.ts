/**
 * membership.signed_out, for every reason an app's sign-in of a Carbon can end without the Carbon removing its access:
 * the app revokes it (refresh or access token), a used refresh token comes back (reuse detection revokes the family),
 * a used authorization code comes back (the tokens it gave are revoked). Each is told once, to that app only, with
 * {uuid, membership_id, reason}; the membership stays active, so the app keeps hearing about the account.
 * (stk_rotated, the Silicon reason, is in c-silicon-members.ts.)
 */
import type { Journey } from "../../context";
import { appCall, checkEq, envelopeProblems, inboxEvents, must, newCarbon, signIntoApp, storedEvents, uid, waitEvent } from "./_helpers";

const APP = "commit";

export const journey: Journey = {
  name: "webhooks-signed-out-reasons",
  title: "membership.signed_out reaches the app once per ended sign-in with the right reason: app_revoked (refresh and access token), refresh_token_reuse, authorization_code_reuse",
  timeoutMs: 4 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const expectSignedOut = async (label: string, uuid: string, reason: string, since: number, afterSeq: number) => {
      const event = await waitEvent(env, APP, { type: "membership.signed_out", uuid, after: afterSeq });
      results.check(`${label}: ${APP} received membership.signed_out with a valid signature`, !!event);
      if (event) {
        const problems = envelopeProblems(event.payload, { type: "membership.signed_out", app_id: APP, silicon: null });
        results.check(`${label}: the envelope is right`, problems.length === 0, problems.join("; "));
        checkEq(results, `${label}: data is {uuid, membership_id, reason: ${reason}}`, event.payload.data, { uuid, membership_id: `${APP}:${uuid}`, reason });
      }
      checkEq(results, `${label}: exactly one event, to ${APP} only`, (await storedEvents(env, { account: uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`), [`membership.signed_out→${APP}`]);
    };
    const seq = async () => (await inboxEvents(env, APP, { uuid: "none" })).last_seq;

    // ---- the app revokes with the refresh token --------------------------------------------------------------------
    {
      const carbon = await newCarbon(ctx, "revoke");
      const session = await signIntoApp(ctx, carbon, APP);
      const since = Date.now();
      const after = await seq();
      must("revoke the refresh token", await appCall(env, APP, "POST", "/v1/oauth/revoke", { form: { token: session.refreshToken } }), 200);
      await expectSignedOut("app_revoked (refresh token)", carbon.uuid, "app_revoked", since, after);
      const refresh = await appCall<{ error?: string }>(env, APP, "POST", "/v1/oauth/token", { form: { grant_type: "refresh_token", refresh_token: session.refreshToken } });
      results.check("app_revoked: the revoked refresh token no longer works (invalid_grant)", refresh.status === 400 && refresh.body.error === "invalid_grant", `${refresh.status} ${JSON.stringify(refresh.body).slice(0, 200)}`);
      const otherApp = await appCall(env, "briefcase", "POST", "/v1/oauth/revoke", { form: { token: session.refreshToken } });
      checkEq(results, "another app presenting this app's token revokes nothing and tells nobody", { status: otherApp.status, events: (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).length }, { status: 200, events: 1 });
    }

    // ---- the app revokes with an access token ----------------------------------------------------------------------
    {
      const carbon = await newCarbon(ctx, "revokeat");
      const session = await signIntoApp(ctx, carbon, APP);
      const since = Date.now();
      const after = await seq();
      must("revoke the access token", await appCall(env, APP, "POST", "/v1/oauth/revoke", { form: { token: session.accessToken } }), 200);
      await expectSignedOut("app_revoked (access token)", carbon.uuid, "app_revoked", since, after);
    }

    // ---- refresh token reuse ----------------------------------------------------------------------------------------------
    {
      const carbon = await newCarbon(ctx, "reuse");
      const session = await signIntoApp(ctx, carbon, APP);
      const rotated = must("refresh once", await appCall<{ refresh_token: string }>(env, APP, "POST", "/v1/oauth/token", { form: { grant_type: "refresh_token", refresh_token: session.refreshToken } }), 200).body;
      checkEq(results, "refresh_token_reuse: a normal refresh tells the app nothing", (await storedEvents(env, { account: carbon.uuid })).length, 0);
      const since = Date.now();
      const after = await seq();
      const reused = await appCall<{ error?: string; error_description?: string }>(env, APP, "POST", "/v1/oauth/token", { form: { grant_type: "refresh_token", refresh_token: session.refreshToken } });
      results.check("refresh_token_reuse: the used refresh token is refused (invalid_grant)", reused.status === 400 && reused.body.error === "invalid_grant", `${reused.status} ${reused.body.error_description ?? ""}`);
      await expectSignedOut("refresh_token_reuse", carbon.uuid, "refresh_token_reuse", since, after);
      const rotatedNow = await appCall<{ error?: string }>(env, APP, "POST", "/v1/oauth/token", { form: { grant_type: "refresh_token", refresh_token: rotated.refresh_token } });
      results.check("refresh_token_reuse: the whole family is revoked, the newest refresh token included", rotatedNow.status === 400 && rotatedNow.body.error === "invalid_grant", String(rotatedNow.status));
    }

    // ---- authorization code reuse ----------------------------------------------------------------------------------------
    {
      const carbon = await newCarbon(ctx, "codereuse");
      const session = await signIntoApp(ctx, carbon, APP);
      const since = Date.now();
      const after = await seq();
      const again = await appCall<{ error?: string }>(env, APP, "POST", "/v1/oauth/token", { form: { grant_type: "authorization_code", code: session.code, redirect_uri: session.redirectUri, code_verifier: session.codeVerifier } });
      results.check("authorization_code_reuse: the used code is refused (invalid_grant)", again.status === 400 && again.body.error === "invalid_grant", String(again.status));
      await expectSignedOut("authorization_code_reuse", carbon.uuid, "authorization_code_reuse", since, after);
      const refresh = await appCall<{ error?: string }>(env, APP, "POST", "/v1/oauth/token", { form: { grant_type: "refresh_token", refresh_token: session.refreshToken } });
      results.check("authorization_code_reuse: the tokens that code gave are revoked", refresh.status === 400 && refresh.body.error === "invalid_grant", String(refresh.status));
      // Signed out, not removed: the membership is active and the app still hears of changes.
      const since2 = Date.now();
      must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH Out ${uid()}` } }), 200);
      checkEq(results, "after a sign-out the membership is still active: the app still gets account.updated", (await storedEvents(env, { account: carbon.uuid, type: "account.updated", afterMs: since2 - 1 })).map(row => row.target_id), [APP]);
    }
  },
};
