import type { Locator } from "@playwright/test";
import type { Journey } from "../context";
import { DEVELOPER_SIGNED_OUT, codeFor, developerApi, lastSeq, newContext, shot, signInOnDeveloper, signInOnSite, sleep, tag } from "../lib";

const styleOf = (locator: Locator, names: string[]) =>
  locator.evaluate((element, props) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(props.map(name => [name, style.getPropertyValue(name)]));
  }, names);

export const journey: Journey = {
  name: "x-shared",
  title: "the shared behaviours: the developer site asks before unsaved work is lost from every way out (and its unknown tab is a 404), Escape and the Combobox inside layers, focus states, any-country phones, dark tokens, the account site's old /developer addresses lead to the developer site",
  async run({ env, results, browser }) {
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "x", [/no-such-tab/, DEVELOPER_SIGNED_OUT]);
    await signInOnSite(env, page, "saketdev12@example.test");
    const tab = env.engine === "webkit" ? "Alt+Tab" : "Tab";
    const back = env.engine === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";

    // 1. The navigation guard, on the developer site (where apps are edited now): briefcase's unsaved page words are
    // asked about from every way out. Signed in to the account site, the developer site's sign-in is "Continue as".
    const pages = `${env.developer}/apps/briefcase/pages`;
    await signInOnDeveloper(env, page, null, { returnTo: "/apps/briefcase/pages" });
    results.check("signed in to the account site, the developer site signs in with \"Continue as\" and returns to the page", page.url() === pages, page.url());
    const title = page.getByRole("textbox", { name: "Sign-in title", exact: true });
    await title.waitFor({ timeout: 30_000 });
    await title.fill(`Guarded ${tag()}`);
    const leave = page.getByRole("dialog", { name: "Leave with unsaved changes?" });
    await page.keyboard.press("ControlOrMeta+k");
    await sleep(300);
    await page.keyboard.type("Your apps", { delay: 20 });
    await sleep(300);
    await page.keyboard.press("Enter");
    await leave.waitFor({ timeout: 5_000 }).catch(() => undefined);
    results.check("the command palette asks before leaving unsaved changes", await leave.isVisible());
    await leave.getByRole("button", { name: "Keep editing" }).click();
    await sleep(300);
    results.check("Keep editing stays, with the draft", page.url() === pages && (await title.inputValue()).startsWith("Guarded"));
    await page.getByRole("button", { name: /^Account menu/ }).click();
    await page.getByRole("menuitem", { name: /Sign out/ }).click();
    const signOut = page.getByRole("dialog", { name: "Sign out with unsaved changes?" });
    await signOut.waitFor({ timeout: 5_000 }).catch(() => undefined);
    await sleep(400);
    await shot(env, page, "x-01-sign-out-asks");
    results.check("signing out asks, and offers discard or keep editing (no draft survives signing out)", (await signOut.isVisible()) && (await signOut.getByRole("button", { name: "Leave, keep the draft" }).count()) === 0);
    await signOut.getByRole("button", { name: "Keep editing" }).click();
    await sleep(400);
    results.check("staying keeps the developer site's session", (await developerApi(env, page, "/me")).status === 200);
    await page.getByRole("navigation", { name: "Developer site" }).getByRole("link", { name: "Apps", exact: true }).click();
    await leave.getByRole("button", { name: "Leave, keep the draft" }).click({ timeout: 5_000 });
    // The developer site's apps live at /apps now ("/" is its public home page).
    const appsList = (url: URL) => url.href === `${env.developer}/` || url.href === `${env.developer}/apps`;
    await page.waitForURL(appsList, { timeout: 10_000 });
    await page.getByRole("button", { name: "Return" }).click({ timeout: 5_000 });
    await page.waitForURL(pages, { timeout: 10_000 });
    await title.waitFor({ timeout: 10_000 });
    results.check("the top bar's Apps asks; the kept draft comes back with Return", (await title.inputValue()).startsWith("Guarded"));
    await page.keyboard.press("ControlOrMeta+k");
    await sleep(300);
    await page.keyboard.type("Your apps", { delay: 20 });
    await sleep(300);
    await page.keyboard.press("Enter");
    await leave.getByRole("button", { name: "Discard and leave" }).click({ timeout: 5_000 });
    await page.waitForURL(appsList, { timeout: 10_000 });
    results.check("Discard and leave goes on", appsList(new URL(page.url())));
    const missing = await page.goto(`${env.developer}/apps/briefcase/no-such-tab`);
    results.check("an unknown tab of an app answers 404 with the developer site's not-found page", missing?.status() === 404 && (await page.getByText("Nothing lives at this address").isVisible()), String(missing?.status()));
    // 2. A dialog (Personal info's Timezone, 2026-11-12): number keys stay put, Escape belongs to the open list first,
    // the Combobox keyboard pattern.
    await page.goto(`${env.site}/personal?edit=timezone`);
    const drawer = page.getByRole("dialog", { name: "Timezone" });
    await drawer.waitFor({ timeout: 30_000 });
    await sleep(400);
    const timezone = drawer.getByRole("combobox", { name: "Timezone" });
    results.check("timezone editor: focus is in the search and the list is closed", (await timezone.evaluate(element => element === document.activeElement)) && (await timezone.getAttribute("aria-expanded")) === "false");
    await page.keyboard.press("ArrowDown");
    await sleep(250);
    results.check("Combobox: ArrowDown opens it, and its list is no Tab stop", (await timezone.getAttribute("aria-expanded")) === "true" && (await page.getByRole("listbox").first().getAttribute("tabindex")) === "-1");
    await page.keyboard.press("Escape");
    await sleep(300);
    results.check("Escape closes only the open list; the dialog stays", (await timezone.getAttribute("aria-expanded")) === "false" && (await drawer.isVisible()));
    await page.keyboard.type("Lond", { delay: 30 });
    await sleep(250);
    results.check("typing opens the list", (await timezone.getAttribute("aria-expanded")) === "true");
    await page.keyboard.press("Tab");
    await sleep(250);
    results.check("Combobox: Tab away closes the list", (await timezone.getAttribute("aria-expanded")) === "false");
    await drawer.getByRole("button").last().focus();
    await page.keyboard.press("2");
    await sleep(400);
    results.check("a number key with a dialog open does not navigate", new URL(page.url()).pathname === "/personal");
    await page.keyboard.press("Escape");
    await sleep(500);
    results.check("the next Escape closes the dialog", !(await drawer.isVisible()));

    // 4. Keyboard focus shows on the shell's brand link and on plain links (fills and underlines, never rings).
    await page.goto(`${env.site}/`);
    const brand = page.getByRole("link", { name: "Accounts home" }).first();
    await brand.waitFor({ timeout: 30_000 });
    const brandBefore = await styleOf(brand, ["background-color"]);
    await brand.focus();
    await page.keyboard.press(back);
    await page.keyboard.press(tab);
    await sleep(400);
    results.check("the brand link shows keyboard focus", (await brand.evaluate(element => element.matches(":focus-visible"))) && JSON.stringify(await styleOf(brand, ["background-color"])) !== JSON.stringify(brandBefore));
    const seeAll = page.getByRole("navigation", { name: "Account sections" }).getByRole("link", { name: "Silicons" });
    await seeAll.waitFor({ timeout: 20_000 });
    const linkBefore = await styleOf(seeAll, ["background-color", "text-decoration-line", "outline-style"]);
    await seeAll.focus();
    await page.keyboard.press(back);
    await page.keyboard.press(tab);
    await sleep(300);
    results.check("a plain link shows keyboard focus", JSON.stringify(await styleOf(seeAll, ["background-color", "text-decoration-line", "outline-style"])) !== JSON.stringify(linkBefore));

    // 5. A phone number from a country Arc's picker does not list, added on Security's Text code dialog.
    await page.goto(`${env.site}/sign-in-methods`);
    const textCode = page.getByRole("region", { name: "Your sign-in", exact: true }).getByRole("listitem").filter({ hasText: "Text code" });
    await textCode.getByRole("button").first().click({ timeout: 30_000 });
    const phoneDialog = page.getByRole("dialog").first();
    await phoneDialog.waitFor({ timeout: 10_000 });
    // With numbers already on the account the dialog lists them first; adding is a button under the list.
    const addNumber = phoneDialog.getByRole("button", { name: "Add a Phone Number" });
    if (await addNumber.isVisible().catch(() => false)) await addNumber.click();
    await phoneDialog.getByRole("button", { name: "Enter the Country Code Yourself" }).click({ timeout: 10_000 });
    const phone = phoneDialog.getByRole("textbox", { name: "Phone number" });
    const romanian = `+40755${String(Math.floor(100000 + Math.random() * 899999))}`;
    await phone.fill(romanian);
    const after = await lastSeq(env);
    await phoneDialog.getByRole("button", { name: "Send Code" }).click();
    const code = await codeFor(env, romanian, after).catch(() => "");
    results.check("a Romanian number gets its code from the account site", /^\d{6}$/.test(code), romanian);
    if (code) {
      await sleep(400);
      await page.keyboard.type(code, { delay: 30 });
      await sleep(1500);
      const phones = (await (await page.request.get(`${env.site}/v1/me/phones`)).json()) as { items: Array<{ phone: string; verified_at: string | null }> };
      results.check("…and it is on the account, verified", phones.items.some(item => item.phone === romanian && !!item.verified_at));
    }
    await page.keyboard.press("Escape");

    // 6. Dark-theme tokens (the grey ladder, 2026-11-10; tokens.css).
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    // The browser hands colours back in its own space, so each token is compared by painting it beside the expected colour.
    const tokens = await page.evaluate(() => {
      const paint = (color: string) => {
        const probe = document.createElement("span");
        probe.style.color = color;
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      return [["var(--text-muted)", "oklch(64% 0 0)"], ["var(--text-secondary)", "oklch(77% 0 0)"], ["var(--accent-strong)", "#A9BDFF"]].map(([token, want]) => ({ token, same: paint(token!) === paint(want!), got: paint(token!) }));
    });
    results.check("dark tokens: muted oklch(64% 0 0), secondary oklch(77% 0 0), accent-strong #A9BDFF", tokens.every(item => item.same), tokens.map(item => `${item.token} ${item.got}`).join(" | "));
    // 7. The account site's old /developer addresses lead to the developer site (a 307, the tab renamed where it moved).
    const moved = await fetch(`${env.site}/developer/briefcase/branding?from=e2e`, { redirect: "manual" });
    results.check("/developer/briefcase/branding on the account site answers 307 to the developer site", moved.status === 307 && (moved.headers.get("location") ?? "").startsWith(`${env.developer}/apps/briefcase/branding`), `${moved.status} ${moved.headers.get("location")}`);
    await page.goto(`${env.site}/developer/briefcase/branding`);
    await page.waitForURL(url => url.href.startsWith(`${env.developer}/apps/briefcase/pages`), { timeout: 30_000 });
    results.check("…and the developer site shows its renamed tab (Branding is Pages now)", page.url().startsWith(`${env.developer}/apps/briefcase/pages`), page.url());
    await context.close();
  },
};
