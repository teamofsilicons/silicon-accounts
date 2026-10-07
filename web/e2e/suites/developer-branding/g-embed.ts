/**
 * The iframe embed of `browser` (its owner signs in): the snippet from the Embed tab, pasted into a page on the
 * app's allowed origin, shows the app's buttons in its order with "Powered by", sizes itself to them and sends the
 * whole window to the hosted sign-in; the same snippet on any other origin is blocked by the browser
 * (frame-ancestors). A Carbon signs up through the fake app's own iframe end to end. Then the owner's allowed origins
 * drive the policy: none → frame-ancestors 'none' (+ X-Frame-Options DENY), the page explains it when opened on its
 * own, the Embed tab warns; a new origin → that origin may frame it (after the site's short policy cache).
 */
import type { BrowserContext, Frame, Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { codeFor, json, lastSeq, newContext, shot, sleep, tag } from "../../lib";
import { asSession, checkPoweredBy, checkPoweredByHost, fakeApp, freshEmail, hostPage, htmlPage, ownerSignIn } from "./_helpers";

const APP = "browser";

/** frame-ancestors of the embed page for APP (and whether X-Frame-Options is sent). */
async function embedPolicy(ctx: Ctx): Promise<{ ancestors: string; xfo: string | null }> {
  const response = await fetch(`${ctx.env.site}/embed/v1/buttons?app_id=${APP}&redirect_uri=${encodeURIComponent(`${ctx.env.apps}/${APP}/callback`)}`);
  const csp = response.headers.get("content-security-policy") ?? "";
  return { ancestors: /frame-ancestors ([^;]*)/.exec(csp)?.[1]?.trim() ?? "", xfo: response.headers.get("x-frame-options") };
}

interface Framed {
  page: Page;
  context: BrowserContext;
  frame: Frame | null;
  rendered: boolean;
  refusals: string[];
}

/** A visitor opens `url` (served by Playwright with `html`) and the embed inside it settles. */
async function frameFrom(ctx: Ctx, url: string, html: string, label: string, blocked: boolean): Promise<Framed> {
  const context = await newContext(ctx.browser);
  await hostPage(context, url, html);
  const page = await context.newPage();
  const refusals: string[] = [];
  page.on("console", message => {
    if (/frame-ancestors/i.test(message.text())) refusals.push(message.text());
  });
  ctx.results.watch(page, label, blocked ? [/frame-ancestors/i, /ERR_BLOCKED_BY_RESPONSE/] : []);
  await page.goto(url);
  const frameHandle = page.locator("iframe").first();
  await frameHandle.waitFor({ timeout: 20_000 });
  let frame: Frame | null = null;
  let rendered = false;
  for (let attempt = 0; attempt < 30 && !rendered; attempt++) {
    frame = (await (await frameHandle.elementHandle())?.contentFrame()) ?? null;
    rendered = !!frame && (await frame.locator("#silicon-accounts-embed[data-ready]").count().catch(() => 0)) > 0;
    if (!rendered) await sleep(blocked ? 150 : 300);
  }
  return { page, context, frame, rendered, refusals };
}

export const journey: Journey = {
  name: "developer-branding-embed",
  title: "iframe embed: the Embed tab's snippet renders on the allowed origin (buttons in order, Powered by, auto height, top navigation), is blocked by frame-ancestors elsewhere, signs a Carbon in end to end; allowed origins drive the policy (none → 'none' + DENY + explanation, new origin → allowed)",
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const appsOrigin = new URL(env.apps).origin;
    const otherOrigin = `http://localhost:${new URL(env.apps).port}`;
    const seededOrigins = (fakeApp(APP).signin_defaults?.allowed_origins as string[] | undefined)?.map(origin => origin.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${new URL(env.apps).port}`)) ?? [appsOrigin];
    let lastEmbed = Date.now();
    const settleCache = async () => {
      // The site keeps an app's allowed origins for 30 s; wait until the last embed request's entry is stale.
      const wait = lastEmbed + 31_000 - Date.now();
      if (wait > 0) await sleep(wait);
    };

    const policy0 = await embedPolicy(ctx);
    lastEmbed = Date.now();
    results.check("the embed page lets exactly the app's allowed origin frame it, without X-Frame-Options", policy0.ancestors === `'self' ${appsOrigin}` && policy0.xfo === null, JSON.stringify(policy0));

    // The owner copies the iframe snippet from the Embed tab.
    const owner = await ownerSignIn(ctx, APP, "dvb-g-owner");
    const { page } = owner;
    const saveBar = page.getByRole("region", { name: "Unsaved changes" });
    await page.goto(`${env.site}/developer/${APP}/embed`);
    await page.getByRole("tab", { name: "Iframe" }).click();
    const snippetBlock = page.getByRole("region", { name: "Iframe source code" }).locator("pre");
    await snippetBlock.waitFor({ timeout: 20_000 });
    const snippet = (await snippetBlock.textContent()) ?? "";
    results.check("the Embed tab's iframe snippet points at this site's /embed/v1/buttons for the app, with the resize listener", snippet.includes(`src="${env.site}/embed/v1/buttons?app_id=${APP}&amp;redirect_uri=`) && snippet.includes("silicon-accounts:resize"), snippet.slice(0, 220));

    // On the allowed origin: the app's buttons in its order, Powered by, a frame as tall as its content.
    const allowedUrl = `${appsOrigin}/__dvb/embed-${t}.html`;
    const host = htmlPage("Host page", `<h1>An app page</h1>${snippet}`);
    const started = Date.now();
    const allowed = await frameFrom(ctx, allowedUrl, host, "dvb-g-allowed", false);
    lastEmbed = Date.now();
    results.check("on the allowed origin the iframe shows the buttons", allowed.rendered, allowed.page.frames().map(frame => frame.url()).join(" "));
    results.metric("embed iframe on the allowed origin: page → buttons ready", Date.now() - started);
    if (allowed.frame) {
      const links = await allowed.frame.locator("a[data-method]").evaluateAll(anchors => anchors.map(a => ({ method: a.getAttribute("data-method"), text: (a.textContent ?? "").trim(), href: a.getAttribute("href") ?? "", target: a.getAttribute("target") })));
      results.check("the buttons follow the app's methods and order (email, then Google)", JSON.stringify(links.map(link => link.method)) === JSON.stringify(["email", "google"]), links.map(link => link.text).join(" | "));
      results.check("each button sends the whole window (target=_top) to /authorize with the snippet's parameters and its method", links.every(link => link.target === "_top" && link.href.startsWith("/authorize?") && link.href.includes(`app_id=${APP}`) && link.href.includes(`method=${link.method}`)), links.map(link => link.href).join(" "));
      const powered = await checkPoweredBy(ctx, allowed.frame, "the embed iframe");
      checkPoweredByHost(ctx, "the iframe embed", [powered.href]);
      await sleep(600);
      const height = await allowed.page.locator("iframe").first().evaluate(el => el.getBoundingClientRect().height);
      const content = await allowed.frame.locator("#silicon-accounts-embed").evaluate(el => Math.ceil(el.getBoundingClientRect().height));
      results.check("the snippet sizes the iframe to the buttons (no 200 px box, no scrollbar)", Math.abs(height - content) <= 2 && height < 200, `iframe ${height} px, content ${content} px`);
      await shot(env, allowed.page, "dvb-g-01-allowed-origin");
      await allowed.frame.locator("a[data-method='email']").click();
      await allowed.page.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 20_000 }).catch(() => undefined);
      const top = allowed.page.url();
      results.check("choosing Email takes the whole window to the hosted sign-in, narrowed to email", top.startsWith(`${env.site}/authorize?`) && new URL(top).searchParams.get("method") === "email", top.slice(0, 160));
    }
    await allowed.context.close();

    // Any other origin: the browser refuses to show it (frame-ancestors), whatever the page around it does.
    for (const [origin, what] of [[otherOrigin, "localhost instead of 127.0.0.1"], ["http://evil.example:8123", "another site"]] as const) {
      const blocked = await frameFrom(ctx, `${origin}/__dvb/embed-${t}.html`, host, `dvb-g-blocked-${what.split(" ")[0]}`, true);
      lastEmbed = Date.now();
      results.check(`from ${origin} (${what}) the browser refuses the frame: no buttons, a frame-ancestors refusal`, !blocked.rendered && blocked.refusals.length > 0, blocked.refusals[0]?.slice(0, 200) ?? "no refusal logged");
      await shot(env, blocked.page, `dvb-g-02-blocked-${what.split(" ")[0]}`);
      await blocked.context.close();
    }

    // A Carbon signs up through the fake app's own iframe (real state and PKCE), back at the app.
    {
      const context = await newContext(ctx.browser);
      const visitor = await context.newPage();
      results.watch(visitor, "dvb-g-iframe-signin");
      const walkStarted = Date.now();
      await visitor.goto(`${env.apps}/${APP}/?only=iframe`);
      const frame = visitor.frameLocator("#signin-iframe");
      await frame.locator("a[data-method='email']").click({ timeout: 30_000 });
      lastEmbed = Date.now();
      const email = freshEmail("iframe");
      const field = visitor.getByRole("textbox", { name: "Email" });
      await field.waitFor({ timeout: 30_000 });
      const after = await lastSeq(env);
      await field.fill(email);
      await visitor.getByRole("button", { name: "Continue", exact: true }).click();
      const code = await codeFor(env, email, after);
      await visitor.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
      await visitor.keyboard.type(code, { delay: 25 });
      await visitor.getByRole("button", { name: "Create account", exact: true }).click({ timeout: 30_000 });
      const share = visitor.getByRole("button", { name: "Share and continue", exact: true });
      const back = visitor.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/${APP}/`), { timeout: 30_000 }).then(() => "app" as const);
      if ((await Promise.race([back, share.waitFor({ timeout: 30_000 }).then(() => "consent" as const)])) === "consent") await share.click();
      await visitor.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/${APP}/`), { timeout: 30_000 });
      await visitor.waitForLoadState("networkidle").catch(() => undefined);
      const signedIn = await visitor.locator("#signed-in-as").innerText().catch(() => "");
      const account = await visitor.locator("#account").innerText().catch(() => "");
      // browser asks for no email (only an optional timezone), so the app gets the account's uuid and id, not the address.
      let received: { uuid?: string; id?: string; email?: string } = {};
      try {
        received = JSON.parse(account) as typeof received;
      } catch {
        received = {};
      }
      results.check("a Carbon who started in the app's iframe is signed in to the app (state and PKCE kept by the app)", /Signed in as c:/.test(signedIn) && typeof received.uuid === "string" && signedIn.includes(String(received.id)), signedIn.slice(0, 120));
      results.check("the app received no email (browser does not ask for one)", received.email === undefined, JSON.stringify(received).slice(0, 160));
      results.metric("iframe → signed in to the app (new Carbon)", Date.now() - walkStarted);
      await context.close();
    }

    // No allowed origins: frame-ancestors 'none', X-Frame-Options DENY, the page says why, the Embed tab warns.
    await page.goto(`${env.site}/developer/${APP}/sign-in`);
    const v0 = (await asSession<{ config_version: number }>(page, env, "GET", `/v1/apps/${APP}`)).body.config_version;
    await page.getByText(`Stored version ${v0}`).waitFor({ timeout: 20_000 });
    for (const origin of seededOrigins) await page.getByRole("button", { name: `Remove ${origin}`, exact: true }).click();
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await saveBar.getByText(`Saved as version ${v0 + 1}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    const publicNone = await json<{ allowed_origins?: string[] }>(`${env.site}/v1/apps/${APP}/public`);
    results.check("without allowed origins the public config lists none at once", Array.isArray(publicNone.body.allowed_origins) && publicNone.body.allowed_origins.length === 0, JSON.stringify(publicNone.body.allowed_origins));
    await settleCache();
    const savedAt = Date.now();
    const policy1 = await embedPolicy(ctx);
    lastEmbed = Date.now();
    results.check("the embed page now says frame-ancestors 'none' and X-Frame-Options DENY", policy1.ancestors === "'none'" && policy1.xfo === "DENY", JSON.stringify(policy1));
    const direct = await newContext(ctx.browser);
    const directPage = await direct.newPage();
    results.watch(directPage, "dvb-g-direct");
    await directPage.goto(`${env.site}/embed/v1/buttons?app_id=${APP}&redirect_uri=${encodeURIComponent(`${env.apps}/${APP}/callback`)}`);
    const note = directPage.locator("[data-error-code='no_allowed_origins']");
    await note.waitFor({ timeout: 20_000 }).catch(() => undefined);
    results.check("opened on its own, the embed explains that no site may show it yet (no_allowed_origins)", (await note.count()) === 1 && /Other sites cannot show these buttons yet/.test(await note.innerText().catch(() => "")));
    await shot(env, directPage, "dvb-g-03-no-origins");
    await direct.close();
    const nowBlocked = await frameFrom(ctx, allowedUrl, host, "dvb-g-was-allowed", true);
    lastEmbed = Date.now();
    results.check("the origin that was allowed is refused now too", !nowBlocked.rendered && nowBlocked.refusals.length > 0, nowBlocked.refusals[0]?.slice(0, 160) ?? "no refusal");
    await nowBlocked.context.close();
    await page.goto(`${env.site}/developer/${APP}/embed`);
    await page.getByRole("tab", { name: "Iframe" }).click();
    results.check("the Embed tab warns that the iframe needs an allowed origin", (await page.getByText("The iframe needs an allowed origin").count()) > 0);

    // Allow the seeded origin again plus a new one: once the site's policy cache turns over, the new origin may frame it.
    await page.goto(`${env.site}/developer/${APP}/sign-in`);
    await page.getByText(`Stored version ${v0 + 1}`).waitFor({ timeout: 20_000 });
    const origins = page.getByRole("textbox", { name: "Allowed origins" });
    for (const origin of [...seededOrigins, otherOrigin]) {
      await origins.fill(origin);
      await origins.press("Enter");
    }
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await saveBar.getByText(`Saved as version ${v0 + 2}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    await settleCache();
    const policy2 = await embedPolicy(ctx);
    lastEmbed = Date.now();
    results.check("the embed page now allows both origins", policy2.ancestors === `'self' ${[...seededOrigins, otherOrigin].join(" ")}` && policy2.xfo === null, JSON.stringify(policy2));
    const nowAllowed = await frameFrom(ctx, `${otherOrigin}/__dvb/embed-${t}.html`, host, "dvb-g-new-origin", false);
    results.check(`the newly allowed origin (${otherOrigin}) shows the buttons`, nowAllowed.rendered);
    results.metric("allowed-origin change → embed policy (bounded by the site's 30 s cache)", Date.now() - savedAt);
    await shot(env, nowAllowed.page, "dvb-g-04-new-origin");
    await nowAllowed.context.close();

    // Back to the seeded origins only.
    const restored = await asSession<{ config_version: number }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { allowed_origins: seededOrigins });
    results.check("the seeded allowed origins are back", restored.status === 200);
    await owner.context.close();
  },
};
