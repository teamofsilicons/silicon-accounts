/**
 * The webhooks suite's helpers that need no stack: its own v1 signature check (the suite verifies every delivery's
 * signature itself, independently of the testkit), the envelope check, and small comparisons.
 *
 *   web/node_modules/.bin/tsx --test web/e2e/suites/webhooks/test/*.test.ts
 *
 * The expected signatures were computed with Python's hmac module (an implementation independent of Node's):
 *   hmac.new(secret.encode(), (timestamp + "." + body).encode("utf-8"), hashlib.sha256).hexdigest()
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type WebhookBody, envelopeProblems, percentile, sameJson, signatureFor, verifySignature } from "../_helpers";

const SECRET = "whsec_xp1TbBVqPjD74gtqOKEkhRvHYvz8rtBjWjoUxEdLmn0";
const TIMESTAMP = "1791340541";
const BODY =
  '{"app_id":"dm","data":{"kind":"silicon","membership_id":"dm:8HV","new_id":"si:scout_two","old_id":"si:scout","uuid":"8HV"},"event_id":"01a11437-7425-7016-b4cf-b336b9779be8","occurred_at":"2026-10-07T02:35:40.965Z","silicon":null,"type":"account.id_changed"}';
const BODY_SIGNATURE = "v1=e8b683b1fc5c5daaf70f578ed12f0a626f6fa3d776a730eea3a7f50b4853e6ca";
const UNICODE_BODY = '{"name":"Zoë « 漢字 » \\"q\\" 🚀"}';
const UNICODE_SIGNATURE = "v1=82d53bff2c1f228b5cf86d538db7bc728d646e03aa3b0bbf3b89123c6b87ea24";

describe("signatureFor", () => {
  it("is v1=<hex HMAC-SHA256(the whole whsec_ secret, \"{timestamp}.{raw body}\")>, as Python's hmac computes it", () => {
    assert.equal(signatureFor(SECRET, TIMESTAMP, Buffer.from(BODY, "utf8")), BODY_SIGNATURE);
  });
  it("signs the UTF-8 bytes of the body exactly (non-ASCII text, quotes, an emoji)", () => {
    assert.equal(signatureFor(SECRET, TIMESTAMP, Buffer.from(UNICODE_BODY, "utf8")), UNICODE_SIGNATURE);
  });
});

describe("verifySignature", () => {
  const raw = Buffer.from(BODY, "utf8");
  it("accepts the signature of exactly this secret, timestamp and body", () => {
    assert.equal(verifySignature(SECRET, TIMESTAMP, raw, BODY_SIGNATURE), true);
  });
  it("accepts it among several v1 values, comma or space separated (a rotation's overlap)", () => {
    assert.equal(verifySignature(SECRET, TIMESTAMP, raw, `v1=${"0".repeat(64)}, ${BODY_SIGNATURE}`), true);
    assert.equal(verifySignature(SECRET, TIMESTAMP, raw, `v1=${"0".repeat(64)} ${BODY_SIGNATURE}`), true);
  });
  it("refuses another secret, the secret without its whsec_ prefix, another timestamp or one changed byte", () => {
    assert.equal(verifySignature(`${SECRET}x`, TIMESTAMP, raw, BODY_SIGNATURE), false);
    assert.equal(verifySignature(SECRET.slice("whsec_".length), TIMESTAMP, raw, BODY_SIGNATURE), false);
    assert.equal(verifySignature(SECRET, String(Number(TIMESTAMP) + 1), raw, BODY_SIGNATURE), false);
    const tampered = Buffer.from(raw);
    tampered[10] = tampered[10]! ^ 1;
    assert.equal(verifySignature(SECRET, TIMESTAMP, tampered, BODY_SIGNATURE), false);
  });
  it("refuses a missing header or timestamp, another scheme, and an upper-case or truncated hex", () => {
    assert.equal(verifySignature(SECRET, undefined, raw, BODY_SIGNATURE), false);
    assert.equal(verifySignature(SECRET, TIMESTAMP, raw, undefined), false);
    assert.equal(verifySignature(SECRET, TIMESTAMP, raw, BODY_SIGNATURE.replace("v1=", "v0=")), false);
    assert.equal(verifySignature(SECRET, TIMESTAMP, raw, BODY_SIGNATURE.toUpperCase().replace("V1=", "v1=")), false);
    assert.equal(verifySignature(SECRET, TIMESTAMP, raw, BODY_SIGNATURE.slice(0, -2)), false);
  });
});

describe("envelopeProblems", () => {
  const good = (): WebhookBody => JSON.parse(BODY) as WebhookBody;
  it("finds nothing wrong with a real envelope", () => {
    assert.deepEqual(envelopeProblems(good(), { type: "account.id_changed", app_id: "dm", silicon: null }), []);
  });
  it("names what is wrong: an extra key, a non-UUIDv7 event id, the type, occurred_at without milliseconds, the target", () => {
    const body = { ...good(), extra: 1, event_id: "01a11437-7425-4016-b4cf-b336b9779be8", occurred_at: "2026-10-07T02:35:40Z" } as unknown as WebhookBody;
    const problems = envelopeProblems(body, { type: "account.updated", app_id: "briefcase", silicon: null });
    assert.equal(problems.length, 5, problems.join("; "));
    assert.ok(problems.some(problem => problem.startsWith("keys ")));
    assert.ok(problems.some(problem => problem.includes("UUIDv7")));
    assert.ok(problems.some(problem => problem.startsWith("type ")));
    assert.ok(problems.some(problem => problem.startsWith("occurred_at ")));
    assert.ok(problems.some(problem => problem.startsWith("app_id ")));
  });
  it("says there is no event at all", () => {
    assert.deepEqual(envelopeProblems(null, { type: "ping", app_id: null, silicon: "8HV" }), ["no event"]);
  });
});

describe("sameJson and percentile", () => {
  it("compares JSON ignoring key order, never array order", () => {
    assert.equal(sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true);
    assert.equal(sameJson({ a: [1, 2] }, { a: [2, 1] }), false);
  });
  it("takes the nearest-rank percentile", () => {
    assert.equal(percentile([5, 1, 4, 2, 3], 50), 3);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
    assert.ok(Number.isNaN(percentile([], 50)));
  });
});
