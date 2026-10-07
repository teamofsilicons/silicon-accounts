/**
 * login_hint is ignored everywhere (UNDERSTANDING.md "Adding sign-in to an app": "An app can never take in a Carbon's
 * email or phone number itself and send it to us for verification. The Carbon always types it on our pages"; build
 * spec 06-v2.md §5: login_hint is ignored entirely: not prefilled, not forwarded to Google/Apple, not echoed in
 * FlowView; the SDK and the embed drop any email/phone options).
 *
 * The hosted pages (with and without a direct button, email, phone, Google, Apple), the flow API itself (accepted,
 * neither stored nor echoed), the account site's own /sign-in, the developer site's /auth/sign-in, the SDK
 * (authorizeUrl, signIn, a data-login-hint attribute) and the embed.
 */
import type { Journey } from "../../context";
import { api, json, live, newContext, startAtApp, sql, type Env } from "../../lib";
import { flowIdOf, freshEmail, freshPhone, waitForFlow } from "./_helpers";

/** The newest authorize request a mock provider got. */
async function lastAuthorize(env: Env, provider: "google" | "apple"): Promise<{ params?: Record<string, unknown>; outcome?: string; selected_by?: string | null } | null> {
  const { body } = await json<{ items?: Array<{ params?: Record<string, unknown>; outcome?: string; selected_by?: string | null }> }>(`${env.oidc}/_requests?provider=${provider}&endpoint=authorize`);
  return body.items?.[0] ?? null;
}

export const journey: Journey = {
  name: "v2-flows-login-hint",
  title: "login_hint is ignored everywhere: never prefilled (email, phone, direct buttons), never stored or echoed by the flow API, never forwarded to Google or Apple, dropped by /sign-in, the developer site, the SDK and the embed",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const known = freshEmail("hint-known");
    const phone = await freshPhone(env);
    const context = await newContext(browser);
    const page = await context.newPage();
    const warnings: string[] = [];
    page.on("console", message => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    results.watch(page, "login-hint");

    // The hosted page with a login_hint: nothing prefilled, nothing echoed.
    const href = await startAtApp(env, page, "briefcase", { extra: { login_hint: known } });
    const flow = await waitForFlow(page, f => f.step === "choose_method", "briefcase's methods page");
    const email = page.getByRole("textbox", { name: "Email" });
    await email.waitFor({ timeout: 30_000 });
    results.check("briefcase's link with login_hint=<an email>: the email field is empty", href.searchParams.get("login_hint") === known && (await email.inputValue()) === "", `field "${await email.inputValue()}"`);
    const raw = JSON.stringify(flow);
    results.check("…the flow neither has a login_hint nor mentions the address", !("login_hint" in flow) && !raw.includes(known), raw.slice(0, 200));
    const id = flowIdOf(page)!;
    const stored = await sql(env, `select coalesce(provider_state::text, '') from signin_flows where id = '${id}'`);
    results.check("…and the stored flow does not keep it", !(stored[0]?.[0] ?? "").includes(known), (stored[0]?.[0] ?? "").slice(0, 200));

    await startAtApp(env, page, "briefcase", { method: "email", extra: { login_hint: known } });
    await waitForFlow(page, f => f.step === "choose_method" && f.method_hint === "email", "the email page");
    await email.waitFor({ timeout: 30_000 });
    results.check("Continue with email plus login_hint: the email field still empty", (await email.inputValue()) === "", `field "${await email.inputValue()}"`);

    await startAtApp(env, page, "briefcase", { method: "phone", extra: { login_hint: phone } });
    await waitForFlow(page, f => f.step === "choose_method" && f.method_hint === "phone", "the phone page");
    const phoneField = page.getByRole("textbox", { name: "Phone number" });
    await phoneField.waitFor({ timeout: 30_000 });
    const typed = await live(page, "main input").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value).filter(Boolean));
    results.check("Continue with phone number plus login_hint=<a phone>: the phone field empty, the number nowhere on the page", (await phoneField.inputValue()) === "" && !typed.some(value => value.replace(/\D/g, "").endsWith(phone.slice(-7))), `field "${await phoneField.inputValue()}", inputs ${JSON.stringify(typed)}`);

    // Google and Apple never get it.
    for (const [app, provider] of [["briefcase", "google"], ["waveform", "apple"]] as const) {
      await startAtApp(env, page, app, { method: provider, extra: { login_hint: known } });
      await page.waitForURL(url => url.href.startsWith(env.oidc), { timeout: 30_000 });
      const asked = await lastAuthorize(env, provider);
      results.check(`${app} → ${provider === "google" ? "Google" : "Apple"} with login_hint: the provider gets no login_hint and shows its chooser`, asked?.params?.login_hint === null && asked.outcome === "chooser_shown", JSON.stringify(asked).slice(0, 300));
    }

    // The flow API itself: accepted, not echoed, not stored.
    const created = await api<{ flow?: Record<string, unknown> & { id?: string } }>(ctx, "/v1/flows", {
      method: "POST",
      headers: { origin: env.site },
      json: { app_id: "briefcase", redirect_uri: href.searchParams.get("redirect_uri"), response_type: "code", state: `v2f-${Date.now()}`, login_hint: known },
    });
    const createdId = created.body.flow?.id ?? "";
    const createdRow = createdId ? await sql(env, `select coalesce(provider_state::text, '') from signin_flows where id = '${createdId}'`) : [];
    results.check("POST /v1/flows with login_hint: 201, and neither the answer nor the stored flow has it", created.status === 201 && !JSON.stringify(created.body).includes(known) && !("login_hint" in (created.body.flow ?? {})) && !(createdRow[0]?.[0] ?? "").includes(known), `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);

    // The account site's own sign-in.
    await page.goto(`${env.site}/sign-in?login_hint=${encodeURIComponent(known)}`);
    await page.waitForURL(url => url.pathname.startsWith("/authorize"), { timeout: 30_000 });
    const ownEmail = page.getByRole("textbox", { name: "Email" });
    const ownShown = await ownEmail.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    results.check("the account site's /sign-in?login_hint=…: no login_hint on the way to /authorize, the field empty", !page.url().includes("login_hint") && (!ownShown || (await ownEmail.inputValue()) === ""), `${page.url().slice(0, 160)} field "${ownShown ? await ownEmail.inputValue() : "(signed in: Continue as)"}"`);

    // The developer site's sign-in.
    const developer = await page.request.get(`${env.developer}/auth/sign-in?login_hint=${encodeURIComponent(known)}&return_to=%2F`, { maxRedirects: 0 });
    const location = developer.headers()["location"] ?? "";
    results.check("the developer site's /auth/sign-in?login_hint=…: its redirect to /authorize carries no login_hint", developer.status() === 303 && location.includes("/authorize?") && !location.includes("login_hint") && !location.includes(encodeURIComponent(known)), `${developer.status()} ${location.slice(0, 200)}`);

    // The SDK (quill-docs' page loads it): every way of passing an email or phone is dropped, with a warning.
    await page.goto(`${env.apps}/quill-docs/?only=sdk`);
    await page.locator("#silicon-accounts").getByRole("button").first().waitFor({ timeout: 20_000 });
    const urls = await page.evaluate(([address, number]) => {
      const sdk = (window as unknown as { SiliconAccounts: { authorizeUrl: (options: Record<string, unknown>) => string } }).SiliconAccounts;
      return [sdk.authorizeUrl({ loginHint: address }), sdk.authorizeUrl({ login_hint: address, email: address, phone: number }), sdk.authorizeUrl({ method: "email", loginHint: address })];
    }, [known, phone] as const);
    results.check("SDK authorizeUrl({loginHint}), ({login_hint, email, phone}), ({method: email, loginHint}): no hint, email or phone in the URL", urls.every(url => !/login_hint|[?&]email=|[?&]phone=/.test(url) && !url.includes(encodeURIComponent(known)) && !url.includes(known)), JSON.stringify(urls.map(url => url.slice(0, 120))));
    results.check("…with one console warning that the email or phone is ignored", warnings.filter(text => /ignored/.test(text) && /email or phone/.test(text)).length === 1, JSON.stringify(warnings));
    const navigated = page.waitForRequest(request => request.isNavigationRequest() && request.url().startsWith(`${env.site}/authorize`), { timeout: 30_000 });
    await page.evaluate(address => {
      void (window as unknown as { SiliconAccounts: { signIn: (options: Record<string, unknown>) => Promise<void> } }).SiliconAccounts.signIn({ loginHint: address, method: "email" });
    }, known);
    const signInUrl = (await navigated).url();
    results.check("SDK signIn({loginHint, method: email}) goes to /authorize without it", !signInUrl.includes("login_hint") && !signInUrl.includes(encodeURIComponent(known)), signInUrl.slice(0, 200));
    await waitForFlow(page, f => f.step === "choose_method", "quill-docs' email page");
    const sdkEmail = page.getByRole("textbox", { name: "Email" });
    await sdkEmail.waitFor({ timeout: 30_000 });
    results.check("…and the page opens with the email field empty", (await sdkEmail.inputValue()) === "", `field "${await sdkEmail.inputValue()}"`);

    // A data-login-hint attribute on the script tag: warned about, never used.
    const tagWarnings = warnings.length;
    await page.goto(`${env.apps}/quill-docs/?only=sdk`);
    await page.locator("#silicon-accounts").getByRole("button").first().waitFor({ timeout: 20_000 });
    await page.evaluate(([site, address]) => {
      const holder = document.createElement("div");
      holder.id = "v2f-hinted";
      document.body.append(holder);
      const original = document.querySelector('script[src$="/sdk/v1.js"]');
      const script = document.createElement("script");
      for (const attribute of [...(original?.attributes ?? [])]) if (attribute.name.startsWith("data-")) script.setAttribute(attribute.name, attribute.value);
      script.setAttribute("data-target", "#v2f-hinted");
      script.setAttribute("data-login-hint", address);
      script.src = `${site}/sdk/v1.js?v2f=hint`;
      document.body.append(script);
    }, [env.site, known] as const);
    const hinted = page.locator("#v2f-hinted").getByRole("button", { name: "Continue with email" });
    await hinted.waitFor({ timeout: 20_000 });
    const hintedNavigation = page.waitForRequest(request => request.isNavigationRequest() && request.url().startsWith(`${env.site}/authorize`), { timeout: 30_000 });
    await hinted.click();
    const hintedUrl = (await hintedNavigation).url();
    results.check("a script tag with data-login-hint: a warning, and its buttons go to /authorize without the hint", warnings.length > tagWarnings && !hintedUrl.includes("login_hint") && !hintedUrl.includes(encodeURIComponent(known)), `${JSON.stringify(warnings.slice(tagWarnings))} ${hintedUrl.slice(0, 160)}`);

    // The embed: a login_hint in the iframe's address is not passed on by its buttons.
    await page.goto(`${env.apps}/pixel-studio/?only=iframe`);
    await page.evaluate(address => {
      const frame = document.getElementById("signin-iframe") as HTMLIFrameElement;
      frame.src = `${frame.src}&login_hint=${encodeURIComponent(address)}`;
    }, known);
    const frame = page.frameLocator("#signin-iframe");
    await frame.getByRole("link", { name: "Continue with email" }).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(500);
    const frameSrc = (await page.locator("#signin-iframe").getAttribute("src")) ?? "";
    const hrefs = await frame.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href") ?? ""));
    results.check("the embed with login_hint in its address: none of its buttons carries it", frameSrc.includes("login_hint") && hrefs.filter(link => link.includes("/authorize")).length >= 3 && hrefs.every(link => !link.includes("login_hint") && !link.includes(encodeURIComponent(known))), `${hrefs.map(link => link.slice(0, 90)).join(" | ")}`);
    await context.close();
  },
};
