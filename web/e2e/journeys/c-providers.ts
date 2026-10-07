import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../context";
import { appAccount, finishSignup, json, newContext, shot, sleep, tag } from "../lib";

/** The client ids the mock providers must see (testkit/dev-credentials.json). */
const MANAGED_GOOGLE = "mock-google-managed.invalid";
const ACME_GOOGLE = "mock-google-byo.invalid";
const MANAGED_APPLE = "com.teamofsilicons.accounts.dev";
const ORBIT_APPLE = "test.orbit-games.signin";

async function lastAuthorize(ctx: Ctx, provider: "google" | "apple"): Promise<string | null> {
  const { body } = await json<{ items?: Array<{ client_id?: string | null }> }>(`${ctx.env.oidc}/_requests?provider=${provider}&endpoint=authorize`);
  return body.items?.[0]?.client_id ?? null;
}

/** On the mock provider's chooser: "Use another account" with this email and name. */
async function chooseNew(ctx: Ctx, page: Page, email: string, name: string): Promise<void> {
  await page.waitForURL(new RegExp(ctx.env.oidc.replace(/[.:/]/g, "\\$&")), { timeout: 30_000 });
  await page.locator('#new-identity input[name="_auto"]').fill(email);
  await page.locator('#new-identity input[name="_name"]').fill(name);
  await page.locator('#new-identity button[data-action="use-another"]').click();
}

async function walk(ctx: Ctx, options: { app: string; provider: "Google" | "Apple"; email: string; name: string; clientId: string; label: string }): Promise<void> {
  const { env, results, browser } = ctx;
  const context = await newContext(browser);
  const page = await context.newPage();
  results.watch(page, options.label);
  const started = Date.now();
  await page.goto(`${env.apps}/${options.app}/`);
  await page.locator("#signin-hosted").click();
  const button = page.getByRole("button", { name: `Continue with ${options.provider}` });
  await button.waitFor({ timeout: 30_000 });
  await sleep(500);
  await shot(env, page, `${options.label}-methods`);
  await button.click();
  await chooseNew(ctx, page, options.email, options.name);
  const used = await lastAuthorize(ctx, options.provider === "Google" ? "google" : "apple");
  results.check(`${options.app} → ${options.provider} uses ${options.clientId === MANAGED_GOOGLE || options.clientId === MANAGED_APPLE ? "the managed client" : "the app's own client"}`, used === options.clientId, String(used));
  const signup = await finishSignup(env, page, options.app, options.label);
  results.check(`${options.app}: the sign-up page shows the provider's name and email`, signup.includes(options.email), signup.slice(0, 160));
  const account = await appAccount(page);
  results.check(`${options.app} received the account after ${options.provider}`, typeof account?.uuid === "string", `${Date.now() - started} ms`);
  await context.close();
}

export const journey: Journey = {
  name: "c-providers",
  title: "Google (managed) and Apple (managed, form_post through the proxy) via the mock providers; acme-notes with its own Google; orbit-games with its own Apple",
  async run(ctx) {
    const t = tag();
    await walk(ctx, { app: "interface", provider: "Google", email: `grace.g.${t}@gmail.test`, name: `Grace Hopper ${t}`, clientId: MANAGED_GOOGLE, label: "c-01-interface-google" });
    await walk(ctx, { app: "waveform", provider: "Apple", email: `alan.a.${t}@icloud.test`, name: `Alan Turing ${t}`, clientId: MANAGED_APPLE, label: "c-02-waveform-apple" });
    await walk(ctx, { app: "acme-notes", provider: "Google", email: `kat.j.${t}@gmail.test`, name: `Katherine Johnson ${t}`, clientId: ACME_GOOGLE, label: "c-03-acme-google" });
    await walk(ctx, { app: "orbit-games", provider: "Apple", email: `mae.j.${t}@icloud.test`, name: `Mae Jemison ${t}`, clientId: ORBIT_APPLE, label: "c-04-orbit-apple" });

    // The account site lists a Google identity of a Carbon who signed up with Google.
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "c-site");
    const email = `grace.site.${t}@gmail.test`;
    await page.goto(`${env.apps}/interface/`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: "Continue with Google" }).click({ timeout: 30_000 });
    await chooseNew(ctx, page, email, `Grace Site ${t}`);
    await finishSignup(env, page, "interface");
    await page.goto(`${env.site}/sign-in-methods`);
    await page.waitForLoadState("networkidle");
    await sleep(800);
    await shot(env, page, "c-05-sign-in-methods");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the account site lists the Google identity and its email", /Google/.test(text) && text.includes(email));
    await context.close();
  },
};
