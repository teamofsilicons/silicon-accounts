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
    await page.waitForURL(`${env.developer}/`, { timeout: 10_000 });
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
    await page.waitForURL(`${env.developer}/`, { timeout: 10_000 });
    results.check("Discard and leave goes on", page.url() === `${env.developer}/`);
    const missing = await page.goto(`${env.developer}/apps/briefcase/no-such-tab`);
    results.check("an unknown tab of an app answers 404 with the developer site's not-found page", missing?.status() === 404 && (await page.getByText("Nothing lives at this address").isVisible()), String(missing?.status()));
    await page.goto(`${env.site}/silicons`);

    // 2. A drawer: number keys stay put, Escape belongs to the open list first, the Combobox keyboard pattern.
    await page.getByRole("button", { name: "Create a Silicon" }).first().click();
    const drawer = page.getByRole("dialog", { name: "Create a Silicon" });
    await drawer.waitFor({ timeout: 10_000 });
    const timezone = drawer.getByRole("combobox", { name: "Timezone" });
    await timezone.focus();
    await sleep(250);
    results.check("Combobox: focus alone does not open the list", (await timezone.getAttribute("aria-expanded")) === "false");
    await page.keyboard.press("ArrowDown");
    await sleep(250);
    results.check("Combobox: ArrowDown opens it, and its list is no Tab stop", (await timezone.getAttribute("aria-expanded")) === "true" && (await drawer.getByRole("listbox").getAttribute("tabindex")) === "-1");
    await page.keyboard.press("Escape");
    await sleep(300);
    results.check("Escape closes only the open list; the drawer stays", (await timezone.getAttribute("aria-expanded")) === "false" && (await drawer.isVisible()));
    await page.keyboard.press("ArrowDown");
    await sleep(200);
    await page.keyboard.press("Tab");
    await sleep(250);
    results.check("Combobox: Tab away closes the list", (await timezone.getAttribute("aria-expanded")) === "false");
    await drawer.getByRole("button").last().focus();
    await page.keyboard.press("2");
    await sleep(400);
    results.check("a number key with a drawer open does not navigate", page.url() === `${env.site}/silicons`);
    await page.keyboard.press("Escape");
    await sleep(500);
    results.check("the next Escape closes the drawer", !(await drawer.isVisible()));

    // 3. The identity timezone editor: focus lands in the search, the list stays closed until asked.
    await page.goto(`${env.site}/`);
    await page.getByRole("button", { name: "Change your timezone" }).click({ timeout: 30_000 });
    const search = page.getByRole("combobox", { name: "Timezone" });
    await search.waitFor({ timeout: 5_000 });
    await sleep(400);
    results.check("timezone editor: focus is in the search and the list is closed", (await search.evaluate(element => element === document.activeElement)) && (await search.getAttribute("aria-expanded")) === "false");
    await page.keyboard.type("Lond", { delay: 30 });
    await sleep(250);
    results.check("typing opens the list", (await search.getAttribute("aria-expanded")) === "true");
    await page.keyboard.press("Escape");
    await sleep(250);
    results.check("Escape closes the list and keeps the popover", (await search.isVisible()) && (await search.getAttribute("aria-expanded")) === "false");
    await page.keyboard.press("Escape");
    await sleep(400);
    results.check("the next Escape closes the popover", !(await search.isVisible()));

    // 4. Keyboard focus shows on the shell's brand link and on plain links (fills and underlines, never rings).
    const brand = page.getByRole("link", { name: "Silicon Accounts" }).first();
    const brandBefore = await styleOf(brand, ["background-color"]);
    await brand.focus();
    await page.keyboard.press(back);
    await page.keyboard.press(tab);
    await sleep(400);
    results.check("the brand link shows keyboard focus", (await brand.evaluate(element => element.matches(":focus-visible"))) && JSON.stringify(await styleOf(brand, ["background-color"])) !== JSON.stringify(brandBefore));
    const activity = page.getByRole("link", { name: "All activity" });
    const linkBefore = await styleOf(activity, ["background-color", "text-decoration-line"]);
    await activity.focus();
    await page.keyboard.press(back);
    await page.keyboard.press(tab);
    await sleep(300);
    results.check("a plain link shows keyboard focus", JSON.stringify(await styleOf(activity, ["background-color", "text-decoration-line"])) !== JSON.stringify(linkBefore));

    // 5. A phone number from a country Arc's picker does not list, added on the account site.
    await page.goto(`${env.site}/sign-in-methods`);
    await page.getByRole("button", { name: "Add a phone number" }).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "Country not in the list?" }).click();
    const phone = page.getByRole("textbox", { name: "Phone number" });
    const romanian = `+40755${String(Math.floor(100000 + Math.random() * 899999))}`;
    await phone.fill(romanian);
    const after = await lastSeq(env);
    await page.getByRole("button", { name: "Send code" }).click();
    const code = await codeFor(env, romanian, after).catch(() => "");
    results.check("a Romanian number gets its code from the account site", /^\d{6}$/.test(code), romanian);
    if (code) {
      await sleep(400);
      await page.keyboard.type(code, { delay: 30 });
      await sleep(1500);
      const phones = (await (await page.request.get(`${env.site}/v1/me/phones`)).json()) as { items: Array<{ phone: string; verified_at: string | null }> };
      results.check("…and it is on the account, verified", phones.items.some(item => item.phone === romanian && !!item.verified_at));
    }

    // 6. Dark-theme tokens.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return [style.getPropertyValue("--text-muted"), style.getPropertyValue("--text-secondary"), style.getPropertyValue("--accent-strong")].map(value => value.trim().toUpperCase());
    });
    results.check("dark tokens: muted #B8B3AB, secondary #C2BDB5, accent-strong #93B8F1 (4.5:1 on their tracks)", JSON.stringify(tokens) === JSON.stringify(["#B8B3AB", "#C2BDB5", "#93B8F1"]), tokens.join(" "));
    // 7. The account site's old /developer addresses lead to the developer site (a 307, the tab renamed where it moved).
    const moved = await fetch(`${env.site}/developer/briefcase/branding?from=e2e`, { redirect: "manual" });
    results.check("/developer/briefcase/branding on the account site answers 307 to the developer site", moved.status === 307 && (moved.headers.get("location") ?? "").startsWith(`${env.developer}/apps/briefcase/branding`), `${moved.status} ${moved.headers.get("location")}`);
    await page.goto(`${env.site}/developer/briefcase/branding`);
    await page.waitForURL(url => url.href.startsWith(`${env.developer}/apps/briefcase/pages`), { timeout: 30_000 });
    results.check("…and the developer site shows its renamed tab (Branding is Pages now)", page.url().startsWith(`${env.developer}/apps/briefcase/pages`), page.url());
    await context.close();
  },
};
