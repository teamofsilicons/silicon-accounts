/**
 * Security headers on everything the stack serves: the site's HTML (nonce CSP, frame-ancestors, X-Frame-Options,
 * nosniff, referrer policy, no caching of nonce pages), the embed page's per-app frame-ancestors, and the API's JSON
 * (default-src 'none' CSP, nosniff, no-store, CORS only where public) both through the site and straight from
 * accounts-api. Then in the browser: pages load without a single CSP violation, and a page on another origin cannot
 * frame the site (clickjacking) while the embed still renders for an app's allowed origin.
 */
import type { Frame, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { newContext, shot, sleep, tag } from "../../lib";
import { call, callbackOf, sparePort, type Reply } from "./_helpers";

/** CSP → directive name → its values. */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), values);
  }
  return out;
}

const header = (reply: Reply, name: string) => reply.headers.get(name) ?? "";

/** What is wrong with a page's headers (empty: nothing). */
function pageProblems(reply: Reply, options: { framing: "none" | string[] }): string[] {
  const problems: string[] = [];
  const csp = header(reply, "content-security-policy");
  if (!csp) return ["no Content-Security-Policy"];
  const d = directives(csp);
  const has = (name: string, value: string) => (d.get(name) ?? []).includes(value);
  if (!has("default-src", "'self'")) problems.push(`default-src is ${d.get("default-src")?.join(" ")}`);
  const script = d.get("script-src") ?? [];
  if (!script.some(value => /^'nonce-[A-Za-z0-9+/=_-]{16,}'$/.test(value))) problems.push(`script-src has no nonce (${script.join(" ")})`);
  if (!script.includes("'strict-dynamic'")) problems.push("script-src lacks 'strict-dynamic'");
  if (script.includes("'unsafe-inline'") || script.includes("'unsafe-eval'") || script.includes("*")) problems.push(`script-src allows ${script.filter(v => v === "'unsafe-inline'" || v === "'unsafe-eval'" || v === "*").join(" ")}`);
  if (!has("object-src", "'none'")) problems.push(`object-src is ${d.get("object-src")?.join(" ") ?? "missing"}`);
  if (!has("base-uri", "'none'")) problems.push(`base-uri is ${d.get("base-uri")?.join(" ") ?? "missing"}`);
  if (!has("connect-src", "'self'") || (d.get("connect-src") ?? []).length !== 1) problems.push(`connect-src is ${d.get("connect-src")?.join(" ") ?? "missing"}`);
  if (!d.has("form-action") || (d.get("form-action") ?? []).includes("*")) problems.push(`form-action is ${d.get("form-action")?.join(" ") ?? "missing"}`);
  if ((d.get("img-src") ?? []).includes("*")) problems.push("img-src allows *");
  const ancestors = d.get("frame-ancestors") ?? [];
  if (options.framing === "none") {
    if (ancestors.join(" ") !== "'none'") problems.push(`frame-ancestors is ${ancestors.join(" ") || "missing"}`);
    if (header(reply, "x-frame-options").toUpperCase() !== "DENY") problems.push(`X-Frame-Options is ${header(reply, "x-frame-options") || "missing"}`);
  } else {
    const wanted = ["'self'", ...options.framing];
    if (ancestors.join(" ") !== wanted.join(" ")) problems.push(`frame-ancestors is "${ancestors.join(" ")}", want "${wanted.join(" ")}"`);
    if (header(reply, "x-frame-options")) problems.push(`X-Frame-Options ${header(reply, "x-frame-options")} would block the allowed origins`);
  }
  if (header(reply, "x-content-type-options") !== "nosniff") problems.push(`X-Content-Type-Options is ${header(reply, "x-content-type-options") || "missing"}`);
  if (header(reply, "referrer-policy") !== "strict-origin-when-cross-origin") problems.push(`Referrer-Policy is ${header(reply, "referrer-policy") || "missing"}`);
  if (header(reply, "x-powered-by")) problems.push(`X-Powered-By: ${header(reply, "x-powered-by")}`);
  if (!/^text\/html/.test(header(reply, "content-type"))) problems.push(`Content-Type is ${header(reply, "content-type")}`);
  const cache = header(reply, "cache-control").toLowerCase();
  if (/\bpublic\b/.test(cache) || (/\bs-maxage=/.test(cache) && !/no-store/.test(cache))) problems.push(`a page with a per-response nonce is publicly cacheable (Cache-Control: ${cache})`);
  // Every script element of the page carries this response's nonce (no inline script runs without it).
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
  const scripts = typeof reply.body === "string" ? [...reply.text.matchAll(/<script\b[^>]*>/gi)].map(match => match[0]) : [];
  const without = scripts.filter(tagText => !tagText.includes(`nonce="${nonce}"`));
  if (without.length) problems.push(`${without.length} of ${scripts.length} <script> tags lack the nonce: ${without[0]!.slice(0, 120)}`);
  return problems;
}

/** What is wrong with an API answer's headers (empty: nothing). */
function apiProblems(reply: Reply, path: string): string[] {
  const problems: string[] = [];
  if (!/^application\/json/.test(header(reply, "content-type"))) problems.push(`Content-Type is ${header(reply, "content-type") || "missing"}`);
  if (header(reply, "x-content-type-options") !== "nosniff") problems.push(`X-Content-Type-Options is ${header(reply, "x-content-type-options") || "missing"}`);
  const csp = directives(header(reply, "content-security-policy"));
  if ((csp.get("default-src") ?? []).join(" ") !== "'none'") problems.push(`CSP default-src is ${(csp.get("default-src") ?? []).join(" ") || "missing"}`);
  if ((csp.get("frame-ancestors") ?? []).join(" ") !== "'none'") problems.push(`CSP frame-ancestors is ${(csp.get("frame-ancestors") ?? []).join(" ") || "missing"}`);
  if (path.startsWith("/v1/") && !/no-store/.test(header(reply, "cache-control"))) problems.push(`Cache-Control is ${header(reply, "cache-control") || "missing"}`);
  if (header(reply, "referrer-policy") !== "strict-origin-when-cross-origin") problems.push(`Referrer-Policy is ${header(reply, "referrer-policy") || "missing"}`);
  if (!header(reply, "x-request-id")) problems.push("no X-Request-Id");
  if (header(reply, "access-control-allow-origin")) problems.push(`Access-Control-Allow-Origin: ${header(reply, "access-control-allow-origin")}`);
  if (header(reply, "access-control-allow-credentials")) problems.push(`Access-Control-Allow-Credentials: ${header(reply, "access-control-allow-credentials")}`);
  return problems;
}

/** The visible text of a frame, or "" when it shows nothing of ours (blocked, error page, cross-origin failure). */
async function frameText(frame: Frame | null): Promise<string> {
  if (!frame) return "";
  try {
    return (await frame.evaluate(() => document.body?.innerText ?? "")).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

async function frameOf(page: Page, id: string): Promise<Frame | null> {
  const handle = await page.$(`iframe#${id}`);
  return handle ? handle.contentFrame() : null;
}

export const journey: Journey = {
  name: "security-headers",
  title: "security headers: nonce CSP / frame-ancestors / X-Frame-Options / nosniff on every HTML page, per-app frame-ancestors on the embed, default-src 'none' + no-store on API JSON (site and direct), CORS only on public endpoints; no CSP violation in the browser and no framing from another origin",
  async run({ env, results, browser }) {
    const callback = callbackOf(env, "briefcase");

    // 1. The site's HTML pages.
    const pages: Array<[string, number]> = [
      ["/", 200],
      ["/sign-in", 200],
      ["/device", 200],
      ["/silicons", 200],
      ["/apps", 200],
      ["/proofs", 200],
      ["/settings", 200],
      ["/developer", 200],
      [`/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=hdr-${tag()}`, 200],
      ["/authorize/flow/not-a-real-flow", 200],
      [`/no-such-page-${tag()}`, 404],
    ];
    const pageFailures: string[] = [];
    for (const [path, status] of pages) {
      const reply = await call(`${env.site}${path}`, { headers: { accept: "text/html" } });
      const problems = pageProblems(reply, { framing: "none" });
      if (reply.status !== status) problems.unshift(`status ${reply.status}, want ${status}`);
      if (problems.length) pageFailures.push(`${path.slice(0, 60)}: ${problems.join("; ")}`);
    }
    results.check(`every HTML page (${pages.length}, incl. the 404 and /authorize) has a nonce CSP with 'strict-dynamic', no unsafe-inline/eval, object-src/base-uri 'none', frame-ancestors 'none' + X-Frame-Options DENY, nosniff, the referrer policy, no X-Powered-By, no public caching, and a nonce on every <script>`, pageFailures.length === 0, pageFailures.join(" | ") || `${pages.length} pages`);

    const first = await call(`${env.site}/sign-in`);
    const second = await call(`${env.site}/sign-in`);
    const nonceOf = (reply: Reply) => /'nonce-([^']+)'/.exec(header(reply, "content-security-policy"))?.[1] ?? "";
    results.check("the CSP nonce is new on every response (never reused)", !!nonceOf(first) && nonceOf(first) !== nonceOf(second), `${nonceOf(first).slice(0, 12)}… vs ${nonceOf(second).slice(0, 12)}…`);

    // 2. The embed: framing only by the app's own allowed origins.
    const embed = await call(`${env.site}/embed/v1/buttons?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=e-${tag()}`);
    const embedProblems = pageProblems(embed, { framing: [new URL(env.apps).origin] });
    results.check("the embed page of briefcase may be framed only by 'self' and briefcase's allowed origin (no X-Frame-Options), and keeps the rest of the CSP", embed.status === 200 && embedProblems.length === 0, embedProblems.join("; ") || header(embed, "content-security-policy").match(/frame-ancestors[^;]*/)?.[0] || "");
    const embedUnknown = await call(`${env.site}/embed/v1/buttons?app_id=no-such-app-${tag()}`);
    const injected = await call(`${env.site}/embed/v1/buttons?app_id=${encodeURIComponent("briefcase' https://evil.example")}`);
    const bare = await call(`${env.site}/embed/v1/buttons`);
    const deny = (reply: Reply) => pageProblems(reply, { framing: "none" }).filter(p => !/status/.test(p));
    results.check("the embed of an unknown app, of no app, and of an app_id carrying CSP syntax is framed by nobody (frame-ancestors 'none' + DENY)", [embedUnknown, injected, bare].every(reply => deny(reply).length === 0), [embedUnknown, injected, bare].map(reply => deny(reply).join(",") || "ok").join(" | "));
    results.check("an app_id carrying CSP syntax never reaches the CSP header", !/evil\.example/.test(header(injected, "content-security-policy")), header(injected, "content-security-policy").match(/frame-ancestors[^;]*/)?.[0] ?? "");

    // 3. The API: JSON answers (success and every kind of error), through the site and straight from accounts-api.
    const apiCases: Array<[string, string, number]> = [
      ["GET", "/v1/meta", 200],
      ["GET", "/v1/me", 401],
      ["GET", `/v1/no-such-endpoint-${tag()}`, 404],
      ["POST", "/v1/meta", 405],
      ["GET", "/v1/ids/available?id=c:%3Cscript%3E", 200],
      ["GET", "/v1/accounts/by-id/%3Cscript%3Ealert(1)%3C%2Fscript%3E", 401],
    ];
    const apiFailures: string[] = [];
    for (const [where, url] of [["site", env.site], ["accounts-api", env.api]] as const) {
      for (const [method, path, status] of apiCases) {
        const reply = await call(`${url}${path}`, { method, ...(method === "POST" ? { json: {} } : {}), origin: "https://evil.example" });
        const problems = apiProblems(reply, path);
        if (reply.status !== status) problems.unshift(`status ${reply.status}, want ${status}`);
        if (reply.status >= 400 && !(reply.body as { error?: unknown } | null)?.error) problems.push("the error is not the JSON error object");
        if (problems.length) apiFailures.push(`${where} ${method} ${path.slice(0, 50)}: ${problems.join("; ")}`);
      }
    }
    results.check("every API answer (200, 401, 404, 405, reflected input), through the site and direct, is JSON with nosniff, CSP default-src 'none' + frame-ancestors 'none', no-store, the referrer policy, a request id, and no CORS headers even for a foreign Origin", apiFailures.length === 0, apiFailures.join(" | ") || `${apiCases.length * 2} answers`);

    const preflight = await call(`${env.site}/v1/me`, { method: "OPTIONS", origin: "https://evil.example", headers: { "access-control-request-method": "PATCH", "access-control-request-headers": "content-type" } });
    results.check("a CORS preflight from another origin on a credentialed endpoint gets no CORS permission", !header(preflight, "access-control-allow-origin") && !header(preflight, "access-control-allow-credentials") && !header(preflight, "access-control-allow-methods"), `${preflight.status} ${[...preflight.headers].filter(([name]) => name.startsWith("access-control")).map(([n, v]) => `${n}: ${v}`).join(", ") || "no access-control headers"}`);

    const publicCases: Array<[string, RegExp]> = [
      ["/.well-known/openid-configuration", /^application\/json/],
      ["/.well-known/jwks.json", /^application\/(jwk-set\+)?json/],
      ["/v1/apps/briefcase/public", /^application\/json/],
      ["/sdk/v1.js", /javascript/],
    ];
    const publicFailures: string[] = [];
    for (const [path, type] of publicCases) {
      const reply = await call(`${env.site}${path}`, { origin: "https://evil.example" });
      const problems: string[] = [];
      if (reply.status !== 200) problems.push(`status ${reply.status}`);
      if (header(reply, "access-control-allow-origin") !== "*") problems.push(`Access-Control-Allow-Origin is ${header(reply, "access-control-allow-origin") || "missing"}`);
      if (header(reply, "access-control-allow-credentials")) problems.push("Access-Control-Allow-Credentials is set");
      if (header(reply, "x-content-type-options") !== "nosniff") problems.push("no nosniff");
      if (!type.test(header(reply, "content-type"))) problems.push(`Content-Type is ${header(reply, "content-type")}`);
      if (problems.length) publicFailures.push(`${path}: ${problems.join("; ")}`);
    }
    results.check("public resources (discovery, JWKS, an app's public config, the SDK) are readable from any origin (ACAO *) but never with credentials, and are nosniff", publicFailures.length === 0, publicFailures.join(" | ") || `${publicCases.length} resources`);

    const sane = `sec-${tag()}-${tag()}`;
    const echoed = await call(`${env.api}/v1/meta`, { headers: { "x-request-id": sane } });
    const insane = await call(`${env.api}/v1/meta`, { headers: { "x-request-id": `<script>${"x".repeat(200)}` } });
    results.check("a sane client X-Request-Id is echoed; a hostile one is replaced, never echoed", header(echoed, "x-request-id") === sane && !/script|x{50}/.test(header(insane, "x-request-id")) && header(insane, "x-request-id").length > 0, `${header(echoed, "x-request-id")} / ${header(insane, "x-request-id")}`);

    // 4. In the browser: no CSP violation on the pages, and no framing from another origin.
    const context = await newContext(browser);
    await context.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
      document.addEventListener("securitypolicyviolation", event => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    const page = await context.newPage();
    results.watch(page, "headers");
    const violations: string[] = [];
    for (const path of ["/", "/sign-in", `/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=b-${tag()}`]) {
      await page.goto(`${env.site}${path}`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(600);
      const seen = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []).catch(() => [] as string[]);
      violations.push(...seen.map(v => `${path}: ${v}`));
    }
    await shot(env, page, "security-headers-01-authorize");
    results.check("the site's pages load in the browser without a single CSP violation (the nonce reaches every script)", violations.length === 0, violations.join(" | ") || "0 violations on /, /sign-in, /authorize");

    // A page on another origin (a spare port of this stack, answered by the browser itself) frames the site and the embed.
    const attacker = `http://localhost:${sparePort(env, 5)}`;
    const framed = await newContext(browser, { forwardedFor: null });
    await framed.route(`${attacker}/**`, route =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>attacker</title><iframe id="home" src="${env.site}/"></iframe><iframe id="signin" src="${env.site}/sign-in"></iframe><iframe id="embed" src="${env.site}/embed/v1/buttons?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=x"></iframe>`,
      }),
    );
    const evil = await framed.newPage();
    const refusals: string[] = [];
    evil.on("console", message => {
      if (/frame-ancestors|X-Frame-Options|Refused to (display|frame|load)/i.test(message.text())) refusals.push(message.text().slice(0, 160));
    });
    await evil.goto(`${attacker}/clickjack.html`);
    await sleep(4000);
    const texts = { home: await frameText(await frameOf(evil, "home")), signin: await frameText(await frameOf(evil, "signin")), embed: await frameText(await frameOf(evil, "embed")) };
    await shot(env, evil, "security-headers-02-clickjack");
    const leaked = Object.entries(texts).filter(([, text]) => /Silicon Accounts|Continue|Sign in|Briefcase/i.test(text));
    results.check("another origin cannot frame the site's pages or briefcase's embed: the browser refuses every frame (frame-ancestors / X-Frame-Options)", leaked.length === 0, `${refusals.length} refusals in the console${refusals[0] ? ` (${refusals[0]})` : ""}; rendered: ${leaked.map(([id, text]) => `${id}="${text.slice(0, 60)}"`).join(", ") || "none"}`);

    // Control: briefcase's own page (its allowed origin) shows the same embed.
    const own = await framed.newPage();
    await own.goto(`${env.apps}/briefcase/`);
    let embedText = "";
    for (let waited = 0; waited < 20 && !/Continue|Sign in|Google|Email/i.test(embedText); waited++) {
      await sleep(500);
      const frames = own.frames().filter(frame => frame.url().startsWith(`${env.site}/embed/`));
      embedText = (await Promise.all(frames.map(frameText))).join(" ");
    }
    results.check("control: the embed renders when its app's allowed origin frames it (the same check sees a working frame)", /Continue|Sign in|Google|Email/i.test(embedText), embedText.slice(0, 120));
    await framed.close();
    await context.close();
  },
};
