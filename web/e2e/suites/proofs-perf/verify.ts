/**
 * Verification answers exactly `{"valid": false, "expires_at": null}` for anything that is not a valid proof for the
 * app asking: every non-audience app (the issuing app included), unknown and malformed tokens, a proof whose issuing
 * app is disabled. A valid answer has exactly the contract's keys and never a token. Only apps may verify (not a
 * Carbon's own token, not the developer platform, which has no secret).
 */
import type { Journey } from "../../context";
import { json, sql } from "../../lib";
import { VALID_KEYS, appTokens, asApp, errorCode, isExactlyInvalid, issueAtaFor, issueObo, short, signInToApp, verifyAs, type Verification } from "./_helpers";

export const journey: Journey = {
  name: "proofs-perf-verify-exact-invalid",
  title: "verify answers exactly {valid:false, expires_at:null} to every non-audience app (the issuer too), to unknown, malformed and wrapped tokens and when the issuing app is disabled; valid answers carry exactly the contract keys; only authenticated apps may verify",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await signInToApp(ctx, "dm");
    const subject = (await appTokens(env, "dm", carbon.uuid)).access_token;
    const obo = (await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: ["files.write"] })).body;
    // An ATA proof is always for exactly one app (UNDERSTANDING.md): Commit's is for Remind.
    const ata = (await issueAtaFor(ctx, "commit", "remind", { scopes: ["notifications.send"] })).body;
    results.check("dm issued an OBO proof for Briefcase and Commit an ATA proof for Remind", obo.proof_token?.startsWith("sap_") === true && ata.proof_token?.startsWith("sap_") === true, `${short(obo.error ?? obo.proof_id)} / ${short(ata.error ?? ata.proof_id)}`);

    // The receiving apps: valid, with exactly the contract's keys and no token anywhere.
    const good = await verifyAs(ctx, "briefcase", obo.proof_token);
    results.check("Briefcase (the OBO proof's receiving app) gets valid with exactly the contract keys", good.status === 200 && good.body.valid === true && JSON.stringify(Object.keys(good.body).sort()) === JSON.stringify(VALID_KEYS), `${good.status} ${JSON.stringify(Object.keys(good.body).sort())}`);
    results.check("…the OBO verdict names the issuing app, the receiving app, the user (uuid, id, kind, membership with dm), the scopes and the token's expiry", good.body.issuing_app?.app_id === "dm" && good.body.receiving_app?.app_id === "briefcase" && good.body.user?.uuid === carbon.uuid && good.body.user.membership_id === `dm:${carbon.uuid}` && JSON.stringify(good.body.scopes) === '["files.write"]' && good.body.expires_at === obo.expires_at, short(good.body));
    results.check("…and the answer carries no token and is not cacheable (Cache-Control: no-store)", !JSON.stringify(good.body).includes("sap_") && good.headers.get("cache-control") === "no-store", String(good.headers.get("cache-control")));
    const remind = await verifyAs(ctx, "remind", ata.proof_token);
    results.check("remind (the ATA proof's app) gets valid, receiving_app remind, user null, exactly the contract keys", remind.body.valid === true && remind.body.kind === "ata" && remind.body.receiving_app?.app_id === "remind" && remind.body.user === null && remind.body.issuing_app?.app_id === "commit" && JSON.stringify(Object.keys(remind.body).sort()) === JSON.stringify(VALID_KEYS), short(remind.body));

    // Every app that is not the receiving app, through the site and straight at accounts-api.
    const exactly = async (label: string, app: string, token: string, direct = false) => {
      const answer = await verifyAs(ctx, app, token, { direct });
      const ok = answer.status === 200 && isExactlyInvalid(answer.body) && answer.headers.get("cache-control") === "no-store";
      results.check(label, ok, `${answer.status} ${JSON.stringify(answer.body)} cache-control=${answer.headers.get("cache-control")}`);
      return answer;
    };
    for (const app of ["remind", "waveform", "commit", "spacestation", "acme-notes"]) await exactly(`${app} verifying dm's OBO proof for Briefcase → exactly {valid:false, expires_at:null}`, app, obo.proof_token);
    const issuer = await exactly("dm (the issuing app, not the receiving app) verifying its own OBO proof → exactly invalid", "dm", obo.proof_token);
    results.check("…with no x-accounts-hint: the input was a well-formed proof token, so nothing about the proof is hinted", issuer.headers.get("x-accounts-hint") === null, String(issuer.headers.get("x-accounts-hint")));
    await exactly("remind verifying dm's OBO proof straight at accounts-api → exactly invalid", "remind", obo.proof_token, true);
    for (const app of ["waveform", "briefcase", "dm", "commit", "spacestation"]) await exactly(`${app} verifying Commit's ATA proof for remind → exactly invalid${app === "waveform" ? " (another app Commit talks to, but not this proof's)" : ""}`, app, ata.proof_token);

    // Unknown, malformed and wrapped inputs: the same body; a hint header describes the input only (never the proof).
    const random = `sap_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    await exactly("an unknown sap_ token → exactly invalid", "briefcase", random);
    const flipped = obo.proof_token.slice(0, -1) + (obo.proof_token.endsWith("A") ? "B" : "A");
    await exactly("dm's proof token with its last character changed → exactly invalid", "briefcase", flipped);
    await exactly("dm's proof token in upper case → exactly invalid (tokens are case-sensitive)", "briefcase", obo.proof_token.toUpperCase().replace(/^SAP_/, "sap_"));
    const inputs: Array<[string, string, RegExp]> = [
      ["the proof's refresh token (sapr_…)", obo.proof_refresh_token, /refresh token/i],
      ["the Carbon's access token (a JWT)", subject, /access token|JWT/i],
      ["an empty string", "", /empty/i],
      ['"Proof sap_…" (the header value, not the token)', `Proof ${obo.proof_token}`, /other text around it/i],
      ['"Bearer sap_…"', `Bearer ${obo.proof_token}`, /other text around it/i],
      ["some text", "hello", /not a Silicon Accounts token/i],
    ];
    for (const [what, input, hint] of inputs) {
      const answer = await exactly(`${what} → exactly invalid`, "briefcase", input);
      const header = answer.headers.get("x-accounts-hint") ?? "";
      const secret = input.replace(/^(Proof|Bearer) /, "").slice(5, 30);
      results.check(`…its x-accounts-hint describes the input (${hint.source}) without repeating it`, hint.test(header) && (secret.length < 8 || !header.includes(secret)), header);
    }

    // Bodies are strict, and only apps verify.
    const missing = await asApp<Verification>(ctx, "briefcase", "POST", "/v1/proofs/verify", {});
    results.check("a body without proof_token → 422 (not a silent invalid)", missing.status === 422, `${missing.status} ${errorCode(missing.body)}`);
    const extra = await asApp<Verification>(ctx, "briefcase", "POST", "/v1/proofs/verify", { proof_token: obo.proof_token, audience: "briefcase" });
    results.check("an unknown body field → 422", extra.status === 422, `${extra.status} ${errorCode(extra.body)}`);
    const noAuth = await verifyAs(ctx, "briefcase", obo.proof_token, { secret: null });
    results.check("no app credentials → 401 app_credentials_required, not a verdict", noAuth.status === 401 && errorCode(noAuth.body) === "app_credentials_required" && !("valid" in (noAuth.body as object)), `${noAuth.status} ${short(noAuth.body)}`);
    const wrong = await verifyAs(ctx, "briefcase", obo.proof_token, { secret: "sa_app_briefcase_not-the-secret" });
    results.check("a wrong secret → 401 invalid_app_credentials", wrong.status === 401 && errorCode(wrong.body) === "invalid_app_credentials", `${wrong.status} ${short(wrong.body)}`);
    const nobody = await json<Record<string, unknown>>(`${env.api}/v1/proofs/verify`, { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("no-such-app:sa_app_x").toString("base64")}` }, body: JSON.stringify({ proof_token: obo.proof_token }) });
    results.check("an unknown app id → 401", nobody.status === 401, `${nobody.status} ${short(nobody.body)}`);
    const developer = await json<Record<string, unknown>>(`${env.api}/v1/proofs/verify`, { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("developer:anything").toString("base64")}` }, body: JSON.stringify({ proof_token: obo.proof_token }) });
    results.check("the developer platform's app id (a public client with no secret) → 401: it can't verify proofs", developer.status === 401 && !("valid" in (developer.body as object)), `${developer.status} ${short(developer.body)}`);
    const bearer = await json<Record<string, unknown>>(`${env.site}/v1/proofs/verify`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${subject}`, "x-forwarded-for": ctx.ip }, body: JSON.stringify({ proof_token: obo.proof_token }) });
    results.check("the Carbon's own bearer token → 401: accounts can't verify proofs, apps do", bearer.status === 401, `${bearer.status} ${short(bearer.body)}`);

    // Verifying changes nothing: the same proof verifies again and again.
    let again = 0;
    for (let i = 0; i < 5; i++) if ((await verifyAs(ctx, "briefcase", obo.proof_token)).body.valid === true) again++;
    results.check("verifying is read-only: five more verifies are all valid", again === 5, `${again}/5`);

    // The issuing app disabled (as Silicon Apps would set it): its proofs stop verifying at once, and come back with it.
    await sql(env, "update apps set status = 'disabled' where app_id in ('dm', 'commit')");
    try {
      await exactly("dm disabled: Briefcase's verify of dm's proof → exactly invalid", "briefcase", obo.proof_token);
      await exactly("Commit disabled: Remind's verify of Commit's ATA proof → exactly invalid", "remind", ata.proof_token);
    } finally {
      await sql(env, "update apps set status = 'active' where app_id in ('dm', 'commit')");
    }
    const back = await verifyAs(ctx, "briefcase", obo.proof_token);
    const backAta = await verifyAs(ctx, "remind", ata.proof_token);
    results.check("dm and Commit active again: both proofs verify again (disabling is not a revocation)", back.body.valid === true && backAta.body.valid === true, `${short(back.body)} / ${short(backAta.body)}`);
  },
};
