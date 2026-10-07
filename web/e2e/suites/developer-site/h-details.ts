/**
 * The Details tab (UNDERSTANDING "What's shared with the app"): each detail an app picks is required by default and can
 * be switched to optional; required details are always shared (a missing email or phone is added with a code before
 * continuing), optional ones are a checkbox each Carbon decides, unticked until they tick it. The owner of remind ticks
 * and unticks details and switches modes, the live preview and "Where they are asked" follow the draft, the save is
 * checked against the API, and a fresh Carbon then signs in to remind through exactly those rows. With a flow of its
 * own, a ticked detail joins the last page and an emptied page goes. The server refuses a detail that is both, or one
 * that does not exist. The app's setup is put back afterwards.
 */
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { appAccount, completeDetails, developerApi, newContext, shot, signInWithCode, sleep, startAtApp } from "../../lib";
import { appDetail, asApp, errorCode, errorFields, freshEmail, openAppTab, ownerSignIn, patchConfig, restoreConfig, saveChanges } from "./_helpers";

const APP = "remind";
const LABEL: Record<string, string> = { email: "Email address", phone: "Phone number", dob: "Date of birth", timezone: "Timezone" };

/** A detail's row on the Details tab: its checkbox, its required/optional switch, its words. */
function row(panel: Locator, field: string) {
  const item = panel.getByRole("listitem").filter({ has: panel.page().getByRole("checkbox", { name: `Ask for ${LABEL[field]}` }) });
  return {
    item,
    box: item.getByRole("checkbox", { name: `Ask for ${LABEL[field]}` }),
    mode: async () => {
      if ((await item.getByRole("group", { name: `${LABEL[field]}: required or optional` }).count()) === 0) return "not asked";
      return (await item.getByRole("button", { name: "Required", exact: true }).getAttribute("aria-pressed")) === "true" ? "required" : "optional";
    },
    text: async () => (await item.innerText()).replace(/\s+/g, " "),
  };
}

const previewText = async (page: Page) => (await page.locator('[role="img"][aria-label^="Preview of the Remind sign-in"]').first().innerText().catch(() => "")).replace(/\s+/g, " ");

export const journey: Journey = {
  name: "developer-site-details",
  title: "the Details tab: a ticked detail is required by default and can be switched to optional; the preview and \"Where they are asked\" follow the draft; saved, a fresh Carbon signing in adds the required phone with a code and sees the optional details unticked; with a flow of its own a ticked detail joins the last page; the server refuses a detail that is both",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const before = (await appDetail(ctx, APP)).signin_config;
    const { context, page } = await ownerSignIn(ctx, APP, { label: "details", returnTo: `/apps/${APP}/details` });
    try {
      const panel = page.getByRole("tabpanel", { name: "Details" });
      await panel.getByRole("checkbox", { name: "Ask for Timezone" }).waitFor({ timeout: 30_000 });
      const timezone = row(panel, "timezone");
      const email = row(panel, "email");
      const phone = row(panel, "phone");
      const dob = row(panel, "dob");
      results.check("the stored details show as stored: timezone required, email optional, phone and date of birth not asked", (await timezone.mode()) === "required" && (await email.mode()) === "optional" && (await phone.mode()) === "not asked" && (await dob.mode()) === "not asked", `${await timezone.mode()} ${await email.mode()} ${await phone.mode()} ${await dob.mode()}`);
      results.check("…name, id and photo are always shared", /Name, id and profile photo .* Always shared/.test((await panel.getByRole("listitem").first().innerText()).replace(/\s+/g, " ")));

      // Ticking asks for a detail as required; it can be switched to optional; unticking stops asking.
      await dob.box.click();
      const dobRequired = await dob.mode();
      const dobRequiredText = await dob.text();
      await dob.item.getByRole("button", { name: "Optional", exact: true }).click();
      const dobOptionalText = await dob.text();
      results.check("ticking Date of birth asks for it as required by default (\"Always shared\")", dobRequired === "required" && /Always shared/.test(dobRequiredText), dobRequiredText);
      results.check("…and switching it to optional says each Carbon decides (\"Shared only if the Carbon ticks it\")", (await dob.mode()) === "optional" && /Shared only if the Carbon ticks it/.test(dobOptionalText), dobOptionalText);
      await phone.box.click();
      const phoneText = await phone.text();
      results.check("ticking Phone number makes it required, and says a Carbon without one adds one with a code", (await phone.mode()) === "required" && /adds one, with a code by SMS, before continuing/.test(phoneText), phoneText);
      await timezone.box.click();
      results.check("unticking Timezone stops asking for it (\"Not asked\")", (await timezone.mode()) === "not asked" && /Not asked/.test(await timezone.text()), await timezone.text());
      await sleep(500);
      const where = (await panel.getByRole("region", { name: "Where they are asked" }).innerText()).replace(/\s+/g, " ");
      results.check("\"Where they are asked\" follows: one page with phone, then email and date of birth (optional)", /Phone number, Email address \(optional\), Date of birth \(optional\)/.test(where), where);
      const preview = await previewText(page);
      await shot(env, page, "ds-h-01-details-draft");
      results.check("the live preview shows the draft: phone required and missing (add it to continue), the optional ones as checkboxes", /Phone number Required: add it to continue/.test(preview) && /Date of birth/.test(preview) && !/Timezone/.test(preview), preview.slice(0, 300));
      const saved = await saveChanges(page);
      const stored = (await appDetail(ctx, APP)).signin_config;
      results.check("Save stores required [phone] and optional [email, dob], with no flow of its own", saved.saved && JSON.stringify(stored.required_fields) === JSON.stringify(["phone"]) && [...stored.optional_fields].sort().join(",") === "dob,email" && stored.flow === null, `${saved.text}; ${JSON.stringify({ required: stored.required_fields, optional: stored.optional_fields, flow: stored.flow })}`);

      // A fresh Carbon signs in to remind: adds the required phone with a code, ticks only the date of birth.
      const visitor = await newContext(browser);
      const hosted = await visitor.newPage();
      results.watch(hosted, "details-hosted");
      const visitorEmail = freshEmail("details");
      const visitorPhone = `+1415555${String(Math.floor(1000 + Math.random() * 8999))}`;
      await startAtApp(env, hosted, APP);
      await signInWithCode(env, hosted, { email: visitorEmail });
      await hosted.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
      const walk = await completeDetails(env, hosted, APP, { add: { phone: visitorPhone }, tick: ["dob"], shotName: "ds-h-02-hosted" });
      const shown = walk.pages[0];
      const rowsSeen = Object.fromEntries((shown?.rows ?? []).map(item => [item.field, `${item.mode}${item.missing ? " missing" : ""}${item.ticked === null ? "" : item.ticked ? " ticked" : " unticked"}`]));
      results.check("the hosted page asks exactly what was saved: phone required (and missing), email and date of birth optional and unticked", walk.pages.length === 1 && rowsSeen.phone === "required missing" && rowsSeen.email === "optional unticked" && rowsSeen.dob === "optional unticked" && !("timezone" in rowsSeen), JSON.stringify(rowsSeen));
      results.check("…the phone is added there with a code before continuing", shown?.added.includes("phone") === true, JSON.stringify(shown?.added));
      const account = await appAccount(hosted);
      const uuid = String(account?.uuid ?? "");
      const member = await asApp<{ granted_scopes?: string[]; phone?: string | null; email?: string | null; dob?: string | null }>(ctx, APP, `/v1/apps/${APP}/users/${uuid}`);
      const scopes = member.body.granted_scopes ?? [];
      results.check("remind gets the phone (required) and the ticked date of birth, not the unticked email", !!uuid && scopes.includes("phone") && scopes.includes("dob") && !scopes.includes("email") && !member.body.email, `${member.status} scopes ${scopes.join(" ")} email=${String(member.body.email)}`);
      await visitor.close();

      // With a flow of its own: a ticked detail joins the last page; an emptied page goes.
      const flowed = await patchConfig(ctx, APP, { flow: { steps: [{ id: "contact", fields: ["phone", "email"], title: "How we reach you" }, { id: "about", fields: ["dob"], title: "About you" }], review: false } });
      results.check("(remind's server gives it a two-page flow)", flowed.status === 200, String(flowed.status));
      await openAppTab(env, page, APP, "details");
      await panel.getByRole("checkbox", { name: "Ask for Timezone" }).waitFor({ timeout: 30_000 });
      results.check("each detail says on which page it is asked (phone: page 1 of 2, date of birth: page 2 of 2)", /Asked on page 1 of 2/.test(await phone.text()) && /Asked on page 2 of 2/.test(await dob.text()), `${await phone.text()} | ${await dob.text()}`);
      await timezone.box.click();
      results.check("ticking Timezone puts it on the last page (2 of 2)", /Asked on page 2 of 2/.test(await timezone.text()), await timezone.text());
      await dob.box.click();
      await timezone.box.click();
      await sleep(400);
      const oneLeft = (await panel.getByRole("region", { name: "Where they are asked" }).innerText()).replace(/\s+/g, " ");
      results.check("unticking everything on page 2 drops that page: one page left", /Your own flow asks them on one page/.test(oneLeft), oneLeft);
      const savedFlow = await saveChanges(page);
      const reconciled = (await appDetail(ctx, APP)).signin_config.flow;
      results.check("…and the server stores that one-page flow (its title kept)", savedFlow.saved && reconciled?.steps.length === 1 && reconciled.steps[0]?.id === "contact" && reconciled.steps[0]?.title === "How we reach you", `${savedFlow.text}; ${JSON.stringify(reconciled)}`);

      // The server's own rules, through the BFF.
      const version = (await appDetail(ctx, APP)).config_version;
      const both = await developerApi(env, page, `/apps/${APP}/signin-config`, { method: "PATCH", json: { required_fields: ["email"], optional_fields: ["email"] } });
      const unknown = await developerApi(env, page, `/apps/${APP}/signin-config`, { method: "PATCH", json: { required_fields: ["address"] } });
      results.check("the server refuses a detail that is both required and optional (422, by field)", both.status === 422 && errorCode(both.body) === "validation_failed" && Object.keys(errorFields(both.body)).some(path => /optional_fields|required_fields/.test(path)), `${both.status} ${JSON.stringify(errorFields(both.body))}`);
      results.check("…and one it does not know (\"address\")", unknown.status === 422 && Object.keys(errorFields(unknown.body)).some(path => path.startsWith("required_fields")), `${unknown.status} ${JSON.stringify(errorFields(unknown.body))}`);
      results.check("…storing nothing", (await appDetail(ctx, APP)).config_version === version);
    } finally {
      await restoreConfig(ctx, APP, before);
      await context.close();
    }
  },
};
