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
  title: "a Carbon's Silicon on the account site: created on /silicons/new (STK shown once on its page), its webhook set (secret shown once), its key changed in a dialog; settings' telemetry switch",
  needs: ["ada"],
  async run({ env, results, browser, shared }) {
    const ada = shared.ada!;
    const context = await newContext(browser, { cookies: ada.cookies });
    const page = await context.newPage();
    results.watch(page, "y");
    const t = tag();
    const sid = `si:scout-${t}`;
    const stored = page.getByRole("button", { name: "I've stored it" }).first();

    // Create a Silicon is a page in three steps (Name and id, Timezone, STK); it opens the new Silicon's page, where its
    // STK is shown once.
    await page.goto(`${env.site}/silicons/new`);
    await page.getByRole("textbox", { name: "Name" }).fill(`Scout ${t}`, { timeout: 30_000 });
    await page.getByRole("textbox", { name: "Id" }).fill(sid);
    await sleep(900);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 10_000 });
    // Create Silicon ignores a press right after its step opens (ARRIVAL_PAUSE: a double-click never creates one).
    await sleep(900);
    await page.getByRole("button", { name: "Create Silicon", exact: true }).click({ timeout: 10_000 });
    await page.waitForURL(url => /^\/silicons\/(?!new$)[^/]+$/.test(url.pathname), { timeout: 20_000 });
    await stored.waitFor({ timeout: 20_000 });
    const first = await revealed(page, "stk");
    await shot(env, page, "y-01-created");
    results.check("create: the generated STK is shown once", /^stk-[0-9a-f]{12}$/.test(first), first);
    results.check("…and it signs the Silicon in (CLI)", (await cli(env, cliHome(), ["login", "--silicon", sid, "--stk-stdin", "--json"], { stdin: `${first}\n` })).code === 0);
    await stored.click();
    await sleep(800);

    // Its page, Access tab: the webhook (Set, in a dialog), then the secret key (Change, in a dialog).
    const webhook = page.getByRole("region", { name: "Webhook", exact: true });
    await webhook.getByRole("button", { name: "Set", exact: true }).click({ timeout: 10_000 });
    const setDialog = page.getByRole("dialog", { name: "Set a webhook" });
    await setDialog.getByRole("textbox", { name: "Webhook URL" }).fill(`${env.apps}/hooks/scout-${t}`);
    await setDialog.getByRole("button", { name: "Set Webhook" }).click();
    await stored.waitFor({ timeout: 20_000 });
    const secret = await revealed(page, "whsec");
    await shot(env, page, "y-02-webhook");
    results.check("set webhook: the signing secret is shown once", /^whsec_/.test(secret));
    await stored.click();
    await sleep(600);

    await page.getByRole("region", { name: "Secret key", exact: true }).getByRole("button", { name: "Change", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Change Key" }).click({ timeout: 10_000 });
    await stored.waitFor({ timeout: 20_000 });
    const second = await revealed(page, "stk");
    results.check("change the key: a new STK is shown once", /^stk-[0-9a-f]{12}$/.test(second) && second !== first, second);
    const old = await cli(env, cliHome(), ["login", "--silicon", sid, "--stk-stdin", "--json"], { stdin: `${first}\n` });
    const fresh = await cli(env, cliHome(), ["login", "--silicon", sid, "--stk-stdin", "--json"], { stdin: `${second}\n` });
    results.check("the old STK is dead and the new one signs in", old.code !== 0 && fresh.code === 0, `${old.code}/${fresh.code}`);
    await stored.click();
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
