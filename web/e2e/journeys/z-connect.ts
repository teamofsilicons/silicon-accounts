import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../context";
import { newContext, shot, sleep, tag } from "../lib";

async function connect(ctx: Ctx, page: Page, provider: "Google" | "Apple", email: string): Promise<void> {
  await page.goto(`${ctx.env.site}/sign-in-methods`);
  await page.getByRole("button", { name: `Connect ${provider}` }).click({ timeout: 30_000 });
  await page.waitForURL(new RegExp(ctx.env.oidc.replace(/[.:/]/g, "\\$&")), { timeout: 30_000 });
  await page.locator('#new-identity input[name="_auto"]').fill(email);
  await page.locator('#new-identity input[name="_name"]').fill(`Ada ${provider}`);
  await page.locator('#new-identity button[data-action="use-another"]').click();
  await page.waitForURL(/\/sign-in-methods/, { timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await sleep(800);
}

interface Me {
  emails?: Array<{ email: string; verified_at: string | null; verified_via?: string }>;
  identities?: Array<{ provider: string; email: string | null }>;
}

export const journey: Journey = {
  name: "z-connect",
  title: "connecting Google and Apple to a signed-in Carbon on Sign-in methods: the provider's email is added without a code",
  needs: ["ada"],
  async run(ctx) {
    const { env, results, browser, shared } = ctx;
    const context = await newContext(browser, { cookies: shared.ada!.cookies });
    const page = await context.newPage();
    results.watch(page, "z");
    const t = tag();
    const me = async () => (await (await page.request.get(`${env.site}/v1/me`)).json()) as Me;

    const gmail = `ada.connect.${t}@gmail.test`;
    await connect(ctx, page, "Google", gmail);
    await shot(env, page, "z-01-google");
    results.check("Google: the page says it is connected and the address is clean again", /Google is connected/.test(await page.locator("main").innerText()) && !page.url().includes("linked="), page.url());
    let now = await me();
    results.check("Google: its verified email was added without a code", !!now.emails?.some(entry => entry.email === gmail && entry.verified_via === "google"));

    const icloud = `ada.connect.${t}@icloud.test`;
    await connect(ctx, page, "Apple", icloud);
    await shot(env, page, "z-02-apple");
    now = await me();
    results.check("Apple (form_post back through the proxy): connected, its email added", /Apple is connected/.test(await page.locator("main").innerText()) && !!now.identities?.some(entry => entry.provider === "apple") && !!now.emails?.some(entry => entry.email === icloud));
    await context.close();
  },
};
