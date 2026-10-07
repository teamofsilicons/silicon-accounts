/** Details and flows in the editor: the flow follows the details, the browser mirrors the server's rules. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SigninFlow } from "../lib/api/types";
import { NO_SECRETS, defaultFlowOf, normalizeConfig, reconcileFlow, sectionOf, sectionPatch } from "../components/developer/lib/config";
import { flowProblems } from "../components/developer/lib/validate";

const step = (id: string, fields: SigninFlow["steps"][number]["fields"]) => ({ id, fields, title: null, subtitle: null, continue_label: null, layout: null });

test("a ticked detail joins the last page; an unticked one leaves its page; an emptied page goes", () => {
  const flow: SigninFlow = { steps: [step("contact", ["email"]), step("about", ["timezone"])], review: true };
  const added = reconcileFlow(flow, { required_fields: ["email", "phone"], optional_fields: ["timezone"] });
  assert.deepEqual(added?.steps.map(item => item.fields), [["email"], ["timezone", "phone"]]);
  const removed = reconcileFlow(flow, { required_fields: ["email"], optional_fields: [] });
  assert.deepEqual(removed?.steps.map(item => item.id), ["contact"]);
  assert.equal(removed?.review, true);
  assert.equal(reconcileFlow(flow, { required_fields: [], optional_fields: [] }), null, "nothing to ask: the default flow");
  assert.equal(reconcileFlow(null, { required_fields: ["email"], optional_fields: [] }), null, "the default flow stays the default");
  assert.equal(reconcileFlow(flow, { required_fields: ["email"], optional_fields: ["timezone"] }), flow, "unchanged details keep the same flow object");
});

test("the browser's flow rules match the server's", () => {
  const config = { required_fields: ["email" as const], optional_fields: ["timezone" as const] };
  assert.deepEqual(flowProblems({ ...config, flow: defaultFlowOf(config) }), {});
  const problems = flowProblems({ ...config, flow: { steps: [step("Bad Id", ["email", "phone"]), step("x", []), step("x", ["email"])], review: false } });
  assert.ok(problems["flow.steps[0].id"], "an id must be lowercase letters, digits and dashes");
  assert.ok(problems["flow.steps[0].fields"], "a page only holds requested details");
  assert.ok(problems["flow.steps[1].fields"], "a page asks at least one detail");
  assert.ok(problems["flow.steps[2].id"], "ids are unique");
  assert.ok(problems["flow.steps[2].fields"], "each detail is asked once");
  assert.ok(problems["flow.steps"], "every requested detail is on a page");
  const long = flowProblems({ ...config, flow: { steps: [{ ...step("a", ["email", "timezone"]), title: "x".repeat(81), continue_label: "y".repeat(31) }], review: false } });
  assert.ok(long["flow.steps[0].title"]);
  assert.ok(long["flow.steps[0].continue_label"]);
  const nine = flowProblems({ required_fields: ["email"], optional_fields: [], flow: { steps: Array.from({ length: 9 }, (_, index) => step(`p${index}`, index === 0 ? ["email"] : [])), review: false } });
  assert.match(nine["flow.steps"] ?? "", /at most 8/);
});

test("the details save group sends the flow with the details", () => {
  const base = normalizeConfig({ required_fields: ["email"], optional_fields: [], flow: { steps: [step("contact", ["email"])], review: false } });
  const draft = { ...base, required_fields: ["email" as const, "phone" as const], flow: reconcileFlow(base.flow, { required_fields: ["email", "phone"], optional_fields: [] }) };
  const patch = sectionPatch("flow", draft, base, NO_SECRETS);
  assert.deepEqual(patch.required_fields, ["email", "phone"]);
  assert.deepEqual(patch.flow?.steps.map(item => item.fields), [["email", "phone"]]);
  assert.equal(sectionOf("flow.steps[1].title"), "flow");
  assert.equal(sectionOf("copy.opening_title"), "pages");
  assert.equal(sectionOf("branding.light.primary"), "pages");
  assert.equal(sectionOf("redirect_uris[2]"), "signin");
});

test("leaving the Image background drops an image URL the server would refuse, so a hidden field never blocks saving", async () => {
  const { backgroundStyleEdits, brandingProblems } = await import("../components/developer/lib/validate");
  const { DEFAULT_BRANDING } = await import("../lib/branding/defaults");
  const typed = { ...DEFAULT_BRANDING, background_style: "image" as const, background_image_url: "http://browser.example/bg.jpg" };
  assert.match(brandingProblems(typed)["branding.background_image_url"] ?? "", /must use https/, "stopped while Image is chosen");
  const edits = backgroundStyleEdits(typed, "gradient");
  assert.deepEqual(edits, { "branding.background_style": "gradient", "branding.background_image_url": null });
  const after = { ...typed, background_style: "gradient" as const, background_image_url: null };
  assert.equal(brandingProblems(after)["branding.background_image_url"], undefined, "nothing left to block saving");
  const usable = { ...typed, background_image_url: "https://browser.example/bg.jpg" };
  assert.deepEqual(backgroundStyleEdits(usable, "dots"), { "branding.background_style": "dots" }, "a usable URL stays for coming back to Image");
  assert.deepEqual(backgroundStyleEdits(typed, "image"), { "branding.background_style": "image" }, "choosing Image keeps what was typed");
});

test("the Pages tab previews only the pages a Carbon can meet with the draft's methods", async () => {
  const { previewPages } = await import("../components/developer/lib/preview-pages");
  const labels = (methods: Partial<Record<"email" | "phone" | "google" | "apple", boolean>>, order: Array<"email" | "phone" | "google" | "apple">, extra: Record<string, unknown> = {}) =>
    previewPages(normalizeConfig({ methods: { email: false, phone: false, google: false, apple: false, ...methods }, method_order: order, ...extra })).map(option => option.label);
  // ledgerly: email, phone and Google; no Apple, so no Carbon ever sees an Opening Apple page.
  const ledgerly = labels({ email: true, phone: true, google: true }, ["email", "phone", "google"], { required_fields: ["email"], optional_fields: ["timezone"], flow: { steps: [step("contact", ["email"]), step("about", ["timezone"])], review: true } });
  assert.deepEqual(ledgerly, ["Sign in", "Sign up", "Opening Google", "Email code", "Phone code", "Set up account", "Details 1", "Details 2", "Review", "Embed buttons"]);
  // An app with only Apple: its Opening page and no code pages.
  assert.deepEqual(labels({ apple: true }, ["apple"]), ["Sign in", "Sign up", "Opening Apple", "Set up account", "What's shared (profile)", "Embed buttons"]);
  // Every method on: every page.
  assert.deepEqual(labels({ email: true, phone: true, google: true, apple: true }, ["google", "apple", "email", "phone"], { required_fields: ["email"] }), ["Sign in", "Sign up", "Opening Google", "Opening Apple", "Email code", "Phone code", "Set up account", "What's shared", "Embed buttons"]);
});
