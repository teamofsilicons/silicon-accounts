/**
 * The Flows tab (UNDERSTANDING "Flows"): an app decides which pages a Carbon goes through and which details are asked on
 * which page. The owner of Silicon Interface picks two required details and two optional ones on the Details tab, then
 * (one draft, one save) builds a flow on the Flows tab: two pages, details moved between them with their menus, each
 * page's title, subtitle, button and layout, a page id, and a review page. Mistakes are stopped in place (duplicate ids,
 * a title too long, an empty page) and by the server (422 with the path of each mistake). Saved, a fresh Carbon signs
 * up through exactly those pages and the review. Pages reorder by keyboard; "Use one page" goes back to the default.
 */
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { appAccount, completeDetails, developerApi, newContext, shot, signInWithCode, sleep, startAtApp } from "../../lib";
import { appDetail, asApp, clickTab, errorCode, errorFields, freshEmail, ownerSignIn, restoreConfig, saveBarText, saveChanges } from "./_helpers";

const APP = "interface";

const cards = (page: Page) => page.getByRole("list", { name: "Pages of the flow, in order" }).getByRole("listitem").filter({ has: page.getByRole("textbox", { name: "Page id", exact: true }) });

/** Moves a detail chip to another page with its menu ("Move Date of birth" → "Move to page 2…"). */
async function moveChip(page: Page, label: string, toPage: number): Promise<void> {
  await page.getByRole("button", { name: `Move ${label}`, exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^Move to page ${toPage}\\b`) }).click();
  await sleep(250);
}

/** The details chips on a page card, in order. */
async function chips(card: Locator): Promise<string[]> {
  return card.getByRole("group", { name: /^Details asked on page \d+$/ }).getByRole("button", { name: /^Move / }).evaluateAll(buttons => buttons.map(button => (button.getAttribute("aria-label") ?? "").replace(/^Move /, "")));
}

export const journey: Journey = {
  name: "developer-site-flows",
  title: "the Flows tab: two required and two optional details (one draft with the Details tab) built into two pages with their own titles, subtitles, buttons, layouts and ids, plus a review; mistakes stopped in place and by the server with paths; saved, a fresh Carbon signs up through exactly those pages; pages reorder by keyboard; \"Use one page\" goes back",
  timeoutMs: 12 * 60_000,
  async run(ctx) {
    const { env, results, browser } = ctx;
    const before = (await appDetail(ctx, APP)).signin_config;
    const { context, page } = await ownerSignIn(ctx, APP, { label: "flows", returnTo: `/apps/${APP}/details` });
    try {
      // The details first (Details tab): email and date of birth required, phone and timezone optional.
      const details = page.getByRole("tabpanel", { name: "Details" });
      await details.getByRole("checkbox", { name: "Ask for Timezone" }).waitFor({ timeout: 30_000 });
      await details.getByRole("group", { name: "Email address: required or optional" }).getByRole("button", { name: "Required" }).click();
      await details.getByRole("checkbox", { name: "Ask for Date of birth" }).click();
      const pending = await saveBarText(page);
      const flows = await clickTab(page, "flows");
      results.check("the Flows tab shares the Details tab's draft (its unsaved dot is on Details, nothing saved yet)", /unsaved change/.test(pending) && (await page.getByRole("tab", { name: /Details/ }).getByRole("img", { name: "unsaved changes" }).count()) === 1, pending);
      const empty = (await flows.innerText()).replace(/\s+/g, " ");
      results.check("without a flow of its own: \"every detail is asked on one page\", and a button to build one", /Right now every detail is asked on one page/.test(empty) && (await flows.getByRole("button", { name: "Build your own flow" }).count()) === 1, empty.slice(0, 200));
      await flows.getByRole("button", { name: "Build your own flow" }).click();
      await cards(page).first().waitFor({ timeout: 10_000 });
      const firstChips = await chips(cards(page).first());
      results.check("Build your own flow starts as one page with every requested detail, required first", firstChips.join(",") === "Email address,Date of birth,Phone number,Timezone", firstChips.join(","));

      // A second page; date of birth and timezone move there with their menus.
      await flows.getByRole("button", { name: "Add a page" }).click();
      await cards(page).nth(1).waitFor({ timeout: 10_000 });
      const emptyPage = (await cards(page).nth(1).innerText()).replace(/\s+/g, " ");
      results.check("a new page starts empty and says it asks nothing yet", /This page asks nothing|Drag a detail here/.test(emptyPage), emptyPage.slice(0, 160));
      await moveChip(page, "Date of birth", 2);
      await moveChip(page, "Timezone", 2);
      const page1 = await chips(cards(page).nth(0));
      const page2 = await chips(cards(page).nth(1));
      results.check("each detail's menu moves it to the other page", page1.join(",") === "Email address,Phone number" && page2.join(",") === "Date of birth,Timezone", `${page1} | ${page2}`);

      // Each page's own words, layout and id; mistakes are stopped in place.
      const [first, second] = [cards(page).nth(0), cards(page).nth(1)];
      await first.getByRole("textbox", { name: "Title", exact: true }).fill("How can we reach you?");
      await first.getByRole("textbox", { name: "Subtitle", exact: true }).fill("So your Silicons can find you.");
      await first.getByRole("textbox", { name: "Continue button", exact: true }).fill("Next");
      await first.getByRole("textbox", { name: "Page id", exact: true }).fill("contact");
      await second.getByRole("textbox", { name: "Title", exact: true }).fill(`A little about you ${"and more ".repeat(10)}`);
      await second.getByRole("textbox", { name: "Continue button", exact: true }).fill("Finish");
      await second.getByRole("textbox", { name: "Page id", exact: true }).fill("Contact!");
      await second.getByRole("combobox", { name: "Layout" }).click();
      await page.getByRole("option", { name: "Split", exact: true }).click();
      await flows.getByRole("switch", { name: "Review page" }).click();
      await sleep(400);
      const secondText = (await second.innerText()).replace(/\s+/g, " ");
      const typedId = await second.getByRole("textbox", { name: "Page id", exact: true }).inputValue();
      results.check("a page id is kept to lowercase letters, digits and dashes as it is typed (\"Contact!\" → \"contact-\")", typedId === "contact-", typedId);
      await second.getByRole("textbox", { name: "Page id", exact: true }).fill("contact");
      await sleep(300);
      const blocked = await saveChanges(page);
      const blockedText = `${blocked.text} ${(await second.innerText()).replace(/\s+/g, " ")}`;
      await shot(env, page, "ds-i-01-flow-problems");
      results.check("a duplicate page id and a title over 80 characters are stopped in place, each next to its field", !blocked.saved && /already uses the id 'contact'; ids are unique/.test(blockedText) && /keep it to 80/.test(blockedText), `${blocked.text.slice(0, 160)} | ${secondText.slice(0, 120)}`);
      await second.getByRole("textbox", { name: "Title", exact: true }).fill("A little about you");
      await second.getByRole("textbox", { name: "Page id", exact: true }).fill("about-you");
      await sleep(300);
      const journeyNodes = await flows.getByRole("list", { name: "The sign-in, in order" }).innerText();
      results.check("the journey shows the pages in order, then Review, then back to the app", /How can we reach you\?[\s\S]*A little about you[\s\S]*Review[\s\S]*Back to Silicon Interface/.test(journeyNodes), journeyNodes.replace(/\s+/g, " "));
      await flows.getByRole("button", { name: "A little about you" }).click();
      await sleep(500);
      const previewLabel = await page.locator('[role="img"][aria-label^="Preview of the Silicon Interface sign-in"]').getAttribute("aria-label");
      const previewText = (await page.locator('[role="img"][aria-label^="Preview of the Silicon Interface sign-in"]').innerText()).replace(/\s+/g, " ");
      results.check("the live preview shows the page picked in the journey, with its own title and button", /Details 2: A little about you/.test(previewLabel ?? "") && /A little about you/.test(previewText) && /Finish/.test(previewText), `${previewLabel} — ${previewText.slice(0, 160)}`);
      const saved = await saveChanges(page);
      const stored = (await appDetail(ctx, APP)).signin_config;
      const steps = stored.flow?.steps ?? [];
      results.check("Save stores the details and the flow together: two pages with their words, layouts and ids, and a review", saved.saved && JSON.stringify(stored.required_fields) === JSON.stringify(["email", "dob"]) && steps.length === 2 && steps[0]?.id === "contact" && steps[0].title === "How can we reach you?" && steps[0].continue_label === "Next" && steps[0].subtitle === "So your Silicons can find you." && JSON.stringify(steps[0].fields) === JSON.stringify(["email", "phone"]) && steps[1]?.id === "about-you" && steps[1].layout === "split" && steps[1].continue_label === "Finish" && JSON.stringify(steps[1].fields) === JSON.stringify(["dob", "timezone"]) && stored.flow?.review === true, `${saved.text}; ${JSON.stringify(stored.flow)}`);

      // The server's rules, through the BFF: each mistake by its path, nothing stored.
      const version = (await appDetail(ctx, APP)).config_version;
      const nine = Array.from({ length: 9 }, (_, index) => ({ id: `p${index}`, fields: index === 0 ? ["email", "dob", "phone", "timezone"] : [] }));
      const tooMany = await developerApi(env, page, `/apps/${APP}/signin-config`, { method: "PATCH", json: { flow: { steps: nine, review: false } } });
      const unknown = await developerApi(env, page, `/apps/${APP}/signin-config`, { method: "PATCH", json: { flow: { steps: [{ id: "one", fields: ["email", "address"] }], review: false } } });
      const broken = await developerApi(env, page, `/apps/${APP}/signin-config`, { method: "PATCH", json: { flow: { steps: [{ id: "Bad Id", fields: ["email"], title: "x".repeat(81) }, { id: "two", fields: ["email", "dob", "phone", "timezone"], continue_label: "y".repeat(31) }], review: false } } });
      const fields = errorFields(broken.body);
      results.check("the server refuses nine pages (\"1 to 8\")", tooMany.status === 422 && /1 to 8/.test(errorFields(tooMany.body)["flow.steps"] ?? ""), `${tooMany.status} ${JSON.stringify(errorFields(tooMany.body)).slice(0, 200)}`);
      results.check("…a detail that does not exist, by its path (flow.steps[0].fields[1])", unknown.status === 422 && !!errorFields(unknown.body)["flow.steps[0].fields[1]"], JSON.stringify(errorFields(unknown.body)).slice(0, 200));
      results.check("…and every other mistake at once by its path: the id, a long title, a detail on two pages, a long button label", broken.status === 422 && errorCode(broken.body) === "validation_failed" && !!fields["flow.steps[0].id"] && !!fields["flow.steps[0].title"] && !!fields["flow.steps[1].fields[0]"] && !!fields["flow.steps[1].continue_label"], JSON.stringify(fields).slice(0, 400));
      results.check("…storing nothing", (await appDetail(ctx, APP)).config_version === version);

      // A fresh Carbon signs up through exactly these pages.
      const visitor = await newContext(browser);
      const hosted = await visitor.newPage();
      results.watch(hosted, "flows-hosted");
      await startAtApp(env, hosted, APP, { intent: "signup" });
      await signInWithCode(env, hosted, { email: freshEmail("flows") });
      await hosted.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
      const walk = await completeDetails(env, hosted, APP, { tick: ["timezone"], shotName: "ds-i-02-hosted" });
      const [one, two] = walk.pages;
      results.check("page 1 is \"How can we reach you?\" (Step 1 of 2, its Next button): the profile, email required, phone optional", one?.title === "How can we reach you?" && one.progress === "Step 1 of 2" && one.continueLabel === "Next" && one.rows.map(item => `${item.field}:${item.mode}`).join(",") === "profile:required,email:required,phone:optional", JSON.stringify(one ? { title: one.title, progress: one.progress, label: one.continueLabel, rows: one.rows.map(item => `${item.field}:${item.mode}`) } : null));
      results.check("page 2 is \"A little about you\" (Step 2 of 2, Finish) in its own split layout: date of birth required, timezone optional", two?.title === "A little about you" && two.progress === "Step 2 of 2" && two.continueLabel === "Finish" && two.shownLayout === "split" && two.rows.map(item => `${item.field}:${item.mode}`).join(",") === "dob:required,timezone:optional", JSON.stringify(two ? { title: two.title, progress: two.progress, label: two.continueLabel, layout: two.shownLayout, rows: two.rows.map(item => `${item.field}:${item.mode}`) } : null));
      results.check("then the review lists what is shared: the profile, email, date of birth and the ticked timezone (not the phone)", JSON.stringify(walk.review?.shared) === JSON.stringify(["profile", "email", "dob", "timezone"]), JSON.stringify(walk.review));
      const account = await appAccount(hosted);
      const member = await asApp<{ granted_scopes?: string[] }>(ctx, APP, `/v1/apps/${APP}/users/${String(account?.uuid ?? "")}`);
      results.check("…and the app gets exactly that", ["email", "dob", "timezone"].every(scope => member.body.granted_scopes?.includes(scope)) && !member.body.granted_scopes?.includes("phone"), JSON.stringify(member.body.granted_scopes));
      await visitor.close();

      // The Pages tab previews the review page: it should list what the real one lists. The preview's sample Carbon
      // leaves the optional details unticked, so the real page would list the profile and the required details only.
      await page.reload();
      const pages = await clickTab(page, "pages");
      await pages.getByRole("group", { name: "Pages" }).getByRole("button", { name: "Review", exact: true }).click();
      await sleep(600);
      const reviewPreview = page.locator('[role="img"][aria-label^="Preview of the Silicon Interface sign-in: Review"]');
      // The hosted review page (web/components/auth/steps/review.tsx) has two lists: "Shared with <app>" (the profile,
      // the required details, the optional ones ticked) and, apart, "Not shared with <app>" for what was left unticked.
      const lists = await reviewPreview.locator("ul").evaluateAll(items => items.map(list => [...list.querySelectorAll(":scope > li")].map(item => (item.textContent ?? "").replace(/\s+/g, " ").trim())));
      const reviewRows = lists[0] ?? [];
      const reviewText = (await reviewPreview.innerText()).replace(/\s+/g, " ");
      await shot(env, page, "ds-i-03-review-preview");
      results.check("the Pages tab's preview of the review is laid out like the hosted review page: the shared list holds only what is shared, and the optional details left unticked stand apart under \"Not shared with Silicon Interface\"", reviewRows.length > 0 && !reviewRows.some(text => /Not shared/.test(text)) && /Not shared with Silicon Interface/.test(reviewText), `${lists.length} list(s); first: ${reviewRows.join(" | ")}`);
      await clickTab(page, "flows");

      // Pages reorder by keyboard; "Use one page" goes back to the default.
      await cards(page).first().waitFor({ timeout: 30_000 });
      const handle = page.getByRole("button", { name: /^Move page 2 of 2/ });
      await handle.focus();
      await page.keyboard.press("ArrowUp");
      await sleep(400);
      const reordered = await saveChanges(page);
      const order = ((await appDetail(ctx, APP)).signin_config.flow?.steps ?? []).map(step => step.id).join(",");
      results.check("the arrow keys on a page's handle reorder the pages (saved: about-you, then contact)", reordered.saved && order === "about-you,contact", `${reordered.text}; ${order}`);
      await page.getByRole("button", { name: "Use one page" }).click();
      const single = await saveChanges(page);
      results.check("\"Use one page\" goes back to the default flow (flow: null)", single.saved && (await appDetail(ctx, APP)).signin_config.flow === null, single.text);
    } finally {
      await restoreConfig(ctx, APP, before);
      await context.close();
    }
  },
};
