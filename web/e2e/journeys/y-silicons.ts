import type { Page } from "@playwright/test";
import type { Journey } from "../context";
import { cli, cliHome, newContext, shot, sleep, tag } from "../lib";

/** The secret a reveal card shows (its screen-reader copy holds the plain value once it has decoded). */
async function revealed(page: Page, kind: "stk" | "whsec"): Promise<string> {
  await sleep(1800);
  const texts = await page.locator(".sr-only, [class*=srOnly]").allInnerTexts();
  return texts.map(text => text.trim()).find(text => (kind === "stk" ? /^stk-[0-9a-f]+$/.test(text) : /^whsec_/.test(text))) ?? "";
}

export const journey: Journey = {
  name: "y-silicons",
  title: "a Carbon's Silicon on the account site: created in the drawer (STK shown once), its webhook set (secret shown once), its STK rotated by holding; settings' telemetry switch",
  needs: ["ada"],
  async run({ env, results, browser, shared }) {
    const ada = shared.ada!;
    const context = await newContext(browser, { cookies: ada.cookies });
    const page = await context.newPage();
    results.watch(page, "y");
    const t = tag();
    const sid = `si:scout-${t}`;
    const stored = page.getByRole("button", { name: "I've stored it" }).first();

    await page.goto(`${env.site}/silicons`);
    await page.getByRole("button", { name: "Create a Silicon" }).first().click({ timeout: 30_000 });
    const drawer = page.getByRole("dialog", { name: "Create a Silicon" });
    await drawer.getByRole("textbox", { name: "Display name" }).fill(`Scout ${t}`);
    await drawer.getByRole("textbox", { name: "Id" }).fill(`scout-${t}`);
    await sleep(900);
    await drawer.getByRole("button", { name: "Create Silicon" }).click();
    await stored.waitFor({ timeout: 20_000 });
    const first = await revealed(page, "stk");
    await shot(env, page, "y-01-created");
    results.check("create: the generated STK is shown once", /^stk-[0-9a-f]{12}$/.test(first), first);
    results.check("…and it signs the Silicon in (CLI)", (await cli(env, cliHome(), ["login", "--silicon", sid, "--stk-stdin", "--json"], { stdin: `${first}\n` })).code === 0);
    await stored.click();
    await sleep(800);

    await page.getByRole("button", { name: new RegExp(`^Manage ${sid}`) }).click({ timeout: 10_000 });
    const sDrawer = page.getByRole("dialog").filter({ hasText: sid }).first();
    await sDrawer.getByRole("textbox", { name: "Webhook URL" }).fill(`${env.apps}/hooks/scout-${t}`);
    await sDrawer.getByRole("button", { name: "Set webhook" }).click();
    await stored.waitFor({ timeout: 20_000 });
    const secret = await revealed(page, "whsec");
    await shot(env, page, "y-02-webhook");
    results.check("set webhook: the signing secret is shown once", /^whsec_/.test(secret));
    await stored.click();
    await sleep(600);

    const hold = sDrawer.getByRole("button", { name: "Hold to rotate the STK" });
    await hold.scrollIntoViewIfNeeded();
    const box = await hold.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(2600);
      await page.mouse.up();
    }
    await stored.waitFor({ timeout: 20_000 });
    const second = await revealed(page, "stk");
    results.check("rotate: a new STK is shown once", /^stk-[0-9a-f]{12}$/.test(second) && second !== first, second);
    const old = await cli(env, cliHome(), ["login", "--silicon", sid, "--stk-stdin", "--json"], { stdin: `${first}\n` });
    const fresh = await cli(env, cliHome(), ["login", "--silicon", sid, "--stk-stdin", "--json"], { stdin: `${second}\n` });
    results.check("the old STK is dead and the new one signs in", old.code !== 0 && fresh.code === 0, `${old.code}/${fresh.code}`);
    await stored.click();
    await page.keyboard.press("Escape");
    await sleep(500);

    await page.goto(`${env.site}/settings`);
    const telemetry = page.getByRole("switch").first();
    await telemetry.waitFor({ timeout: 30_000 });
    const was = await telemetry.getAttribute("aria-checked");
    await telemetry.click();
    await sleep(500);
    const cookie = (await context.cookies(env.site)).find(entry => entry.name === "sa_telemetry");
    results.check("settings: turning telemetry off sets sa_telemetry=off", was !== "true" || cookie?.value === "off", `${was} → ${cookie?.value}`);
    if (was === "true") await telemetry.click();
    await context.close();
  },
};
