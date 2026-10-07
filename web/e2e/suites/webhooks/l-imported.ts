/**
 * Imported members (02-api: id changes go "to every member app (status active or imported)"): an app imports its old
 * users (legacy-crm), one of them already has an account, so the import matches it with a membership in status
 * imported and no granted scopes. Importing sends nothing; later changes reach the app with only what any app may see
 * (profile: name, photo, id), never the email the app imported by. If the Carbon removes the app's access, a new
 * import does not bring the app's webhooks back.
 *
 * And the other way round (UNDERSTANDING.md "The app's user base": a new Carbon account is created for an imported user
 * without one, "and they finish setting it up the first time they sign in"): the Carbon finishes the account on the
 * app's own hosted pages, choosing another id and name than the import's, and the importing app hears both
 * (account.id_changed, account.updated) before its details page; once signed in, the membership is active and the app
 * hears what it was granted.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Ctx, Journey } from "../../context";
import { codeFor, lastSeq, sleep } from "../../lib";
import { type FlowView, Visitor, appCall, b64url, checkEq, inboxEvents, must, newCarbon, sameJson, sha256, short, storedEvents, uid, waitEvent } from "./_helpers";

const APP = "legacy-crm";
const BASE_KEYS = ["display_name", "id", "kind", "membership_id", "pfp_url", "updated_at", "uuid", "version"];

interface Job {
  id: string;
  status: string;
  counts?: Record<string, number>;
}

async function importRows(ctx: Ctx, rows: Array<Record<string, unknown>>): Promise<{ job: Job; outcomes: Array<{ outcome: string; account_uuid: string | null; id?: string | null }> }> {
  const started = must("start the import", await appCall<{ job: Job }>(ctx.env, APP, "POST", `/v1/apps/${APP}/imports`, { json: { rows, options: {} }, idempotencyKey: randomUUID() }), [200, 201, 202]).body.job;
  let job = started;
  for (let i = 0; i < 120 && job.status !== "completed" && job.status !== "failed"; i++) {
    await sleep(250);
    const answer = must("the import job", await appCall<{ job?: Job } & Job>(ctx.env, APP, "GET", `/v1/apps/${APP}/imports/${started.id}`), 200).body;
    job = answer.job ?? answer;
  }
  const outcomes = must("the import rows", await appCall<{ items: Array<{ outcome: string; account_uuid: string | null; id?: string | null }> }>(ctx.env, APP, "GET", `/v1/apps/${APP}/imports/${started.id}/rows?limit=50`), 200).body.items;
  return { job, outcomes };
}

const matchedJourney: Journey = {
  name: "webhooks-imported-members",
  title: "an app that imported an existing Carbon (membership imported) hears of id and name changes with profile fields only, nothing on import, nothing about the email; after the Carbon removes its access a re-import does not bring the webhooks back",
  timeoutMs: 4 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await newCarbon(ctx, "imported");
    let since = Date.now();
    const first = await importRows(ctx, [{ email: carbon.email, external_id: `crm-${uid()}`, display_name: "From the CRM" }]);
    checkEq(results, "the import matched the existing account", { status: first.job.status, outcomes: first.outcomes.map(row => [row.outcome, row.account_uuid]) }, { status: "completed", outcomes: [["matched", carbon.uuid]] });
    const user = must("the app's user", await appCall<{ status?: string; membership_id?: string }>(env, APP, "GET", `/v1/apps/${APP}/users/${carbon.uuid}`), 200).body;
    results.check("the membership is imported (not active: the Carbon never signed in to the app)", user.status === "imported" && user.membership_id === `${APP}:${carbon.uuid}`, short(user, 300));
    checkEq(results, "importing sends the app no webhook", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).length, 0);

    // ---- an id change reaches the importing app ------------------------------------------------------------------------
    let after = (await inboxEvents(env, APP, { uuid: "none" })).last_seq;
    since = Date.now();
    const newId = `c:wh-imported2-${uid()}`;
    must("change the id", await carbon.visitor.call("POST", "/v1/me/id", { json: { id: newId } }), 200);
    checkEq(results, "id change: account.id_changed goes to the app with the imported membership", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`), [`account.id_changed→${APP}`]);
    const idEvent = await waitEvent(env, APP, { type: "account.id_changed", uuid: carbon.uuid, after });
    checkEq(results, "id change: the app received {uuid, membership_id, kind, old_id, new_id}", idEvent?.payload.data, { uuid: carbon.uuid, membership_id: `${APP}:${carbon.uuid}`, kind: "carbon", old_id: carbon.id, new_id: newId });

    // ---- profile fields only -------------------------------------------------------------------------------------------
    after = (await inboxEvents(env, APP, { uuid: "none" })).last_seq;
    const name = `WH Imported ${uid()}`;
    must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: name } }), 200);
    const updated = await waitEvent(env, APP, { type: "account.updated", uuid: carbon.uuid, after });
    const data = updated?.payload.data as { changed?: string[]; account?: Record<string, unknown> } | undefined;
    checkEq(results, "rename: the app hears changed [display_name] and sees only the profile fields (no email although it imported by email)", { changed: data?.changed, keys: Object.keys(data?.account ?? {}).sort(), name: data?.account?.display_name }, { changed: ["display_name"], keys: BASE_KEYS, name });
    const email2 = `wh.imported2+${uid()}@example.test`;
    const seq = await lastSeq(env);
    const challenge = must("add an email", await carbon.visitor.call<{ challenge_id: string }>("POST", "/v1/me/emails", { json: { email: email2 } }), [200, 201]).body;
    must("verify it", await carbon.visitor.call("POST", "/v1/me/emails/verify", { json: { challenge_id: challenge.challenge_id, code: await codeFor(env, email2, seq) } }), 200);
    since = Date.now();
    must("make it primary", await carbon.visitor.call("POST", `/v1/me/emails/${encodeURIComponent(email2)}/primary`), 200);
    checkEq(results, "a new primary email is not sent to an app that was never granted email", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => row.target_id), []);

    // ---- access removed: a re-import does not bring the webhooks back ----------------------------------------------------
    since = Date.now();
    must("remove the app's access", await carbon.visitor.call("DELETE", `/v1/me/apps/${APP}`), [200, 204]);
    checkEq(results, "removing an imported app's access tells it (membership.access_removed)", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`), [`membership.access_removed→${APP}`]);
    const second = await importRows(ctx, [{ email: carbon.email, external_id: `crm-${uid()}` }]);
    const status = must("the app's user", await appCall<{ status?: string }>(env, APP, "GET", `/v1/apps/${APP}/users/${carbon.uuid}`), [200, 404]).body.status ?? "gone";
    results.check("a re-import leaves the membership access_removed", second.job.status === "completed" && status === "access_removed", `${second.job.status}, ${status}, ${short(second.outcomes)}`);
    since = Date.now();
    must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: `${name} again` } }), 200);
    checkEq(results, "after the re-import, changes still don't reach the app", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => row.target_id), []);
  },
};

const finishJourney: Journey = {
  name: "webhooks-imported-finish",
  title: "an imported Carbon finishing their account on the importing app's hosted pages with their own id and name: the app hears account.id_changed and account.updated (profile only), then signs them in with an active membership and hears what it was granted",
  timeoutMs: 4 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const email = `wh.finish+${uid()}@example.test`;
    let since = Date.now();
    const imported = await importRows(ctx, [{ email, external_id: `crm-${uid()}`, display_name: "From the CRM" }]);
    const row = imported.outcomes[0];
    const uuid = row?.account_uuid ?? "";
    const importedId = row?.id ?? "";
    results.check("the import created a new Carbon account for an address nobody has (outcome created, a c:id)", imported.job.status === "completed" && row?.outcome === "created" && !!uuid && /^c:/.test(importedId), short(imported.outcomes));
    checkEq(results, "creating an imported account sends the app no webhook", (await storedEvents(env, { account: uuid, afterMs: since - 1 })).length, 0);

    // ---- the Carbon signs in to legacy-crm for the first time: the sign-up page finishes the imported account ------------
    const visitor = new Visitor(env);
    const redirectUri = `${env.apps}/${APP}/callback`;
    const codeVerifier = b64url(randomBytes(32));
    const step = async (what: string, path: string, json?: unknown) => must(what, await visitor.call<{ flow: FlowView & { signup?: { finishing_import?: boolean; id?: string; imported_by?: { app_id?: string } | null } | null } }>("POST", path, json === undefined ? {} : { json })).body.flow;
    let flow = await step(`create ${APP}'s flow`, "/v1/flows", { app_id: APP, redirect_uri: redirectUri, state: b64url(randomBytes(12)), code_challenge: b64url(sha256(codeVerifier)), code_challenge_method: "S256", timezone: "Asia/Kolkata" });
    const seq = await lastSeq(env);
    await step("send the code", `/v1/flows/${flow.id}/email`, { email });
    flow = await step("verify the code", `/v1/flows/${flow.id}/verify`, { code: await codeFor(env, email, seq) });
    results.check("the code leads to the sign-up page finishing the imported account (finishing_import, imported by legacy-crm, the import's id prefilled)", flow.step === "signup" && flow.signup?.finishing_import === true && flow.signup?.imported_by?.app_id === APP && flow.signup?.id === importedId, short(flow.signup, 300));
    const chosenId = `c:wh-finished-${uid()}`;
    const chosenName = `WH Finished ${uid()}`;
    since = Date.now();
    flow = await step("finish setup with another id and name", `/v1/flows/${flow.id}/signup`, { id: chosenId, display_name: chosenName });
    const atSignup = await storedEvents(env, { account: uuid, afterMs: since - 1 });
    checkEq(results, "finishing setup tells the importing app (its membership is imported): account.id_changed and account.updated", atSignup.map(item => `${item.type}→${item.target_id}`).sort(), [`account.id_changed→${APP}`, `account.updated→${APP}`]);
    const idEvent = await waitEvent(env, APP, { type: "account.id_changed", uuid });
    checkEq(results, "legacy-crm received account.id_changed (signed) from the import's id to the chosen one", idEvent?.payload.data, { uuid, membership_id: `${APP}:${uuid}`, kind: "carbon", old_id: importedId, new_id: chosenId });
    const updated = await waitEvent(env, APP, { type: "account.updated", uuid });
    const data = updated?.payload.data as { changed?: string[]; account?: Record<string, unknown> } | undefined;
    results.check("legacy-crm received account.updated with the chosen name and only profile fields (nothing granted yet: no email, timezone or date of birth)", !!data && (data.changed ?? []).includes("display_name") && (data.changed ?? []).every(field => field === "display_name" || field === "pfp_url") && data.account?.display_name === chosenName && data.account?.id === chosenId && sameJson(Object.keys(data.account ?? {}).sort(), BASE_KEYS), short(data, 400));

    // ---- then the app's details page, and the sign-in completes --------------------------------------------------------
    for (let guard = 0; guard < 6 && flow.step !== "complete"; guard++) {
      if (flow.step === "details") flow = await step("continue on legacy-crm's details page", `/v1/flows/${flow.id}/details/continue`, { share: [] });
      else if (flow.step === "review") flow = await step("approve the review", `/v1/flows/${flow.id}/review`, { approve: true });
      else throw new Error(`${APP}'s flow stopped at ${flow.step} ${short(flow.error)}`);
    }
    const code = flow.redirect_to ? new URL(flow.redirect_to).searchParams.get("code") : null;
    if (!code) throw new Error(`${APP}'s flow ended without a code: ${flow.redirect_to}`);
    const tokens = must(`${APP} exchanges the code`, await appCall<{ scope: string }>(env, APP, "POST", "/v1/oauth/token", { form: { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier } }), 200).body;
    const user = must("the app's user", await appCall<{ status?: string }>(env, APP, "GET", `/v1/apps/${APP}/users/${uuid}`), 200).body;
    checkEq(results, "signed in: the membership is active, granted profile + email (its required detail)", { status: user.status, scopes: tokens.scope.split(" ").sort() }, { status: "active", scopes: ["email", "profile"] });
    const after = (await inboxEvents(env, APP, { uuid: "none" })).last_seq;
    const email2 = `wh.finish2+${uid()}@example.test`;
    const seq2 = await lastSeq(env);
    const challenge = must("add an email", await visitor.call<{ challenge_id: string }>("POST", "/v1/me/emails", { json: { email: email2 } }), [200, 201]).body;
    must("verify it", await visitor.call("POST", "/v1/me/emails/verify", { json: { challenge_id: challenge.challenge_id, code: await codeFor(env, email2, seq2) } }), 200);
    must("make it primary", await visitor.call("POST", `/v1/me/emails/${encodeURIComponent(email2)}/primary`), 200);
    const emailEvent = await waitEvent(env, APP, { type: "account.updated", uuid, after });
    const emailData = emailEvent?.payload.data as { changed?: string[]; account?: Record<string, unknown> } | undefined;
    results.check("now granted email, legacy-crm hears the new primary email", !!emailData && sameJson(emailData.changed, ["email"]) && emailData.account?.email === email2, short(emailData, 300));
  },
};

export const journeys: Journey[] = [matchedJourney, finishJourney];
