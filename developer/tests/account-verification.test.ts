import assert from "node:assert/strict";
import { test } from "node:test";
import { verificationReasonProblem } from "../lib/account-verification";
import { proxyRoute } from "../lib/server/routes";

test("account verification reasons match trimmed Unicode character limits", () => {
  assert.ok(verificationReasonProblem(" \n\t "));
  assert.equal(verificationReasonProblem(" a "), undefined);
  assert.equal(verificationReasonProblem("😀".repeat(5000)), undefined);
  assert.ok(verificationReasonProblem("😀".repeat(5001)));
  assert.equal(verificationReasonProblem("A reason\0with a NUL"), "The reason must not contain a NUL character.");
});

test("account verification uses existing protected app BFF routes", () => {
  for (const method of ["GET", "POST"]) assert.deepEqual(proxyRoute("apps/my-app/account-verification-request", method), { path: "v1/apps/my-app/account-verification-request", kind: "account" });
  assert.equal(proxyRoute("apps/my-app/../account-verification-request", "POST"), null);
});
