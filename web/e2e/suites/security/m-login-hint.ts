/**
 * An app can never hand Silicon Accounts a Carbon's email or phone (UNDERSTANDING.md "Adding sign-in to an app": "The
 * Carbon always types it on our pages"): `login_hint` — and any `email` / `phone` an app adds to its link, the embed's
 * address or the SDK's options — is ignored entirely. Not prefilled, not stored with the flow, not echoed in FlowView,
 * not forwarded to Google or Apple, not carried on by the embed's buttons or the SDK's URLs.
 */
import type { Journey } from "../../context";
import { newContext, shot, sleep, sql, tag } from "../../lib";
import { brief, call, callbackOf, flowOf, flowStep, startFlow, viaSite, Jar } from "./_helpers";

interface ProviderRequest {
  provider?: string;
  endpoint?: string;
  params?: { login_hint?: string | null; [key: string]: unknown };
  [key: string]: unknown;
}

export const journey: Journey = {
  name: "security-login-hint",
  title: "login_hint is never used: an app's login_hint (and email / phone parameters) is not stored with the flow, not echoed in FlowView, not prefilled on the email or phone page, not forwarded to Google or Apple (the mock providers saw none), and neither the embed's buttons nor the SDK's URLs carry it",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = viaSite(ctx);
    const victim = `sec.hint.${tag()}${tag()}@example.test`;
    const victimPhone = `+1202555${String(1000 + Math.floor(Math.random() * 8999))}`;
    const callback = callbackOf(env, "briefcase");
    const hostile = { login_hint: victim, email: victim, phone: victimPhone, loginHint: victim };
    const contains = (text: string) => text.includes(victim) || text.includes(encodeURIComponent(victim)) || text.includes(victimPhone) || text.includes(encodeURIComponent(victimPhone)) || text.includes(victimPhone.slice(-7));

    // 1. Over HTTP: the flow the /authorize page creates, with every method button.
    const leaks: string[] = [];
    const providers: string[] = [];
    for (const method of [undefined, "email", "phone", "google", "apple"] as const) {
      const jar = new Jar();
      const created = await startFlow(t, jar, { app_id: "briefcase", redirect_uri: callback, state: `lh-${tag()}`, ...(method ? { method } : {}), ...hostile });
      const flow = flowOf(created);
      if (created.status !== 201 || !flow) {
        leaks.push(`${method ?? "no method"}: ${brief(created)}`);
        continue;
      }
      if (contains(created.text)) leaks.push(`${method ?? "no method"}: POST /v1/flows echoes it`);
      const read = await call(`${env.site}/v1/flows/${flow.id}`, { jar, ip: ctx.ip });
      if (contains(read.text)) leaks.push(`${method ?? "no method"}: GET /v1/flows/{id} echoes it`);
      const stored = await sql(env, `select row_to_json(f)::text from signin_flows f where id = '${flow.id}'`);
      if (contains(stored.map(row => row.join("|")).join("\n"))) leaks.push(`${method ?? "no method"}: stored with the flow`);
      if (method === "google" || method === "apple") {
        const leg = await flowStep(t, jar, flow.id, `oauth/${method}`);
        const authorizeUrl = String((leg.body as { authorize_url?: string } | null)?.authorize_url ?? "");
        providers.push(`${method}: ${authorizeUrl ? new URL(authorizeUrl).searchParams.has("login_hint") ? "login_hint SENT" : "no login_hint" : brief(leg)}`);
        if (!authorizeUrl || new URL(authorizeUrl).searchParams.has("login_hint") || contains(authorizeUrl)) leaks.push(`${method}: the provider address ${authorizeUrl ? "carries it" : `missing (${brief(leg)})`}`);
      }
    }
    results.check("an app's login_hint, email and phone parameters (with no method, and with each of the four method buttons) are not echoed by POST or GET /v1/flows, not stored with the flow, and never put on the Google or Apple address", leaks.length === 0, leaks.join(" | ") || providers.join("; "));

    // 2. In the browser: the app's own link with a login_hint, opening on the email field and on Google.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "login-hint");
    const base = `${env.site}/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=lh-${tag()}`;
    const withHint = `&login_hint=${encodeURIComponent(victim)}&email=${encodeURIComponent(victim)}&phone=${encodeURIComponent(victimPhone)}`;
    await page.goto(`${base}&method=email${withHint}`);
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    await sleep(500);
    const value = await field.inputValue();
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    await shot(env, page, "security-login-hint-01-email");
    results.check("the email page opened by an app's link with a login_hint has an empty field, shows no address, and the address bar dropped it", value === "" && !contains(text) && !contains(page.url()), `field "${value}"; ${contains(text) ? "the page SHOWS the address" : "nothing shown"}; at ${page.url().replace(/state=[^&]+/, "state=…").slice(0, 120)}`);
    await page.goto(`${base}&method=phone${withHint}`);
    const phoneField = page.getByRole("textbox", { name: "Phone number" });
    await phoneField.waitFor({ timeout: 30_000 });
    await sleep(500);
    const phoneValue = (await phoneField.inputValue()).replace(/\D/g, "");
    results.check("the phone page opened the same way has no number filled in (none of the app's digits)", !victimPhone.slice(-7).split("").every((digit, i) => phoneValue.slice(-7)[i] === digit) && !contains(await page.locator("body").innerText()), `field "${phoneValue}"`);
    await call(`${env.oidc}/_requests`, { method: "DELETE" });
    await page.goto(`${base}&method=google${withHint}`);
    await page.waitForURL(url => url.href.startsWith(env.oidc), { timeout: 30_000 }).catch(() => undefined);
    await sleep(500);
    const seen = await call<{ items?: ProviderRequest[] }>(`${env.oidc}/_requests?provider=google&endpoint=authorize`);
    const last = seen.body.items?.[0];
    await shot(env, page, "security-login-hint-02-google");
    results.check("the Opening page moves on to Google without the hint: the mock Google's authorize request had no login_hint and the provider page's address carries no address", !!last && (last.params?.login_hint ?? null) === null && page.url().startsWith(env.oidc) && !contains(page.url()), `${seen.body.items?.length ?? 0} authorize requests; login_hint ${JSON.stringify(last?.params?.login_hint ?? null)}; at ${page.url().slice(0, 80)}`);
    await page.goto(`${env.site}/sign-in?login_hint=${encodeURIComponent(victim)}&email=${encodeURIComponent(victim)}`);
    const ownField = page.getByRole("textbox", { name: "Email" });
    await ownField.waitFor({ timeout: 30_000 });
    await sleep(300);
    results.check("the account site's own /sign-in ignores a login_hint too (empty field)", (await ownField.inputValue()) === "", `field "${await ownField.inputValue()}"`);

    // 3. The embed and the SDK, on a page of the app's own (briefcase's allowed origin, so the embed may show).
    const appOrigin = new URL(env.apps).origin;
    const sdkPage = await context.newPage();
    const warnings: string[] = [];
    sdkPage.on("console", message => {
      if (message.type() === "warning" && /email or phone|login hint/i.test(message.text())) warnings.push(message.text().slice(0, 140));
    });
    results.watch(sdkPage, "login-hint-sdk");
    await context.route(`${appOrigin}/security-login-hint.html`, route =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>app</title><div id="buttons"></div>
<iframe id="embed" style="width:420px;height:420px;border:0" src="${env.site}/embed/v1/buttons?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=e-${tag()}&login_hint=${encodeURIComponent(victim)}&email=${encodeURIComponent(victim)}&phone=${encodeURIComponent(victimPhone)}"></iframe>
<script src="${env.site}/sdk/v1.js" data-app-id="briefcase" data-redirect-uri="${callback}" data-login-hint="${victim}" data-email="${victim}" data-target="#buttons"></script>`,
      }),
    );
    await sdkPage.goto(`${appOrigin}/security-login-hint.html`);
    await sdkPage.waitForFunction(() => !!(window as unknown as { SiliconAccounts?: unknown }).SiliconAccounts, undefined, { timeout: 20_000 }).catch(() => undefined);
    const urls = await sdkPage
      .evaluate(
        ({ callbackUrl, address, phone }) => {
          const sdk = (window as unknown as { SiliconAccounts?: { authorizeUrl: (options: Record<string, unknown>) => string } }).SiliconAccounts;
          if (!sdk) return ["no SDK"];
          const out: string[] = [];
          for (const options of [{ login_hint: address }, { loginHint: address }, { email: address, phone }, { method: "email", login_hint: address }, { method: "google", loginHint: address }]) {
            try {
              out.push(sdk.authorizeUrl({ appId: "briefcase", redirectUri: callbackUrl, state: "s", ...options }));
            } catch (error) {
              out.push(`threw ${String(error)}`);
            }
          }
          return out;
        },
        { callbackUrl: callback, address: victim, phone: victimPhone },
      )
      .catch(error => [`evaluate failed: ${String(error)}`]);
    const carried = urls.filter(url => contains(url) || /login_hint|[?&](email|phone)=/.test(url));
    results.check(`the SDK's authorizeUrl drops an app's login_hint / loginHint / email / phone options (${urls.length} calls, with and without a method) and says so on the console`, urls.length === 5 && urls.every(url => url.startsWith(`${env.site}/authorize?`)) && carried.length === 0 && warnings.length > 0, `${carried.join(" | ") || urls[0]?.replace(/state=[^&]+/, "state=…").slice(0, 140)}; ${warnings.length} warnings${warnings[0] ? ` (${warnings[0]})` : ""}`);
    let hrefs: string[] = [];
    for (let waited = 0; waited < 30 && !hrefs.length; waited++) {
      await sleep(500);
      const frame = sdkPage.frames().find(candidate => candidate.url().startsWith(`${env.site}/embed/`));
      hrefs = frame ? await frame.locator("a[href*='/authorize']").evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href)).catch(() => []) : [];
    }
    const sdkLinks = await sdkPage.evaluate(() => [...document.querySelectorAll("*")].flatMap(element => (element.shadowRoot ? [...element.shadowRoot.querySelectorAll("a[href], button[data-href]")] : [])).map(element => element.getAttribute("href") ?? element.getAttribute("data-href") ?? "")).catch(() => [] as string[]);
    await shot(env, sdkPage, "security-login-hint-03-embed-sdk");
    const embedCarried = [...hrefs, ...sdkLinks].filter(href => contains(href) || /login_hint|[?&](email|phone)=/.test(href));
    results.check("the embed opened with a login_hint, email and phone in its address shows buttons whose /authorize links carry none of them (and the SDK's rendered buttons neither)", hrefs.length > 0 && embedCarried.length === 0, `${hrefs.length} embed links, ${sdkLinks.length} SDK links; ${embedCarried.slice(0, 2).join(" | ") || hrefs[0]?.replace(/state=[^&]+/, "state=…").slice(0, 120) || "no link"}`);
    await context.close();
  },
};
