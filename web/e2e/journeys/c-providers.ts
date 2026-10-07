import type { Ctx, Journey } from "../context";
import { POWERED_BY_HREF, appAccount, chooseMockIdentity, finishSignup, hostedTitle, json, live, methodButton, newContext, readFlow, shot, sleep, startAtApp, tag, waitForOpening } from "../lib";

/** The client ids the mock providers must see (testkit/dev-credentials.json, testkit/fake-apps.json). */
const MANAGED_GOOGLE = "mock-google-managed.invalid";
const ACME_GOOGLE = "mock-google-byo.invalid";
const MANAGED_APPLE = "com.teamofsilicons.accounts.dev";
const ORBIT_APPLE = "test.orbit-games.signin";

async function lastAuthorize(ctx: Ctx, provider: "google" | "apple"): Promise<string | null> {
  const { body } = await json<{ items?: Array<{ client_id?: string | null }> }>(`${ctx.env.oidc}/_requests?provider=${provider}&endpoint=authorize`);
  return body.items?.[0]?.client_id ?? null;
}

/** The app's "Sign in with Silicon Accounts" link, then "Continue with Google/Apple" on the methods page. */
async function walk(ctx: Ctx, options: { app: string; provider: "google" | "apple"; email: string; name: string; clientId: string; label: string }): Promise<void> {
  const { env, results, browser } = ctx;
  const context = await newContext(browser);
  const page = await context.newPage();
  results.watch(page, options.label);
  const started = Date.now();
  const name = options.provider === "google" ? "Google" : "Apple";
  await startAtApp(env, page, options.app);
  const button = methodButton(page, options.provider);
  await button.waitFor({ timeout: 30_000 });
  await sleep(500);
  await shot(env, page, `${options.label}-methods`);
  await button.click();
  await chooseMockIdentity(env, page, options.email, options.name);
  const used = await lastAuthorize(ctx, options.provider);
  results.check(`${options.app} → ${name} uses ${options.clientId === MANAGED_GOOGLE || options.clientId === MANAGED_APPLE ? "the managed client" : "the app's own client"}`, used === options.clientId, String(used));
  const signup = await finishSignup(env, page, options.app, options.label);
  results.check(`${options.app}: the sign-up page shows the provider's name and email`, signup.includes(options.email), signup.slice(0, 160));
  const account = await appAccount(page);
  results.check(`${options.app} received the account after ${name}`, typeof account?.uuid === "string", `${Date.now() - started} ms`);
  await context.close();
}

/**
 * The app's own direct "Continue with Google/Apple" button: the Opening page first ("Opening Google to sign you in to
 * Briefcase…", in the app's style, "Powered by Silicon Accounts" at the bottom), then the provider by itself.
 */
async function direct(ctx: Ctx, options: { app: string; provider: "google" | "apple"; email: string; name: string; title: string; label: string; font?: RegExp; background?: string }): Promise<void> {
  const { env, results, browser } = ctx;
  const context = await newContext(browser);
  const page = await context.newPage();
  results.watch(page, options.label);
  const name = options.provider === "google" ? "Google" : "Apple";
  const href = await startAtApp(env, page, options.app, { method: options.provider });
  results.check(`${options.app}'s own "Continue with ${name}" asks the hosted pages for method=${options.provider}`, href.searchParams.get("method") === options.provider, href.search.slice(0, 160));
  const opening = await waitForOpening(env, page, options.provider, { shotName: `${options.label}-opening` });
  results.check(`${options.app}: the Opening page says "${options.title}"`, opening.title === options.title, opening.title);
  results.check(`${options.app}: the Opening page offers "Continue to ${name}" in case it does not move on`, opening.fallback);
  if (options.font || options.background) {
    results.check(`${options.app}: the Opening page is drawn in the app's own style`, (!options.font || options.font.test(opening.headingFont)) && (!options.background || opening.background === options.background), `${opening.headingFont} on ${opening.background}`);
  }
  results.check(`${options.app}: the Opening page keeps "Powered by Silicon Accounts" (in view, linking to accounts.teamofsilicons.com)`, opening.poweredBy.inView && opening.poweredBy.href === POWERED_BY_HREF && /Powered by/.test(opening.poweredBy.text), `${opening.poweredBy.href} ${opening.poweredBy.text}`);
  results.check(`${options.app}: the Opening page moves on to ${name} by itself`, opening.movedAfterMs !== null && opening.movedAfterMs >= 300 && opening.movedAfterMs < 10_000, `${opening.movedAfterMs} ms after it showed`);
  if (opening.movedAfterMs !== null) results.metric(`${options.app} Opening page → ${name}`, opening.movedAfterMs);
  await chooseMockIdentity(env, page, options.email, options.name);
  await finishSignup(env, page, options.app);
  const account = await appAccount(page);
  results.check(`${options.app} received the account after the Opening page and ${name}`, typeof account?.uuid === "string", JSON.stringify(account).slice(0, 120));
  await context.close();
}

export const journey: Journey = {
  name: "c-providers",
  title: "Google and Apple: managed (Apple's form_post through the proxy) and each app's own (acme-notes, orbit-games); the apps' direct buttons: the Opening page before Google and Apple, email and phone opening on their empty field",
  async run(ctx) {
    const t = tag();
    await walk(ctx, { app: "interface", provider: "google", email: `grace.g.${t}@gmail.test`, name: `Grace Hopper ${t}`, clientId: MANAGED_GOOGLE, label: "c-01-interface-google" });
    await walk(ctx, { app: "waveform", provider: "apple", email: `alan.a.${t}@icloud.test`, name: `Alan Turing ${t}`, clientId: MANAGED_APPLE, label: "c-02-waveform-apple" });
    await walk(ctx, { app: "acme-notes", provider: "google", email: `kat.j.${t}@gmail.test`, name: `Katherine Johnson ${t}`, clientId: ACME_GOOGLE, label: "c-03-acme-google" });
    await walk(ctx, { app: "orbit-games", provider: "apple", email: `mae.j.${t}@icloud.test`, name: `Mae Jemison ${t}`, clientId: ORBIT_APPLE, label: "c-04-orbit-apple" });

    // The apps' own direct buttons: the Opening page, by default and in the app's own words.
    await direct(ctx, { app: "briefcase", provider: "google", email: `dorothy.v.${t}@gmail.test`, name: `Dorothy Vaughan ${t}`, title: "Opening Google to sign you in to Briefcase…", label: "c-05-briefcase-direct-google" });
    await direct(ctx, { app: "waveform", provider: "apple", email: `hedy.l.${t}@icloud.test`, name: `Hedy Lamarr ${t}`, title: "Opening Apple to sign you in to Waveform…", label: "c-06-waveform-direct-apple" });
    await direct(ctx, { app: "acme-notes", provider: "google", email: `mary.j.${t}@gmail.test`, name: `Mary Jackson ${t}`, title: "Taking you to Google for Acme Notes…", label: "c-07-acme-direct-google", font: /Fraunces/, background: "#16130F" });

    const { env, results, browser } = ctx;
    // Direct email and phone buttons: the hosted page opens on that method's field, empty, with the others one click away.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "c-direct-contact");
      for (const method of ["email", "phone"] as const) {
        await startAtApp(env, page, "briefcase", { method });
        const field = page.getByRole("textbox", { name: method === "email" ? "Email" : "Phone number" });
        await field.waitFor({ timeout: 30_000 });
        await sleep(500);
        await shot(env, page, `c-08-briefcase-direct-${method}`);
        const value = await field.inputValue();
        const others = (await methodButton(page, "google").count()) + (await methodButton(page, "apple").count());
        results.check(`briefcase's "Continue with ${method === "email" ? "email" : "phone number"}" opens on that field, empty, without the other methods`, value.replace(/[\s+]/g, "") === "" && others === 0, `value "${value}", ${others} provider buttons`);
        await page.getByRole("button", { name: "Other ways to sign in" }).click({ timeout: 10_000 });
        await methodButton(page, "google").waitFor({ timeout: 10_000 });
        results.check(`…"Other ways to sign in" shows every method briefcase offers`, (await methodButton(page, "apple").count()) === 1 && (await live(page, "main").first().innerText()).includes("Email"), await hostedTitle(page));
      }
      // An app can never hand over a Carbon's email: a login_hint in its link is ignored entirely.
      const hint = `someone.else.${t}@example.test`;
      await startAtApp(env, page, "briefcase", { method: "email", extra: { login_hint: hint } });
      const field = page.getByRole("textbox", { name: "Email" });
      await field.waitFor({ timeout: 30_000 });
      await sleep(500);
      const flow = await readFlow(page);
      results.check("a login_hint in the app's link is ignored: the email field stays empty and the flow never mentions it", (await field.inputValue()) === "" && !!flow && !JSON.stringify(flow).includes(hint) && !("login_hint" in flow), `field "${await field.inputValue()}", flow ${JSON.stringify(flow).slice(0, 120)}`);
      await context.close();
    }

    // The account site lists a Google identity of a Carbon who signed up with Google.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "c-site");
    const email = `grace.site.${t}@gmail.test`;
    await startAtApp(env, page, "interface");
    await methodButton(page, "google").click({ timeout: 30_000 });
    await chooseMockIdentity(env, page, email, `Grace Site ${t}`);
    await finishSignup(env, page, "interface");
    await page.goto(`${env.site}/sign-in-methods`);
    await page.waitForLoadState("networkidle");
    await sleep(800);
    await shot(env, page, "c-09-sign-in-methods");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the account site lists the Google identity and its email", /Google/.test(text) && text.includes(email));
    await context.close();
  },
};
