/**
 * Unit tests of the hosted pages' pure helpers (no stack, no browser). From web/:
 *
 *   pnpm exec tsx --test components/auth/test/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { carbonError, describe as lineOf } from "../flow/errors";
import { placeOf } from "../flow/model";

type Place = Parameters<typeof placeOf>[0];
const flowAt = (fields: Record<string, unknown>): Place => ({ step: "choose_method", details: null, signed_in_as: null, method_hint: null, methods: ["email", "google"], error: null, ...fields }) as unknown as Place;
const page = (id: string, index: number) => ({ id, index, count: 2, fields: [] });

test("an expired code's one line says it expired, then what to do", () => {
  const line = lineOf({ code: "code_expired", message: "The code expired.", hint: null }) ?? "";
  assert.match(line, /^This code expired\. /);
  assert.match(line, /Send a new code\.$/);
});

test("lines that stand on their own are not given the title too", () => {
  const error = { code: "verification_locked", message: "Locked.", hint: null };
  assert.equal(lineOf(error), carbonError(error).text);
});

test("flow_changed says the sign-in changed without blaming another tab (the app may have changed it)", () => {
  for (const code of ["flow_changed", "invalid_step"]) {
    const copy = carbonError({ code, message: "x" });
    assert.doesNotMatch(`${copy.title} ${copy.text}`, /another tab/i);
    assert.match(lineOf({ code, message: "x" }) ?? "", /^This sign-in moved on\. It changed while you were here/);
  }
});

test("a renamed page of the app's flow is another page, even on the same step and index", () => {
  assert.notEqual(placeOf(flowAt({ step: "details", details: page("about-you", 1) })), placeOf(flowAt({ step: "details", details: page("about-again", 1) })));
  assert.equal(placeOf(flowAt({ step: "details", details: page("about-you", 1) })), placeOf(flowAt({ step: "details", details: page("about-you", 1) })));
  assert.notEqual(placeOf(flowAt({ step: "details", details: page("contact", 0) })), placeOf(flowAt({ step: "details", details: page("contact", 1) })));
});

test("the methods step is three pages: the Opening page, Continue as, and the methods", () => {
  const opening = placeOf(flowAt({ method_hint: "google" }));
  assert.equal(opening, "opening:google");
  assert.equal(placeOf(flowAt({ method_hint: "google", error: { code: "provider_cancelled", message: "x" } })), "choose_method");
  assert.equal(placeOf(flowAt({ method_hint: "apple" })), "choose_method", "a provider the app does not offer has no Opening page");
  assert.equal(placeOf(flowAt({ signed_in_as: { uuid: "u" } })), "choose_method:account");
  assert.equal(placeOf(flowAt({ step: "review" })), "review");
  assert.equal(placeOf(null), null);
});
