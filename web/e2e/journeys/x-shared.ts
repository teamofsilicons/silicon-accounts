import type { Locator } from "@playwright/test";
import type { Journey } from "../context";
import { codeFor, lastSeq, newContext, shot, signInOnSite, sleep, tag } from "../lib";

const styleOf = (locator: Locator, names: string[]) =>
  locator.evaluate((element, props) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(props.map(name => [name, style.getPropertyValue(name)]));
  }, names);

export const journey: Journey = {
  name: "x-shared",
  title: "the shared behaviours: leaving unsaved work asks from every way out, Escape and the Combobox inside layers, focus states, any-country phones, dark tokens, the 404 of an unknown tab",
  async run({ env, results, browser }) {
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "x", [/no-such-tab/]);
    await signInOnSite(env, page, "saketdev12@example.test");
    const tab = env.engine === "webkit" ? "Alt+Tab" : "Tab";
    const back = env.engine === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";

    // 1. The navigation guard: the developer editor's unsaved draft is asked about from every way out.
    await page.goto(`${env.site}/developer/briefcase/sign-in`);
    const title = page.getByRole("textbox", { name: "Title", exact: true });
    await title.waitFor({ timeout: 30_000 });
    await title.fill(`Guarded ${tag()}`);
    const leave = page.getByRole("dialog", { name: "Leave with unsaved changes?" });
    await page.keyboard.press("ControlOrMeta+k");
    await sleep(300);
    await page.keyboard.type("Apps", { delay: 20 });
    await sleep(300);
    await page.keyboard.press("Enter");
    await leave.waitFor({ timeout: 5_000 }).catch(() => undefined);
    results.check("the command palette asks before leaving unsaved changes", await leave.isVisible());
    await leave.getByRole("button", { name: "Keep editing" }).click();
    await sleep(300);
    results.check("Keep editing stays, with the draft", page.url().endsWith("/developer/briefcase/sign-in") && (await title.inputValue()).startsWith("Guarded"));
    const menu = page.locator("nav[aria-label='Account sections']").getByRole("button").last();
    await menu.click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await leave.waitFor({ timeout: 5_000 }).catch(() => undefined);
    results.check("the user menu's Settings asks", await leave.isVisible());
    await leave.getByRole("button", { name: "Keep editing" }).click();
    await sleep(300);
    await menu.click();
    await page.getByRole("menuitem", { name: /Sign out/ }).click();
    const signOut = page.getByRole("dialog", { name: "Sign out with unsaved changes?" });
    await signOut.waitFor({ timeout: 5_000 }).catch(() => undefined);
    await sleep(400);
    await shot(env, page, "x-01-sign-out-asks");
    results.check("signing out asks, and offers discard or keep editing (no draft survives signing out)", (await signOut.isVisible()) && (await signOut.getByRole("button", { name: "Leave, keep the draft" }).count()) === 0);
    await signOut.getByRole("button", { name: "Keep editing" }).click();
    await sleep(400);
    results.check("staying keeps the session", (await page.request.get(`${env.site}/v1/session`)).status() === 200);
    await page.getByRole("switch", { name: /^Phone/ }).focus();
    await page.keyboard.press("3");
    await leave.waitFor({ timeout: 5_000 }).catch(() => undefined);
    results.check("a section number key asks", await leave.isVisible());
    await page.keyboard.press("4");
    await sleep(300);
    results.check("a number key under the open question does nothing", page.url().endsWith("/developer/briefcase/sign-in"));
    await page.keyboard.press("Escape");
    await sleep(300);
    await page.getByRole("link", { name: "Your apps" }).click();
    await leave.getByRole("button", { name: "Leave, keep the draft" }).click({ timeout: 5_000 });
    await page.waitForURL(`${env.site}/developer`, { timeout: 10_000 });
    await page.getByRole("button", { name: "Return" }).click({ timeout: 5_000 });
    await page.waitForURL(/\/developer\/briefcase\/sign-in$/, { timeout: 10_000 });
    results.check("a link on the page asks; the kept draft comes back with Return", (await title.inputValue()).startsWith("Guarded"));
    await page.keyboard.press("ControlOrMeta+k");
    await sleep(300);
    await page.keyboard.type("Silicons", { delay: 20 });
    await sleep(300);
    await page.keyboard.press("Enter");
    await leave.getByRole("button", { name: "Discard and leave" }).click({ timeout: 5_000 });
    await page.waitForURL(`${env.site}/silicons`, { timeout: 10_000 });
    results.check("Discard and leave goes on", page.url() === `${env.site}/silicons`);

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

    // 6. Dark-theme tokens and 7. the 404 of an unknown developer tab.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return [style.getPropertyValue("--text-muted"), style.getPropertyValue("--text-secondary"), style.getPropertyValue("--accent-strong")].map(value => value.trim().toUpperCase());
    });
    results.check("dark tokens: muted #B8B3AB, secondary #C2BDB5, accent-strong #93B8F1 (4.5:1 on their tracks)", JSON.stringify(tokens) === JSON.stringify(["#B8B3AB", "#C2BDB5", "#93B8F1"]), tokens.join(" "));
    const missing = await page.goto(`${env.site}/developer/briefcase/no-such-tab`);
    results.check("an unknown developer tab answers 404 with the not-found page", missing?.status() === 404 && (await page.getByText("Nothing lives at this address").isVisible()), String(missing?.status()));
    await context.close();
  },
};
