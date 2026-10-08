/**
 * App verification proofs are for exactly one app (UNDERSTANDING.md "Proofs (User verification and App verification)": "An app verification proof is always for exactly one
 * app; a proof can't be made for several apps at once. If App A wants to talk to App B and App C, it makes one proof
 * for App B and another one for App C, and each of them verifies its own proof with us"; build spec 06-v2.md §7).
 *
 * commit (App verification issuer) talks to remind and waveform: one proof each, through POST /v1/proofs/app-verification and the owner route
 * POST /v1/apps/commit/proofs/app-verification (with commit's own credentials, and as commit's owner through the developer site's
 * BFF), the CLI's `silicon-accounts app proof app-verification --to <one app>`. Every way of asking for several apps at once is refused with
 * 422 `app_verification_single_app` (or the CLI's own refusal), each proof verifies only for its own app, listings and refreshes keep
 * the one app, and the store keeps `audiences` = [that app].
 */
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, api, cli, cliHome, developerApi, fakeApp, issueAppVerification, newContext, signInOnDeveloper, sql, tag, verifyProof, type IssuedProof } from "../../lib";
import { SEEDED_OWNER_PHOTO, appIdOf, basicAuth, median, type ApiErrorBody } from "./_helpers";

const ATA_MESSAGE = "An app verification is for exactly one app; ask for one proof per app.";

export const journey: Journey = {
  name: "v2-flows-app_verification-single-app",
  title: "App verification proofs for exactly one app: commit makes one proof for remind and another for waveform (API, owner route, CLI, developer site BFF), each verified only by its own app; audiences of any length → 422 app_verification_single_app; refresh and listings keep the one app",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const issuing: number[] = [];
    const verifying: number[] = [];

    // 1. One proof per receiving app, each verified by its own app only.
    const forRemind = await issueAppVerification(ctx, "commit", "remind", { scopes: ["notifications.send"] });
    const forWaveform = await issueAppVerification(ctx, "commit", "waveform", { scopes: ["notifications.send"] });
    issuing.push(forRemind.ms, forWaveform.ms);
    const shapeOk = (proof: IssuedProof, receiver: string) =>
      proof.kind === "app_verification" && proof.receiving_app === receiver && proof.issuing_app === "commit" && (proof as { user?: unknown }).user === null && /^sap_/.test(proof.proof_token) && /^sapr_/.test(String(proof.proof_refresh_token ?? "")) && typeof proof.expires_at === "string";
    results.check("POST /v1/proofs/app-verification {receiving_app: remind}: 201, one proof whose receiving_app is the string \"remind\" (no user, a proof token and a refresh token)", forRemind.status === 201 && shapeOk(forRemind.body, "remind"), `${forRemind.status} ${JSON.stringify({ ...forRemind.body, proof_token: "…", proof_refresh_token: "…" }).slice(0, 300)}`);
    results.check("…and a second call {receiving_app: waveform} is another proof, for waveform alone", forWaveform.status === 201 && shapeOk(forWaveform.body, "waveform") && forWaveform.body.proof_id !== forRemind.body.proof_id, `${forWaveform.status} ${forWaveform.body.proof_id} vs ${forRemind.body.proof_id}`);
    const stored = await sql(env, `select id, array_to_string(audiences, ',') from proof_families where id in ('${forRemind.body.proof_id}', '${forWaveform.body.proof_id}') order by id`);
    const audiences = Object.fromEntries(stored.map(row => [row[0], row[1]]));
    results.check("the store keeps one app per proof (audiences = [remind] and [waveform])", audiences[forRemind.body.proof_id] === "remind" && audiences[forWaveform.body.proof_id] === "waveform", JSON.stringify(audiences));

    const remindOwn = await verifyProof(ctx, "remind", forRemind.body.proof_token);
    const waveformOwn = await verifyProof(ctx, "waveform", forWaveform.body.proof_token);
    const remindOther = await verifyProof(ctx, "remind", forWaveform.body.proof_token);
    const waveformOther = await verifyProof(ctx, "waveform", forRemind.body.proof_token);
    verifying.push(remindOwn.ms, waveformOwn.ms);
    results.check("remind verifies its proof: valid, issued by commit, for remind, until expires_at", remindOwn.body.valid === true && appIdOf(remindOwn.body.issuing_app) === "commit" && appIdOf(remindOwn.body.receiving_app) === "remind" && remindOwn.body.expires_at === forRemind.body.expires_at, JSON.stringify(remindOwn.body).slice(0, 300));
    results.check("waveform verifies its own proof the same way", waveformOwn.body.valid === true && appIdOf(waveformOwn.body.receiving_app) === "waveform", JSON.stringify(waveformOwn.body).slice(0, 300));
    const exactlyInvalid = (body: unknown) => JSON.stringify(body) === JSON.stringify({ valid: false, expires_at: null }) || JSON.stringify(body) === JSON.stringify({ expires_at: null, valid: false });
    results.check("remind holding waveform's proof is told exactly {valid:false, expires_at:null}", remindOther.status === 200 && exactlyInvalid(remindOther.body), JSON.stringify(remindOther.body));
    results.check("waveform holding remind's proof is told exactly {valid:false, expires_at:null}", waveformOther.status === 200 && exactlyInvalid(waveformOther.body), JSON.stringify(waveformOther.body));

    // 2. Every way of asking for several apps (or naming them as a list) is refused, with the way out.
    const app_verification = (path: string, body: unknown, app = "commit") =>
      api<{ error?: ApiErrorBody; receiving_app?: unknown; proof_id?: string }>(ctx, path, { method: "POST", headers: { authorization: basicAuth(app), "idempotency-key": `v2f-app_verification-${Date.now()}-${tag()}` }, json: body });
    const cases: Array<{ name: string; body: unknown }> = [
      { name: "audiences [remind, waveform]", body: { audiences: ["remind", "waveform"] } },
      { name: "audiences [remind] (one app, still as a list)", body: { audiences: ["remind"] } },
      { name: "audiences []", body: { audiences: [] } },
      { name: "receiving_app remind plus audiences [waveform]", body: { receiving_app: "remind", audiences: ["waveform"] } },
    ];
    for (const { name, body } of cases) {
      const answer = await app_verification("/v1/proofs/app-verification", body);
      const error = answer.body.error;
      results.check(
        `POST /v1/proofs/app-verification with ${name} → 422 app_verification_single_app, "${ATA_MESSAGE}", the hint naming {"receiving_app": …} on POST /v1/proofs/app-verification`,
        answer.status === 422 && error?.code === "app_verification_single_app" && error.message === ATA_MESSAGE && /"receiving_app"/.test(error.hint ?? "") && /POST \/v1\/proofs\/app_verification/.test(error.hint ?? ""),
        `${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`,
      );
    }
    const both = await app_verification("/v1/proofs/app-verification", { audiences: ["remind", "waveform"] });
    results.check("…and the refusal names both apps (details.apps)", JSON.stringify(both.body.error?.details?.apps) === JSON.stringify(["remind", "waveform"]), JSON.stringify(both.body.error?.details));
    const none = await app_verification("/v1/proofs/app-verification", {});
    results.check("no receiving_app at all → 422 validation_failed on receiving_app", none.status === 422 && none.body.error?.code === "validation_failed" && typeof none.body.error.details?.fields?.receiving_app === "string", `${none.status} ${JSON.stringify(none.body).slice(0, 300)}`);
    const listed = await app_verification("/v1/proofs/app-verification", { receiving_app: ["remind", "waveform"] });
    results.check("receiving_app as a list → 422 (a single app id is expected), no proof", listed.status === 422 && !listed.body.proof_id, `${listed.status} ${JSON.stringify(listed.body).slice(0, 300)}`);
    const itself = await app_verification("/v1/proofs/app-verification", { receiving_app: "commit" });
    results.check("a proof for the issuing app itself → 400 invalid_receiving_app", itself.status === 400 && itself.body.error?.code === "invalid_receiving_app", `${itself.status} ${JSON.stringify(itself.body).slice(0, 200)}`);
    const firstParty = await app_verification("/v1/proofs/app-verification", { receiving_app: "developer" });
    results.check("a proof for Silicon Accounts' own developer app → 400 invalid_receiving_app", firstParty.status === 400 && firstParty.body.error?.code === "invalid_receiving_app", `${firstParty.status} ${JSON.stringify(firstParty.body).slice(0, 200)}`);
    const unknown = await app_verification("/v1/proofs/app-verification", { receiving_app: `nope-${tag()}` });
    results.check("an app that does not exist → 400 unknown_receiving_app", unknown.status === 400 && unknown.body.error?.code === "unknown_receiving_app", `${unknown.status} ${JSON.stringify(unknown.body).slice(0, 200)}`);

    // 3. The owner route (the developer site's App verification page uses it) follows the same rule, and its hint names it.
    const ownerRoute = "/v1/apps/commit/proofs/app-verification";
    const viaOwnerRoute = await app_verification(ownerRoute, { receiving_app: "remind" });
    results.check("POST /v1/apps/commit/proofs/app-verification {receiving_app: remind} (commit's credentials) → 201, receiving_app \"remind\"", viaOwnerRoute.status === 201 && viaOwnerRoute.body.receiving_app === "remind", `${viaOwnerRoute.status} ${JSON.stringify({ ...viaOwnerRoute.body, proof_token: "…", proof_refresh_token: "…" }).slice(0, 240)}`);
    const ownerSeveral = await app_verification(ownerRoute, { audiences: ["remind", "waveform"] });
    results.check("…with audiences → 422 app_verification_single_app whose hint names POST /v1/apps/commit/proofs/app-verification", ownerSeveral.status === 422 && ownerSeveral.body.error?.code === "app_verification_single_app" && ownerSeveral.body.error.hint?.includes(`POST ${ownerRoute}`) === true, `${ownerSeveral.status} ${JSON.stringify(ownerSeveral.body).slice(0, 400)}`);

    // 4. Listings and refreshes keep the one app.
    const list = await api<{ items?: Array<{ proof_id: string; kind: string; receiving_app: unknown }> }>(ctx, "/v1/apps/commit/proofs?kind=app_verification&limit=50", { headers: { authorization: basicAuth("commit") } });
    const items = list.body.items ?? [];
    const listedRemind = items.find(item => item.proof_id === forRemind.body.proof_id);
    const listedWaveform = items.find(item => item.proof_id === forWaveform.body.proof_id);
    results.check("GET /v1/apps/commit/proofs?kind=app_verification lists each proof with its one receiving_app as a string", list.status === 200 && listedRemind?.receiving_app === "remind" && listedWaveform?.receiving_app === "waveform" && items.every(item => typeof item.receiving_app === "string"), `${list.status} ${JSON.stringify(items.slice(0, 3)).slice(0, 300)}`);
    const refreshed = await api<IssuedProof & { error?: ApiErrorBody }>(ctx, "/v1/proofs/refresh", { method: "POST", headers: { authorization: basicAuth("commit") }, json: { proof_refresh_token: forRemind.body.proof_refresh_token } });
    results.check("POST /v1/proofs/refresh gives commit a new proof token for remind (still one app)", refreshed.status === 200 && refreshed.body.receiving_app === "remind" && /^sap_/.test(refreshed.body.proof_token ?? "") && refreshed.body.proof_token !== forRemind.body.proof_token, `${refreshed.status} ${JSON.stringify({ ...refreshed.body, proof_token: "…", proof_refresh_token: "…" }).slice(0, 240)}`);
    const refreshedByRemind = await verifyProof(ctx, "remind", refreshed.body.proof_token ?? "");
    const refreshedByWaveform = await verifyProof(ctx, "waveform", refreshed.body.proof_token ?? "");
    results.check("…remind verifies the refreshed token, waveform still cannot", refreshedByRemind.body.valid === true && exactlyInvalid(refreshedByWaveform.body), `${JSON.stringify(refreshedByRemind.body).slice(0, 160)} | ${JSON.stringify(refreshedByWaveform.body)}`);

    // 5. The CLI names exactly one app with --to.
    const home = cliHome();
    const secret = `${fakeApp("commit").secret}\n`;
    const appFlags = ["--app-id", "commit", "--app-secret-stdin", "--json"];
    const one = await cli(env, home, ["app", "proof", "app_verification", "--to", "remind", ...appFlags], { stdin: secret });
    const cliToken = typeof one.json?.proof_token === "string" ? one.json.proof_token : "";
    results.check("`silicon-accounts app proof app-verification --to remind` → one proof for remind", one.code === 0 && one.json?.receiving_app === "remind" && one.json.kind === "app_verification" && cliToken.startsWith("sap_"), `exit ${one.code} in ${one.ms} ms: ${JSON.stringify({ ...one.json, proof_token: "…", proof_refresh_token: "…" }).slice(0, 200)}`);
    results.check("…which remind verifies", (await verifyProof(ctx, "remind", cliToken)).body.valid === true);
    const cliError = (run: typeof one) => {
      const error = (run.json?.error ?? {}) as { message?: string; hint?: string };
      return { message: error.message ?? run.stderr.trim(), hint: error.hint ?? "" };
    };
    const comma = await cli(env, home, ["app", "proof", "app_verification", "--to", "remind,waveform", ...appFlags], { stdin: secret });
    const commaError = cliError(comma);
    results.check(
      "`--to remind,waveform` is refused: one app per proof, with the two commands to run instead",
      comma.code !== 0 && /exactly one app/.test(commaError.message) && /remind, waveform/.test(commaError.message) && /accounts app proof app-verification --to remind/.test(commaError.hint) && /accounts app proof app-verification --to waveform/.test(commaError.hint),
      `exit ${comma.code}: ${commaError.message} | ${commaError.hint}`.slice(0, 400),
    );
    const spaced = await cli(env, home, ["app", "proof", "app_verification", "--to", "remind waveform", ...appFlags], { stdin: secret });
    results.check("`--to \"remind waveform\"` is refused the same way", spaced.code !== 0 && /exactly one app/.test(cliError(spaced).message), `exit ${spaced.code}: ${cliError(spaced).message}`.slice(0, 300));
    const twice = await cli(env, home, ["app", "proof", "app_verification", "--to", "remind", "--to", "waveform", ...appFlags], { stdin: secret });
    results.check("`--to remind --to waveform` is refused (--to takes one app)", twice.code === 2 && /--to/.test(`${cliError(twice).message} ${twice.stderr}`), `exit ${twice.code}: ${cliError(twice).message || twice.stderr}`.slice(0, 300));
    const missing = await cli(env, home, ["app", "proof", "app_verification", ...appFlags], { stdin: secret });
    results.check(
      "no --to is refused, and the --json error says which argument is missing (--to <APP_ID>), not only \"the following required arguments were not provided:\"",
      missing.code === 2 && /--to/.test(cliError(missing).message),
      `exit ${missing.code}: ${JSON.stringify(missing.json?.error ?? missing.stderr).slice(0, 300)}`,
    );
    const afterCli = await sql(env, `select count(*) from proof_families where issuing_app = 'commit' and kind = 'app_verification' and cardinality(audiences) <> 1`);
    results.check("no stored App verification proof of commit has more or less than one app", afterCli[0]?.[0] === "0", `proofs with another number of apps: ${afterCli[0]?.[0]}`);

    // 6. As commit's owner on the developer site (its BFF calls the owner route with the developer session).
    const context = await newContext(browser);
    const page = await context.newPage();
    // The seeded owner's photo points at the production Iris (accounts-seed runs without the stack's
    // ACCOUNTS_IRIS_BASE_URL): v2-flows-seeded-owner-photos reports that once, so it does not fail this journey too.
    results.watch(page, "app_verification-developer", [DEVELOPER_SIGNED_OUT, SEEDED_OWNER_PHOTO]);
    await signInOnDeveloper(env, page, fakeApp("commit").owner_email);
    const ownerProof = await developerApi<IssuedProof & { error?: ApiErrorBody }>(env, page, "/apps/commit/proofs/app-verification", { json: { receiving_app: "waveform" }, headers: { "idempotency-key": `v2f-dev-${tag()}` } });
    results.check("as commit's owner through the developer site: a proof for waveform alone (201)", ownerProof.status === 201 && ownerProof.body.receiving_app === "waveform", `${ownerProof.status} ${JSON.stringify({ ...ownerProof.body, proof_token: "…", proof_refresh_token: "…" }).slice(0, 240)}`);
    results.check("…which waveform verifies", (await verifyProof(ctx, "waveform", ownerProof.body.proof_token ?? "")).body.valid === true);
    const ownerList = await developerApi<{ error?: ApiErrorBody }>(env, page, "/apps/commit/proofs/app-verification", { json: { audiences: ["remind", "waveform"] }, headers: { "idempotency-key": `v2f-dev-${tag()}` } });
    results.check("…and the owner asking for two apps at once gets 422 app_verification_single_app too", ownerList.status === 422 && ownerList.body.error?.code === "app_verification_single_app", `${ownerList.status} ${JSON.stringify(ownerList.body).slice(0, 300)}`);
    await context.close();

    // Timings: a few more single-app proofs, issued and verified straight at accounts-api.
    for (let i = 0; i < 6; i++) {
      const receiver = i % 2 ? "waveform" : "remind";
      const issued = await issueAppVerification(ctx, "commit", receiver, { direct: true });
      issuing.push(issued.ms);
      verifying.push((await verifyProof(ctx, receiver, issued.body.proof_token, { direct: true })).ms);
    }
    results.metric("App verification issue (one app) median", median(issuing));
    results.metric("App verification verify median", median(verifying));
  },
};
