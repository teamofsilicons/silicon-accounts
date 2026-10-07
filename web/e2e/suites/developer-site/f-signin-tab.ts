/**
 * The Sign-in tab as an app's owner (campus-connect: Google and email, only university.test addresses): methods on and
 * off and their order, redirect URIs, allowed origins and email domains (each refused in place with the reason when
 * wrong), sign up and "remember this browser", each saved with the setup's version and each followed at once by the
 * hosted pages; two editors saving over each other (the same setting: a choice; different settings: both kept); the
 * version history with who changed what, and Undo in draft. The app's setup is put back afterwards.
 */
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { api, newContext, shot, signInOnSite, signInWithCode, sleep, startAtApp, tag } from "../../lib";
import { addTag, appDetail, errorCode, ownerSignIn, patchConfig, restoreConfig, saveBarText, saveChanges } from "./_helpers";

const APP = "campus-connect";

/** POST /v1/flows as a browser on the account site would (its Origin): does the app accept this redirect URI? */
async function startFlow(ctx: Ctx, redirectUri: string): Promise<{ status: number; code: string | undefined }> {
  const answer = await api(ctx, "/v1/flows", { method: "POST", headers: { origin: ctx.env.site }, json: { app_id: APP, redirect_uri: redirectUri, state: `s-${tag()}` } });
  return { status: answer.status, code: errorCode(answer.body) };
}

/** The hosted sign-in of campus-connect in a fresh browser: where its email field and its Google button are. */
async function hostedMethods(ctx: Ctx, label: string): Promise<{ emailTop: number | null; googleTop: number | null; phoneChoice: boolean; page: Page; close: () => Promise<void> }> {
  const context = await newContext(ctx.browser);
  const page = await context.newPage();
  ctx.results.watch(page, label, [/status of 403 \(Forbidden\) @ .*\/v1\/flows\//]);
  await startAtApp(ctx.env, page, APP);
  const email = page.getByRole("textbox", { name: "Email" });
  await email.waitFor({ timeout: 30_000 });
  await sleep(600);
  const top = async (locator: ReturnType<Page["getByRole"]>) => (await locator.boundingBox().catch(() => null))?.y ?? null;
  return {
    emailTop: await top(email),
    googleTop: await top(page.getByRole("button", { name: "Continue with Google", exact: true })),
    phoneChoice: await page.getByRole("button", { name: "Phone", exact: true }).isVisible().catch(() => false),
    page,
    close: () => context.close(),
  };
}

/**
 * Types an email on the hosted methods page and continues. Returns null when a code was sent, else the refusal the page
 * shows (under the field, or as the step's alert with its error code).
 */
async function tryEmail(page: Page, email: string): Promise<string | null> {
  const field = page.getByRole("textbox", { name: "Email" });
  await field.fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await page.getByRole("group", { name: /^Code from the/ }).first().isVisible().catch(() => false)) return null;
    const alert = page.locator("[data-error-code]").first();
    if (await alert.isVisible().catch(() => false)) return `${await alert.getAttribute("data-error-code")}: ${(await alert.innerText()).replace(/\s+/g, " ")}`;
    if ((await field.getAttribute("aria-invalid").catch(() => null)) === "true") {
      const described = (await field.getAttribute("aria-describedby")) ?? "";
      const texts = await Promise.all(described.split(/\s+/).filter(Boolean).map(id => page.locator(`[id="${id}"]`).innerText().catch(() => "")));
      const message = texts.join(" ").replace(/\s+/g, " ").trim();
      if (message) return message;
    }
    await sleep(150);
  }
  return "neither a code nor a refusal within 20 s";
}

export const journey: Journey = {
  name: "developer-site-signin-tab",
  title: "the Sign-in tab: methods on, off and reordered, redirect URIs, allowed origins and email domains (refused in place when wrong), sign up and remember-the-browser, each saved and followed at once by the hosted pages; two editors saving over each other; the version history and Undo in draft",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const before = (await appDetail(ctx, APP)).signin_config;
    // The editor saves with the version it read; a 409 is how the API says someone saved in between (the browser logs it).
    const { context, page } = await ownerSignIn(ctx, APP, { label: "signin-tab", returnTo: `/apps/${APP}/sign-in`, expected: [/status of 409 \(Conflict\) @ .*\/signin-config/] });
    try {
      const panel = page.getByRole("tabpanel", { name: "Sign-in" });
      await panel.waitFor({ timeout: 30_000 });
      const methods = panel.getByRole("list", { name: "Sign-in methods, in the order they are shown" });
      await methods.waitFor({ timeout: 20_000 });
      const order = async () => (await methods.getByRole("listitem").evaluateAll(items => items.map(item => item.getAttribute("data-method") ?? ""))).join(",");
      const startOrder = await order();
      results.check("the methods are listed in the app's order (Google, Email, then the ones that are off)", startOrder.startsWith(before.method_order.filter(method => before.methods[method as keyof typeof before.methods]).join(",")), startOrder);
      const versionLabel = await panel.getByText(/^Stored version \d+$/).innerText();
      results.check("…with the stored version beside them", versionLabel === `Stored version ${(await appDetail(ctx, APP)).config_version}`, versionLabel);

      // Methods: Phone on, Email moved to the top with the keyboard.
      await panel.getByRole("switch", { name: "Phone", exact: true }).click();
      const handle = panel.getByRole("button", { name: /^Move Email, position \d of 4/ });
      await handle.focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
      await sleep(300);
      const announced = await panel.getByRole("status").filter({ hasText: /moved to position/ }).innerText().catch(() => "");
      results.check("the arrow keys move a method (announced) and the save bar counts the changes", (await order()).startsWith("email,") && /Email moved to position 1 of 4/.test(announced) && /unsaved change/.test(await saveBarText(page)), `${await order()} — ${announced} — ${await saveBarText(page)}`);
      await shot(env, page, "ds-f-01-methods-draft");
      const saved = await saveChanges(page);
      const stored = (await appDetail(ctx, APP)).signin_config;
      results.check("Save stores them: phone on, email first", saved.saved && stored.methods.phone && stored.method_order[0] === "email", `${saved.text}; ${JSON.stringify(stored.method_order)} phone=${stored.methods.phone}`);
      const hosted = await hostedMethods(ctx, "signin-tab-hosted");
      await shot(env, hosted.page, "ds-f-02-hosted-order");
      results.check("the hosted page follows at once: the email field above Continue with Google, and Email | Phone", hosted.emailTop !== null && hosted.googleTop !== null && hosted.emailTop < hosted.googleTop && hosted.phoneChoice, `email at ${hosted.emailTop}, Google at ${hosted.googleTop}, phone choice ${hosted.phoneChoice}`);

      // Allowed email domains: refused when wrong, normalized when right, enforced by the hosted page.
      const domainRefusal = await addTag(panel, "Allowed email domains", "not a domain");
      const emailRefusal = await addTag(panel, "Allowed email domains", "someone@example.org");
      results.check("a domain that is not one is refused in place, with why (and an address is told to keep only its domain)", domainRefusal.some(message => /is not a domain name like example\.com/.test(message)) && emailRefusal.some(message => /looks like an email address; enter only the part after the @/.test(message)), `${domainRefusal.join(" | ")} || ${emailRefusal.join(" | ")}`);
      await panel.getByRole("textbox", { name: "Allowed email domains", exact: true }).fill("");
      await addTag(panel, "Allowed email domains", "@Example.ORG");
      const domains = await panel.getByRole("button", { name: /^Remove / }).evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label") ?? ""));
      results.check("\"@Example.ORG\" is added as example.org", domains.includes("Remove example.org"), domains.join(" | "));
      const outsider = await tryEmail(hosted.page, `ds-outsider-${tag()}@other.test`);
      results.check("the hosted page refuses an address outside the allowed domains, naming them (other.test)", /Campus Connect only accepts email addresses at university\.test; .*other\.test is not one of them/.test(outsider ?? ""), String(outsider));
      const savedDomains = await saveChanges(page);
      await hosted.close();
      const second = await hostedMethods(ctx, "signin-tab-domains");
      const orgSent = await tryEmail(second.page, `ds-org-${tag()}@example.org`);
      results.check("saved, example.org may sign in on the hosted page (a code is sent)", savedDomains.saved && orgSent === null, `${savedDomains.text}; ${String(orgSent)}`);
      await second.close();

      // Redirect URIs: refused in place when they can't receive a sign-in; a saved one is accepted by /authorize.
      const ftp = await addTag(panel, "Redirect URIs", "ftp://files.example/callback");
      await panel.getByRole("textbox", { name: "Redirect URIs", exact: true }).fill("");
      const plainHttp = await addTag(panel, "Redirect URIs", "http://campus.example/callback");
      await panel.getByRole("textbox", { name: "Redirect URIs", exact: true }).fill("");
      const fragment = await addTag(panel, "Redirect URIs", "https://campus.example/callback#x");
      await panel.getByRole("textbox", { name: "Redirect URIs", exact: true }).fill("");
      results.check("redirect URIs that can't receive a sign-in are refused with the reason (ftp, plain http, a #fragment)", ftp.some(message => /ftp scheme, which can't receive a sign-in result/.test(message)) && plainHttp.some(message => /only https is allowed, except http:\/\/localhost/.test(message)) && fragment.some(message => /must not contain a #fragment/.test(message)), [...ftp, ...plainHttp, ...fragment].join(" | "));
      const newUri = `https://campus-${tag()}.example/auth/callback`;
      const unregistered = await startFlow(ctx, newUri);
      await addTag(panel, "Redirect URIs", newUri);
      const savedUri = await saveChanges(page);
      const registered = await startFlow(ctx, newUri);
      results.check("a new redirect URI, saved, is accepted by /authorize (before: 400 redirect_uri_not_registered)", unregistered.status === 400 && unregistered.code === "redirect_uri_not_registered" && savedUri.saved && registered.status === 201, `before ${unregistered.status} ${unregistered.code}; after ${registered.status} ${registered.code ?? ""}`);

      // Allowed origins: just scheme://host[:port]; the embed may then be framed there.
      const withPath = await addTag(panel, "Allowed origins", "https://campus.example/app");
      await panel.getByRole("textbox", { name: "Allowed origins", exact: true }).fill("");
      const origin = `https://portal-${tag()}.example`;
      await addTag(panel, "Allowed origins", `${origin}/`);
      await shot(env, page, "ds-f-02b-origin-added");
      const savedOrigin = await saveChanges(page);
      const storedOrigins = (await appDetail(ctx, APP)).signin_config.allowed_origins;
      results.check("an origin with a path is refused (\"try https://campus.example\"); a saved one is stored without its trailing slash", withPath.some(message => /without a path; try https:\/\/campus\.example/.test(message)) && savedOrigin.saved && storedOrigins.includes(origin), `${withPath.join(" | ")}; save: ${savedOrigin.text}; stored ${JSON.stringify(storedOrigins)}`);
      // The account site keeps each app's allowed origins for 30 s (web/proxy.ts), so the embed follows within that.
      const savedAt = Date.now();
      let frameAncestors = "";
      while (Date.now() - savedAt < 40_000) {
        const embed = await fetch(`${env.site}/embed/v1/buttons?app_id=${APP}`);
        frameAncestors = /frame-ancestors[^;]*/.exec(embed.headers.get("content-security-policy") ?? "")?.[0] ?? "";
        if (frameAncestors.includes(origin)) break;
        await sleep(1000);
      }
      results.metric("a saved allowed origin reaches the embed's frame-ancestors after", Date.now() - savedAt);
      results.check("…and within the account site's 30-second cache the embed may be framed there (frame-ancestors)", frameAncestors.includes(origin) && Date.now() - savedAt <= 35_000, frameAncestors);

      // Who can sign in: sign up off refuses new accounts; remember-the-browser off hides "Continue as".
      const visitor = await newContext(browser);
      const visitorPage = await visitor.newPage();
      results.watch(visitorPage, "signin-tab-visitor", [/status of 403 \(Forbidden\) @ .*\/v1\/flows\//]);
      await signInOnSite(env, visitorPage, `ds-visitor-${tag()}@university.test`);
      await startAtApp(env, visitorPage, APP);
      const offered = await visitorPage.getByRole("button", { name: /^Continue as / }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
      await panel.getByRole("switch", { name: "Allow sign up" }).click();
      await panel.getByRole("switch", { name: "Remember this browser" }).click();
      const savedRules = await saveChanges(page);
      const rules = (await appDetail(ctx, APP)).signin_config;
      await startAtApp(env, visitorPage, APP);
      await visitorPage.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
      const stillOffered = await visitorPage.getByRole("button", { name: /^Continue as / }).isVisible().catch(() => false);
      results.check("with \"Remember this browser\" on, a signed-in browser is offered Continue as; saved off, it is not", offered && savedRules.saved && !rules.remember_browser && !stillOffered, `before ${offered}, after ${stillOffered}`);
      // A new address gets its code; the sign-up is refused once the code proves it belongs to nobody.
      await visitorPage.getByRole("button", { name: "Use another account" }).click().catch(() => undefined);
      await signInWithCode(env, visitorPage, { email: `ds-newcomer-${tag()}@university.test` });
      const refusal = visitorPage.locator("[data-error-code]").first();
      const newcomer = await refusal.waitFor({ timeout: 20_000 }).then(() => refusal.getAttribute("data-error-code"), () => null);
      const refusalText = (await refusal.innerText().catch(() => "")).replace(/\s+/g, " ");
      await shot(env, visitorPage, "ds-f-03-signup-off");
      results.check("with sign up off, a new address is refused on the hosted page (signup_not_allowed), saying the app takes no new accounts", !rules.allow_signup && newcomer === "signup_not_allowed", `${String(newcomer)}: ${refusalText.slice(0, 200)}`);
      await visitor.close();

      // Two editors at once. The same setting: a choice. Different settings: both kept.
      await addTag(panel, "Allowed email domains", "mine.example");
      const theirs = await patchConfig(ctx, APP, { allowed_email_domains: ["university.test", "theirs.example"] });
      const conflicted = await saveChanges(page);
      const conflictAlert = page.locator("#signin-conflict");
      const conflictShown = await conflictAlert.waitFor({ timeout: 15_000 }).then(() => true, () => false);
      const conflictText = (await conflictAlert.innerText().catch(() => "")).replace(/\s+/g, " ");
      await shot(env, page, "ds-f-04-conflict");
      results.check("saving over someone else's change of the same setting stops with a choice (nothing saved yet)", theirs.status === 200 && !conflicted.saved && conflictShown && /You both changed/.test(conflictText) && /Allowed email domains/i.test(conflictText), `${conflicted.text} | ${conflictText.slice(0, 240)}`);
      await page.getByRole("button", { name: "Save mine on top" }).click();
      await page.getByText(/Saved as version \d+/).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
      await sleep(500);
      const mine = (await appDetail(ctx, APP)).signin_config.allowed_email_domains;
      results.check("…\"Save mine on top\" stores mine", mine.includes("mine.example") && !mine.includes("theirs.example"), JSON.stringify(mine));
      await panel.getByRole("switch", { name: "Allow sign up" }).click();
      const elsewhere = await patchConfig(ctx, APP, { google: { prompt: "consent" } });
      const merged = await saveChanges(page);
      await sleep(400);
      const notice = (await panel.getByText(/Saved on top of version \d+/).first().innerText().catch(() => "")).trim();
      const both = (await appDetail(ctx, APP)).signin_config;
      results.check("…a change of a different setting is kept under mine: both saved, and the page says what they changed", elsewhere.status === 200 && merged.saved && both.allow_signup && both.google.prompt === "consent" && /Saved on top of version/.test(notice), `${merged.text}; ${notice}; allow_signup=${both.allow_signup} prompt=${both.google.prompt}`);

      // The history: who changed what, secrets never shown; Undo puts an earlier value back into the draft.
      await panel.getByRole("button", { name: "History", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "Version history" });
      await drawer.waitFor({ timeout: 10_000 });
      await drawer.getByRole("button", { name: "Every change" }).click();
      await sleep(800);
      const historyText = (await drawer.innerText()).replace(/\s+/g, " ");
      await shot(env, page, "ds-f-05-history");
      results.check("the version history names who saved each version: the owner (c:campus-it) and the app's own server", /c:campus-it/.test(historyText) && /The app, with its secret/.test(historyText) && /Version \d+/.test(historyText), historyText.slice(0, 300));
      const versionBeforeUndo = (await appDetail(ctx, APP)).config_version;
      const undo = drawer.getByRole("button", { name: /^Undo version \d+ in your draft$/ }).first();
      await undo.click();
      await sleep(500);
      const pending = await saveBarText(page);
      results.check("Undo in draft puts the earlier values back as unsaved changes (nothing saved)", /unsaved change/.test(pending) && (await appDetail(ctx, APP)).config_version === versionBeforeUndo, pending);
      await page.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Discard" }).click();
      await sleep(600);
      results.check("…and Discard drops them again", (await saveBarText(page)) === "", await saveBarText(page));
    } finally {
      await restoreConfig(ctx, APP, before);
      await context.close();
    }
  },
};
