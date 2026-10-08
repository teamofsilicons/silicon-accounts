/**
 * The log reading of the proof sweep journeys (../_sweep.ts) on lines in accounts-api's own format: when it started
 * listening (the last start counts, for a log that holds several), and what each "proof sweep" line says it did.
 *
 *   web/node_modules/.bin/tsx --test web/e2e/suites/proofs-perf/test/sweep.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listeningAt, logTime, parseSweepLines } from "../_sweep";

const LOG = [
  "2026-10-07T10:26:19.876397Z  INFO accounts_worker::messages: outbound message sender started delivery=\"providers\" sender=\"providers\" concurrency=8",
  "2026-10-07T10:26:19.882565Z  INFO accounts_api: Silicon Accounts is listening bind=127.0.0.1:9649 public_url=http://localhost:9650 environment=development background_tasks=9",
  "2026-10-07T10:26:25.751597Z  INFO request{method=POST route=/v1/proofs/app-verification request_id=01a115e6-6f53-751a-b061-e449d3eebe7c}: accounts_proofs::issue: App verification proof issued proof_id=01a115e6-6f56-735e-8b74-6abb3d600159 issuing_app=commit",
  "2026-10-07T10:28:19.890112Z  INFO accounts_proofs: proof sweep sign_in_revocations_recorded=3 expired_access_tokens=1 dead_family_tokens=4",
  "2026-10-07T10:30:00.000001Z  WARN accounts_proofs: proof sweep failed; retrying next hour error=pool timed out",
].join("\n");

describe("logTime", () => {
  it("reads the leading UTC timestamp to the millisecond", () => {
    assert.equal(logTime(LOG.split("\n")[1]!), Date.parse("2026-10-07T10:26:19.882Z"));
    assert.equal(logTime("2026-10-07T10:26:19Z  INFO x"), Date.parse("2026-10-07T10:26:19.000Z"));
    assert.equal(logTime("2026-10-07T10:26:19.5Z  INFO x"), Date.parse("2026-10-07T10:26:19.500Z"));
  });

  it("is null for a line that does not start with one", () => {
    assert.equal(logTime("  at accounts_api::main"), null);
    assert.equal(logTime(""), null);
  });
});

describe("listeningAt", () => {
  it("is when accounts-api began listening", () => {
    assert.equal(listeningAt(LOG), Date.parse("2026-10-07T10:26:19.882Z"));
  });

  it("takes the last start of a log that holds several, and is null without one", () => {
    const restarted = `${LOG}\n2026-10-07T11:00:00.100000Z  INFO accounts_api: Silicon Accounts is listening bind=127.0.0.1:9649`;
    assert.equal(listeningAt(restarted), Date.parse("2026-10-07T11:00:00.100Z"));
    assert.equal(listeningAt("2026-10-07T10:26:19.876397Z  INFO accounts_worker::messages: started"), null);
  });
});

describe("parseSweepLines", () => {
  it("reads what a sweep did, and skips the failure line and everything else", () => {
    const lines = parseSweepLines(LOG);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.at, Date.parse("2026-10-07T10:28:19.890Z"));
    assert.equal(lines[0]!.signInRevocationsRecorded, 3);
    assert.equal(lines[0]!.expiredAccessTokens, 1);
    assert.equal(lines[0]!.deadFamilyTokens, 4);
  });

  it("does not depend on the order of the fields", () => {
    const [line] = parseSweepLines("2026-10-07T10:28:19.890112Z  INFO accounts_proofs: proof sweep dead_family_tokens=7 expired_access_tokens=0 sign_in_revocations_recorded=2");
    assert.deepEqual([line!.signInRevocationsRecorded, line!.expiredAccessTokens, line!.deadFamilyTokens], [2, 0, 7]);
  });

  it("finds nothing in a log without a sweep", () => {
    assert.deepEqual(parseSweepLines(LOG.split("\n").slice(0, 3).join("\n")), []);
    assert.deepEqual(parseSweepLines(""), []);
  });
});
