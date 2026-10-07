/**
 * Idempotent issuance (UNDERSTANDING.md: "For externally initiated changes include idempotency keys, so retrying
 * something never does it twice"): an Idempotency-Key makes a retried POST /v1/proofs/obo|ata replay the first proof
 * (same id, same tokens) instead of issuing another, even when the retries race; the stored answer is sealed (no token
 * in the database); a different body is refused; failures are not stored; keys belong to one app and endpoint; the
 * replay window of an answer that carries tokens is 10 minutes.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { json, sql } from "../../lib";
import { appTokens, errorCode, issueAtaFor, issueObo, row, short, signInToApp, verifyAs, type IssuedProof } from "./_helpers";

export const journey: Journey = {
  name: "proofs-perf-idempotency",
  title: "OBO and ATA issuance with an Idempotency-Key: a retry replays the same proof (Idempotent-Replayed: true), ten racing retries issue one proof, the stored answer is sealed, another body → 409, failures are not stored, keys are per app and endpoint (the ATA page's too), the replay window is 10 minutes",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await signInToApp(ctx, "dm");
    const subject = (await appTokens(env, "dm", carbon.uuid)).access_token;
    const families = async (scope: string) => (await sql(env, `select count(*) from proof_families where '${scope}' = any(scopes)`))[0]?.[0];

    // A retry replays the first answer.
    const key = randomUUID();
    const body = { receiving_app: "briefcase", scopes: [`pp.idem.${key.slice(0, 8)}`], access_ttl_seconds: 600 };
    const first = await issueObo(ctx, "dm", subject, body, { key });
    const retry = await issueObo(ctx, "dm", subject, body, { key });
    results.check("first → 201 without Idempotent-Replayed; the retry → 201 with Idempotent-Replayed: true", first.status === 201 && first.headers.get("idempotent-replayed") === null && retry.status === 201 && retry.headers.get("idempotent-replayed") === "true", `${first.status}/${first.headers.get("idempotent-replayed")} ${retry.status}/${retry.headers.get("idempotent-replayed")}`);
    results.check("the retry is the same proof byte for byte: same proof_id, same proof token, same refresh token, same expires_at", JSON.stringify(retry.body) === JSON.stringify(first.body), `${short(first.body.proof_id)} / ${short(retry.body.proof_id)}`);
    results.check("one proof in the database, one proof.issued in the audit log", (await families(body.scopes[0]!)) === "1" && (await row(env, `select count(*) from audit_log where action = 'proof.issued' and target_id = '${first.body.proof_id}'`))?.[0] === "1");
    results.check("the replayed proof token verifies", (await verifyAs(ctx, "briefcase", retry.body.proof_token)).body.valid === true);
    const stored = await row(env, `select response::text, extract(epoch from (expires_at - created_at))::int from idempotency_keys where key = '${key}' and scope = 'app:dm POST /v1/proofs/obo'`);
    results.check("the stored answer is sealed: no proof token or refresh token in idempotency_keys", !!stored && stored[0]!.includes("$sealed") && !stored[0]!.includes("sap_") && !stored[0]!.includes(first.body.proof_id), short(stored?.[0]?.slice(0, 80)));
    results.check("…and replayable for 10 minutes (an answer carrying tokens), not 24 hours", Number(stored?.[1]) >= 600 && Number(stored?.[1]) <= 605, `${stored?.[1]} s`);

    // The same key with another body, another app, another endpoint.
    const other = await issueObo(ctx, "dm", subject, { ...body, scopes: ["pp.other-body"] }, { key });
    results.check("the same key with a different body → 409 idempotency_key_reused", other.status === 409 && errorCode(other.body) === "idempotency_key_reused", `${other.status} ${short(other.body.error)}`);
    const otherApp = await issueAtaFor(ctx, "commit", "remind", {}, { key });
    results.check("the same key string from another app (Commit's ATA) → its own 201: keys belong to one app and endpoint", otherApp.status === 201 && otherApp.headers.get("idempotent-replayed") === null && otherApp.body.proof_id !== first.body.proof_id, `${otherApp.status} ${short(otherApp.body.error)}`);
    const otherEndpoint = await issueAtaFor(ctx, "dm", "briefcase", {}, { key });
    results.check("the same key at another endpoint of the same app (dm's ATA) → its own 201", otherEndpoint.status === 201 && otherEndpoint.body.kind === "ata", `${otherEndpoint.status} ${short(otherEndpoint.body.error)}`);

    // A failure is not stored: the corrected retry with the same key runs.
    const failKey = randomUUID();
    const failed = await issueObo(ctx, "dm", subject, { receiving_app: "nope-pp-app" }, { key: failKey });
    const fixed = await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: ["pp.fixed"] }, { key: failKey });
    results.check("a refused request (400 unknown_receiving_app) is not stored: the same key with the fixed body → 201", failed.status === 400 && fixed.status === 201 && fixed.headers.get("idempotent-replayed") === null, `${failed.status} ${errorCode(failed.body)} → ${fixed.status}`);

    // Ten racing retries: one proof.
    const raceKey = randomUUID();
    const raceBody = { receiving_app: "briefcase", scopes: [`pp.race.${raceKey.slice(0, 8)}`] };
    const race = await Promise.all(Array.from({ length: 10 }, () => issueObo(ctx, "dm", subject, raceBody, { key: raceKey })));
    const created = race.filter(answer => answer.status === 201);
    const busy = race.filter(answer => answer.status === 409 && errorCode(answer.body) === "idempotency_in_progress");
    const ids = new Set(created.map(answer => answer.body.proof_id));
    results.check("10 simultaneous requests with one key: each answer is the one proof (201, first or replayed) or 409 idempotency_in_progress", created.length >= 1 && created.length + busy.length === 10 && ids.size === 1, race.map(answer => (answer.status === 201 ? (answer.headers.get("idempotent-replayed") ? "201r" : "201") : `${answer.status} ${errorCode(answer.body)}`)).join(", "));
    results.check("…and exactly one proof was issued", (await families(raceBody.scopes[0]!)) === "1", String(await families(raceBody.scopes[0]!)));
    const afterRace = await issueObo(ctx, "dm", subject, raceBody, { key: raceKey });
    results.check("a retry after the race replays that proof", afterRace.status === 201 && afterRace.headers.get("idempotent-replayed") === "true" && afterRace.body.proof_id === [...ids][0], `${afterRace.status} ${afterRace.body.proof_id}`);

    // Without a key nothing is deduplicated (each request is a new proof).
    const noKey = { receiving_app: "briefcase", scopes: [`pp.nokey.${randomUUID().slice(0, 8)}`] };
    const a = await issueObo(ctx, "dm", subject, noKey, { key: "" });
    const b = await issueObo(ctx, "dm", subject, noKey, { key: "" });
    results.check("two identical requests without a key → two proofs", a.status === 201 && b.status === 201 && a.body.proof_id !== b.body.proof_id, `${a.body.proof_id} / ${b.body.proof_id}`);

    // Through the fake app: dm forwards the key it is given, so its own retry is safe too.
    const appKey = randomUUID();
    const viaApp = async () => (await json<{ status: number; body: IssuedProof }>(`${env.apps}/dm/actions/issue-obo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uuid: carbon.uuid, receiving_app: "briefcase", scopes: ["pp.via-app"], idempotency_key: appKey }) })).body;
    const once = await viaApp();
    const twice = await viaApp();
    results.check("dm's own retry through the fake app with one key gets the same proof", once.status === 201 && twice.status === 201 && once.body.proof_id === twice.body.proof_id && once.body.proof_token === twice.body.proof_token, `${once.status} ${twice.status}`);

    // ATA too (a proof for one app: UNDERSTANDING.md allows no other kind), on POST /v1/proofs/ata and the ATA page.
    const ataKey = randomUUID();
    const ata1 = await issueAtaFor(ctx, "commit", "remind", { scopes: ["pp.ata-idem"] }, { key: ataKey });
    const ata2 = await issueAtaFor(ctx, "commit", "remind", { scopes: ["pp.ata-idem"] }, { key: ataKey });
    results.check("ATA: the retry replays the same proof", ata1.status === 201 && ata2.status === 201 && ata2.headers.get("idempotent-replayed") === "true" && ata1.body.proof_id === ata2.body.proof_id && ata1.body.proof_token === ata2.body.proof_token, `${ata1.status} ${ata2.status} ${ata2.headers.get("idempotent-replayed")}`);
    const ataOtherApp = await issueAtaFor(ctx, "commit", "waveform", { scopes: ["pp.ata-idem"] }, { key: ataKey });
    results.check("ATA: the same key for another receiving app → 409 idempotency_key_reused (a second app is a second proof, with a key of its own)", ataOtherApp.status === 409 && errorCode(ataOtherApp.body) === "idempotency_key_reused", `${ataOtherApp.status} ${short(ataOtherApp.body.error)}`);
    const pageKey = randomUUID();
    const page1 = await issueAtaFor(ctx, "commit", "waveform", {}, { key: pageKey, path: "/v1/apps/commit/proofs/ata" });
    const page2 = await issueAtaFor(ctx, "commit", "waveform", {}, { key: pageKey, path: "/v1/apps/commit/proofs/ata" });
    const pageElsewhere = await issueAtaFor(ctx, "commit", "waveform", {}, { key: pageKey });
    results.check(
      "the ATA page's endpoint replays a retry too, and the same key on POST /v1/proofs/ata is another endpoint's (its own new proof)",
      page1.status === 201 && page2.status === 201 && page2.headers.get("idempotent-replayed") === "true" && page2.body.proof_id === page1.body.proof_id && pageElsewhere.status === 201 && pageElsewhere.headers.get("idempotent-replayed") === null && pageElsewhere.body.proof_id !== page1.body.proof_id,
      `${page1.status} ${page2.status}/${page2.headers.get("idempotent-replayed")} ${pageElsewhere.status}/${pageElsewhere.headers.get("idempotent-replayed")}`,
    );

    // Past the 10-minute window (time travel on the stored key) the same key issues a new proof.
    await sql(env, `update idempotency_keys set expires_at = now() - interval '1 second' where key = '${key}' and scope = 'app:dm POST /v1/proofs/obo'`);
    const late = await issueObo(ctx, "dm", subject, body, { key });
    results.check("after the 10-minute replay window the same key and body issue a new proof (201, not replayed, a new id)", late.status === 201 && late.headers.get("idempotent-replayed") === null && late.body.proof_id !== first.body.proof_id, `${late.status} ${late.body.proof_id}`);
    results.check("…while the first proof is untouched and still verifies", (await verifyAs(ctx, "briefcase", first.body.proof_token)).body.valid === true);
  },
};
