/**
 * ux-audit: the orchestrator's UX notes (scratchpad ux-notes.md), items 4 to 7, re-checked against the running stack.
 * Items 1 to 3 are checked where the pages are walked: the split layout's hero copy per step in ux-audit-hosted-acme,
 * the dock's clearance on every account and developer page (ux-audit-account-*, ux-audit-developer-*), and "Powered by"
 * on card, split and minimal layouts at 390 and 1440 (ux-audit-hosted-*).
 *
 *   4  the site's rewrites (/v1, /.well-known), bodies over 10 MB through the proxy, proxyTimeout, agentRules
 *   5  /v1 and /.well-known outside the page proxy (no page CSP), Set-Cookie, absolute Location, Origin and
 *      X-Forwarded-For passing through unchanged
 *   6  the default dark primary #1F5FB8 with #FFFDF9 text; the server's 4.5:1 rule for button and page text
 *   7  allowed_origins, docs_url, ids/available `for=`, a custodian's Silicon photo, the sign-up photo, "Not you?"
 *      clearing the sign-up cookie, the telemetry opt-out on every request, Silicon history titles with meta.silicon
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { E2E_DIR, api, json, sql, sleep, tag } from "../../lib";
import { auditContext, collectConsole, freshEmail, hostedLink, pageFetch, sendEmailCode, signedInCarbon, stepReady } from "./_audit";

/** Uploads a small PNG (drawn on a canvas) from the page itself: same origin, cookies and Origin included. */
async function uploadPng(page: Page, path: string): Promise<{ status: number; body: Record<string, unknown> | string | null }> {
  return (await page.evaluate(`(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    const g = canvas.getContext("2d");
    g.fillStyle = "#1F5FB8"; g.fillRect(0, 0, 64, 64);
    g.fillStyle = "#FFFDF9"; g.beginPath(); g.arc(32, 26, 10, 0, Math.PI * 2); g.fill();
    const blob = await new Promise(done => canvas.toBlob(done, "image/png"));
    const response = await fetch(${JSON.stringify(path)}, { method: "POST", headers: { "content-type": "image/png", "idempotency-key": crypto.randomUUID() }, body: blob, credentials: "same-origin" });
    const text = await response.text();
    let body = text; try { body = JSON.parse(text); } catch (e) { /* text */ }
    return { status: response.status, body };
  })()`)) as { status: number; body: Record<string, unknown> | string | null };
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-notes-proxy",
    title: "UX notes 4 and 5: /v1 and /.well-known through the site (no page CSP), a 12 MB import body through the proxy, the config (52mb, 5 min, agentRules off), Set-Cookie, absolute Location, Origin and X-Forwarded-For unchanged",
    timeoutMs: 600_000,
    async run(ctx) {
      const { env, results } = ctx;
      const meta = await json<{ public_url?: string; docs_url?: string }>(`${env.site}/v1/meta`);
      results.check("note 4: /v1/* is rewritten to accounts-api (GET /v1/meta through the site)", meta.status === 200 && meta.body.public_url === env.site, `${meta.status} ${JSON.stringify(meta.body).slice(0, 160)}`);
      const discovery = await json<{ issuer?: string; jwks_uri?: string }>(`${env.site}/.well-known/openid-configuration`);
      results.check("note 4: /.well-known/* is rewritten to accounts-api (OIDC discovery through the site)", discovery.status === 200 && typeof discovery.body.issuer === "string", `${discovery.status} ${JSON.stringify(discovery.body).slice(0, 160)}`);
      const page0 = await fetch(`${env.site}/sign-in`);
      const pageCsp = page0.headers.get("content-security-policy") ?? "";
      const apiCsp = meta.headers.get("content-security-policy") ?? "";
      const wellKnownCsp = discovery.headers.get("content-security-policy") ?? "";
      results.check("note 5: pages carry the nonce CSP of proxy.ts", /'nonce-/.test(pageCsp), pageCsp.slice(0, 160));
      results.check("note 5: /v1 and /.well-known answers never pass through proxy.ts (no page nonce CSP on them)", !/'nonce-/.test(apiCsp) && !/'nonce-/.test(wellKnownCsp), `v1: ${apiCsp || "(none)"} | well-known: ${wellKnownCsp || "(none)"}`);

      const config = readFileSync(join(E2E_DIR, "..", "next.config.ts"), "utf8");
      results.check("note 4: next.config.ts sets proxyClientMaxBodySize '52mb' and proxyTimeout 300_000", /proxyClientMaxBodySize:\s*["']52mb["']/.test(config) && /proxyTimeout:\s*300_?000/.test(config), (config.match(/experimental:\s*\{[^}]*\}/)?.[0] ?? "no experimental block").replace(/\s+/g, " "));
      results.check("note 4: next.config.ts sets agentRules: false", /agentRules:\s*false/.test(config));
      results.check("note 4: next.config.ts rewrites /v1/:path* and /.well-known/:path* to ACCOUNTS_API_URL", /source:\s*["']\/v1\/:path\*["']/.test(config) && /source:\s*["']\/\.well-known\/:path\*["']/.test(config));

      // A 12 MB import through the site's proxy (Next cuts proxied bodies at 10 MB by default: a 500 after 30 s).
      const owner = await signedInCarbon(ctx, "uxa.notes.big");
      results.watch(owner.page, "notes-proxy");
      const cookies = await owner.context.cookies(env.site);
      results.check("note 5: Set-Cookie passes through the site (the session cookie lands on the site's origin)", cookies.some(cookie => /(^|__Host-)sa_session$/.test(cookie.name)), cookies.map(cookie => cookie.name).join(", "));
      const appId = `uxa-big-${tag()}`;
      await sql(env, `insert into apps (app_id, name, description, owner_uuid, secret_hash, status, source) select '${appId}', 'Big Import ${appId.slice(-6)}', '', '${owner.uuid}', secret_hash, 'active', 'fake' from apps where app_id = 'briefcase'`);
      await sql(env, `insert into app_signin_configs (app_id, version, config, updated_by) select '${appId}', 1, config, 'system' from app_signin_configs where app_id = 'briefcase'`);
      const rows = Array.from({ length: 90_000 }, (_, i) => ({ email: `uxa.big.${i}.${appId}@example.test`, display_name: `Imported Carbon number ${i} with a longer name`, external_id: `ext-${appId}-${i}` }));
      const body = JSON.stringify({ rows, options: { dry_run: true } });
      const started = Date.now();
      const big = await owner.page.request.post(`${env.site}/v1/apps/${appId}/imports`, { headers: { "content-type": "application/json", origin: env.site, "idempotency-key": `uxa-big-${appId}` }, data: body, timeout: 120_000 }).catch(error => error as Error);
      const ms = Date.now() - started;
      if (big instanceof Error) results.check("note 4: a 12 MB import body reaches accounts-api through the site", false, big.message.slice(0, 300));
      else {
        const text = await big.text();
        results.check(`note 4: a ${(body.length / 1_048_576).toFixed(1)} MB import body reaches accounts-api through the site (not Next's 500)`, big.status() < 500 && /"job"|"error"/.test(text), `${big.status()} in ${ms} ms: ${text.slice(0, 220)}`);
        results.metric("12 MB import through the proxy", ms);
      }

      // Location, Origin and X-Forwarded-For through the rewrite. A provider's callback lands on the site's
      // /v1/oauth/callback/{provider}, and accounts-api answers it with a 302 to the flow page.
      {
        const context = await auditContext(ctx.browser);
        const page = await context.newPage();
        results.watch(page, "notes-location");
        await page.goto(await hostedLink(env, page, "briefcase"));
        await page.getByRole("button", { name: "Continue with Google" }).click({ timeout: 30_000 });
        await page.waitForURL(new RegExp(env.oidc.replace(/[.:/]/g, "\\$&")), { timeout: 30_000 });
        const callback = page.waitForResponse(response => new URL(response.url()).pathname === "/v1/oauth/callback/google", { timeout: 30_000 });
        await page.locator('#new-identity input[name="_auto"]').fill(`uxa.loc.${tag()}@gmail.test`);
        await page.locator('#new-identity input[name="_name"]').fill("Location Check");
        await page.locator('#new-identity button[data-action="use-another"]').click();
        const answer = await callback.catch(() => null);
        const location = answer?.headers()["location"] ?? "";
        results.check("note 5: the API's absolute Location passes through the site unchanged (Google's callback → 302 to the flow page)", !!answer && answer.status() >= 300 && answer.status() < 400 && location.startsWith(`${env.site}/authorize/flow/`) && answer.url().startsWith(`${env.site}/v1/oauth/callback/google`), `${answer?.status()} ${answer?.url().slice(0, 80)} → ${location.slice(0, 120)}`);
        await context.close();
      }
      const foreign = await owner.page.request.patch(`${env.site}/v1/me`, { headers: { "content-type": "application/json", origin: "https://evil.example" }, data: { display_name: "Not me" } });
      const foreignBody = await foreign.text();
      results.check("note 5: Origin passes through unchanged (a cookie mutation from a foreign Origin is refused 403 origin_not_allowed)", foreign.status() === 403 && /origin_not_allowed/.test(foreignBody), `${foreign.status()} ${foreignBody.slice(0, 160)}`);
      const ip = `10.250.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
      await api(ctx, `/v1/ids/available?id=c:uxa-xff-${tag()}`, { forwardedFor: ip });
      const [[hits] = []] = await sql(env, `select count from rate_limits where bucket = 'ids_available:ip:${ip}'`);
      results.check("note 5: X-Forwarded-For passes through the site to accounts-api", Number(hits) >= 1, `${hits ?? 0} hit(s) counted for ${ip}`);
      await owner.context.close();
    },
  },
  {
    name: "ux-audit-notes-branding",
    title: "UX note 6: the default dark primary #1F5FB8 with #FFFDF9 text on briefcase's hosted page; the server refuses button or page text under 4.5:1",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const context = await auditContext(browser, { dark: true });
      const page = await context.newPage();
      results.watch(page, "notes-branding");
      await page.goto(await hostedLink(env, page, "briefcase"));
      const proceed = page.getByRole("button", { name: "Continue", exact: true });
      await proceed.waitFor({ timeout: 30_000 });
      await stepReady(page);
      const look = await proceed.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
      results.check("note 6: the default dark primary button is #1F5FB8 with #FFFDF9 text (6.1:1)", look.background === "rgb(31, 95, 184)" && look.color === "rgb(255, 253, 249)", JSON.stringify(look));
      await page.screenshot({ path: `${env.shots}/uxa-notes-default-dark-primary.png` });
      await context.close();

      const owner = await signedInCarbon(ctx, "uxa.notes.brand");
      results.watch(owner.page, "notes-branding-owner", [/status of 422 .*signin-config/]);
      const appId = `uxa-brand-${tag()}`;
      await sql(env, `insert into apps (app_id, name, description, owner_uuid, secret_hash, status, source) select '${appId}', 'Brand Check ${appId.slice(-6)}', '', '${owner.uuid}', secret_hash, 'active', 'fake' from apps where app_id = 'briefcase'`);
      await sql(env, `insert into app_signin_configs (app_id, version, config, updated_by) select '${appId}', 1, config, 'system' from app_signin_configs where app_id = 'briefcase'`);
      const button = await pageFetch<{ error?: { code?: string; details?: unknown; message?: string } }>(owner.page, `/v1/apps/${appId}/signin-config`, { method: "PATCH", body: { branding: { light: { primary: "#3B82F6", primary_foreground: "#FFFDF9" } } } });
      results.check("note 6: the server refuses button text at 3.62:1 (#FFFDF9 on #3B82F6) with a field error", button.status === 422 && /primary/.test(JSON.stringify(button.body)), `${button.status} ${JSON.stringify(button.body).slice(0, 300)}`);
      const text = await pageFetch(owner.page, `/v1/apps/${appId}/signin-config`, { method: "PATCH", body: { branding: { light: { foreground: "#8A8580", background: "#FFFFFF" } } } });
      results.check("note 6: the server refuses page text under 4.5:1 (#8A8580 on #FFFFFF, 3.6:1)", text.status === 422 && /foreground|background/.test(JSON.stringify(text.body)), `${text.status} ${JSON.stringify(text.body).slice(0, 300)}`);
      const fine = await pageFetch(owner.page, `/v1/apps/${appId}/signin-config`, { method: "PATCH", body: { branding: { light: { primary: "#1F5FB8", primary_foreground: "#FFFDF9" } } } });
      results.check("note 6: a 6.1:1 pair is accepted", fine.status === 200, `${fine.status} ${JSON.stringify(fine.body).slice(0, 160)}`);
      await owner.context.close();
    },
  },
  {
    name: "ux-audit-notes-api",
    title: "UX note 7: allowed_origins, docs_url, ids/available for= (a custodian reclaims a Silicon's old id), a Silicon photo by its custodian, the sign-up photo, Not you? clearing the sign-up cookie, the telemetry opt-out header and cookie, Silicon history titles with meta.silicon",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const pub = await json<{ allowed_origins?: string[] }>(`${env.site}/v1/apps/briefcase/public`);
      results.check("note 7: an app's public config lists allowed_origins", Array.isArray(pub.body.allowed_origins) && pub.body.allowed_origins.includes(new URL(env.apps).origin), JSON.stringify(pub.body.allowed_origins));
      const meta = await json<{ docs_url?: string }>(`${env.site}/v1/meta`);
      results.check("note 7: /v1/meta has docs_url", typeof meta.body.docs_url === "string" && /^https?:\/\//.test(meta.body.docs_url), String(meta.body.docs_url));

      // A custodian, a Silicon whose id changes, and the reclaim check with for=.
      const carbon = await signedInCarbon(ctx, "uxa.notes.api");
      const { page } = carbon;
      results.watch(page, "notes-api", [/status of 4\d\d .*\/v1\/ids\/available/]);
      collectConsole(page);
      const t = tag();
      const created = await pageFetch<{ silicon?: { uuid?: string; id?: string } }>(page, "/v1/me/silicons", { method: "POST", body: { id: `si:uxa-old-${t}`, display_name: `Reclaim ${t}` } });
      const uuid = created.body.silicon?.uuid ?? "";
      results.check("note 7: the Carbon created a Silicon", !!uuid, `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
      const renamed = await pageFetch(page, `/v1/me/silicons/${uuid}/id`, { method: "POST", body: { id: `si:uxa-new-${t}` } });
      results.check("note 7: the Silicon's id changed", renamed.status === 200, `${renamed.status} ${JSON.stringify(renamed.body).slice(0, 160)}`);
      const plain = await pageFetch<{ available?: boolean }>(page, `/v1/ids/available?id=si:uxa-old-${t}`);
      const forUuid = await pageFetch<{ available?: boolean }>(page, `/v1/ids/available?id=si:uxa-old-${t}&for=${uuid}`);
      const forId = await pageFetch<{ available?: boolean }>(page, `/v1/ids/available?id=si:uxa-old-${t}&for=si:uxa-new-${t}`);
      results.check("note 7: the old si:id is reserved for everyone else", plain.status === 200 && plain.body.available === false, JSON.stringify(plain));
      results.check("note 7: ids/available for=<uuid> tells the custodian the Silicon may take its old id back", forUuid.status === 200 && forUuid.body.available === true, JSON.stringify(forUuid));
      results.check("note 7: ids/available for=<si:id> works the same", forId.status === 200 && forId.body.available === true, JSON.stringify(forId));

      // The custodian uploads the Silicon's photo.
      const photo = await uploadPng(page, `/v1/me/silicons/${uuid}/photo`);
      const pfp = typeof photo.body === "object" && photo.body ? String((photo.body as { pfp_url?: string }).pfp_url ?? JSON.stringify(photo.body)) : String(photo.body);
      const silicon = await pageFetch<{ pfp_url?: string }>(page, `/v1/me/silicons/${uuid}`);
      results.check("note 7: POST /v1/me/silicons/{uuid}/photo by the custodian sets the Silicon's photo", (photo.status === 200 || photo.status === 201) && !!silicon.body.pfp_url && silicon.body.pfp_url === pfp, `${photo.status} ${pfp.slice(0, 120)} / now ${String(silicon.body.pfp_url).slice(0, 120)}`);

      // History titles about a Silicon name it and carry meta.silicon.
      const history = await pageFetch<{ items?: Array<{ title?: string; meta?: { silicon?: unknown } }> }>(page, "/v1/me/history?limit=50");
      const about = (history.body.items ?? []).filter(item => /si:uxa-(old|new)-/.test(item.title ?? "") || item.meta?.silicon);
      results.check("note 7: history items about the Silicon name it in their title and carry meta.silicon", about.length >= 2 && about.every(item => /si:uxa-/.test(item.title ?? "") && !!item.meta?.silicon), JSON.stringify(about.slice(0, 3)).slice(0, 400));

      // Telemetry off in settings: every request after carries the choice (header) and the cookie is set.
      await page.goto(`${env.site}/settings`);
      const toggle = page.getByRole("switch", { name: /Share usage telemetry/ });
      await toggle.waitFor({ timeout: 30_000 });
      if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
      await sleep(600);
      const seen: Array<{ url: string; header: string | null }> = [];
      page.on("request", request => {
        if (request.url().startsWith(`${env.site}/v1/`)) seen.push({ url: request.url(), header: request.headers()["x-accounts-telemetry"] ?? null });
      });
      await page.goto(`${env.site}/apps`);
      await page.locator("main").first().waitFor({ timeout: 30_000 });
      await sleep(1500);
      const cookies = await carbon.context.cookies(env.site);
      results.check("note 7: telemetry off sets the sa_telemetry=off cookie", cookies.some(cookie => /sa_telemetry$/.test(cookie.name) && cookie.value === "off"), cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; "));
      results.check("note 7: telemetry off: every API call of the next page carries X-Accounts-Telemetry: off", seen.length > 0 && seen.every(entry => entry.header === "off"), seen.map(entry => `${entry.url.replace(env.site, "")} ${entry.header}`).join("; "));
      await carbon.context.close();

      // The sign-up photo, then "Not you?": the sign-up cookie is cleared by the server.
      const context = await auditContext(browser);
      const signup = await context.newPage();
      results.watch(signup, "notes-signup");
      await signup.goto(await hostedLink(env, signup, "briefcase"));
      const code = await sendEmailCode(env, signup, freshEmail("uxa.notes.photo"));
      await signup.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
      await signup.keyboard.type(code, { delay: 25 });
      await signup.getByRole("button", { name: "Create account" }).waitFor({ timeout: 30_000 });
      const flowId = new URL(signup.url()).pathname.split("/").pop() ?? "";
      const uploaded = await uploadPng(signup, `/v1/flows/${flowId}/signup/photo`);
      results.check("note 7: POST /v1/flows/{id}/signup/photo takes a photo for the sign-up (pfp_url back)", (uploaded.status === 200 || uploaded.status === 201) && typeof uploaded.body === "object" && !!uploaded.body && typeof (uploaded.body as { pfp_url?: string }).pfp_url === "string", `${uploaded.status} ${JSON.stringify(uploaded.body).slice(0, 200)}`);
      const before = (await context.cookies(env.site)).filter(cookie => /sa_signup$/.test(cookie.name)).map(cookie => cookie.name);
      const switched = signup.waitForResponse(response => /\/v1\/flows\/[^/]+\/switch$/.test(new URL(response.url()).pathname), { timeout: 20_000 });
      await signup.getByRole("button", { name: "Not you? Use another account" }).click();
      const response = await switched.catch(() => null);
      const setCookie = (await response?.headerValue("set-cookie").catch(() => null)) ?? "";
      const after = (await context.cookies(env.site)).filter(cookie => /sa_signup$/.test(cookie.name)).map(cookie => cookie.name);
      results.check("note 7: \"Not you?\" at sign-up clears the sign-up cookie server-side", before.length > 0 && after.length === 0 && /sa_signup=;|sa_signup=[^;]*;.*(Max-Age=0|expires=Thu, 01 Jan 1970)/i.test(setCookie), `before ${before.join(",") || "none"}, after ${after.join(",") || "none"}; set-cookie: ${setCookie.slice(0, 200)}`);
      await signup.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 20_000 }).catch(() => undefined);
      results.check("note 7: …and the sign-in starts again at its methods", await signup.getByRole("textbox", { name: "Email" }).isVisible().catch(() => false));
      await context.close();
    },
  },
];
