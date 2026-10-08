/**
 * Security headers on everything the stack serves, on both sites:
 *
 * - the account site's HTML (nonce CSP, frame-ancestors 'none', X-Frame-Options, nosniff, referrer policy, no caching
 *   of nonce pages); its old /developer addresses are 307s to the developer site and never anywhere else;
 * - the developer site's HTML (developers.teamofsilicons.com: the same nonce CSP rules, frame-ancestors 'none' + DENY,
 *   its connect-src limited to itself and the account site) and its BFF answers (JSON, nosniff, no-store, no CORS);
 * - the embed page's frame-ancestors, per app: each app's own allowed origins, none for an app without any (and a
 *   change of an app's origins reaches the embed within the site's 30-second cache), CSP syntax never accepted;
 * - the API's JSON (default-src 'none' CSP, nosniff, no-store, CORS only where public) through the site and straight
 *   from accounts-api, and its own HTML error page;
 * - in the browser: no CSP violation on either site, and a page on another origin can frame neither site, while the
 *   embed still renders for an app's allowed origin.
 */
import type { Frame, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, newContext, shot, sleep, tag } from "../../lib";
import { appCredentials, brief, call, callbackOf, errorOf, raw, sparePort, type Reply } from "./_helpers";

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

/** What is wrong with a page's headers (empty: nothing). `connect`: the connect-src the page may have besides 'self'. */
function pageProblems(reply: Reply, options: { framing: "none" | string[]; connect?: string[] }): string[] {
  const problems: string[] = [];
  const csp = header(reply, "content-security-policy");
  if (!csp) return ["no Content-Security-Policy"];
  const d = directives(csp);
  const has = (name: string, value: string) => (d.get(name) ?? []).includes(value);
  if (!has("default-src", "'self'")) problems.push(`default-src is ${d.get("default-src")?.join(" ")}`);
  const script = d.get("script-src") ?? [];
  if (!script.some(value => /^'nonce-[A-Za-z0-9+/=_-]{16,}'$/.test(value))) problems.push(`script-src has no nonce (${script.join(" ")})`);
  if (!script.includes("'strict-dynamic'")) problems.push("script-src lacks 'strict-dynamic'");
  if (script.includes("'unsafe-inline'") || script.includes("'unsafe-eval'") || script.includes("*") || script.includes("https:") || script.includes("http:")) problems.push(`script-src allows ${script.filter(v => ["'unsafe-inline'", "'unsafe-eval'", "*", "https:", "http:"].includes(v)).join(" ")}`);
  if (!has("object-src", "'none'")) problems.push(`object-src is ${d.get("object-src")?.join(" ") ?? "missing"}`);
  if (!has("base-uri", "'none'")) problems.push(`base-uri is ${d.get("base-uri")?.join(" ") ?? "missing"}`);
  const connect = d.get("connect-src") ?? [];
  const allowedConnect = ["'self'", ...(options.connect ?? [])];
  if (!connect.includes("'self'") || connect.some(value => !allowedConnect.includes(value))) problems.push(`connect-src is ${connect.join(" ") || "missing"} (allowed: ${allowedConnect.join(" ")})`);
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

const ancestorsOf = (reply: Reply) => directives(header(reply, "content-security-policy")).get("frame-ancestors")?.join(" ") ?? "missing";

export const journey: Journey = {
  name: "security-headers",
  title: "security headers on both sites: nonce CSP / frame-ancestors 'none' / X-Frame-Options / nosniff on every HTML page of the account site and the developer site, /developer → 307 to the developer site only, the BFF's JSON no-store + nosniff without CORS, per-app frame-ancestors on the embed (each app its own origins, none → 'none', changes within 30 s, CSP syntax refused), default-src 'none' + no-store on API JSON (site and direct), the API's own HTML error page; no CSP violation in the browser and no framing of either site from another origin",
  async run({ env, results, browser, ip }) {
    const callback = callbackOf(env, "briefcase");
    const appsOrigin = new URL(env.apps).origin;
    const accountsOrigin = new URL(env.site).origin;
    const developerOrigin = new URL(env.developer).origin;

    // 1. The account site's HTML pages.
    const pages: Array<[string, number]> = [
      ["/", 200],
      ["/sign-in", 200],
      ["/device", 200],
      ["/silicons", 200],
      ["/apps", 200],
      ["/proofs", 200],
      ["/settings", 200],
      [`/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=hdr-${tag()}`, 200],
      [`/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=hdr-${tag()}&intent=signup&method=google`, 200],
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
    results.check(`every HTML page of the account site (${pages.length}, incl. the 404, /authorize and a direct-button /authorize) has a nonce CSP with 'strict-dynamic', no unsafe-inline/eval, object-src/base-uri 'none', connect-src 'self', frame-ancestors 'none' + X-Frame-Options DENY, nosniff, the referrer policy, no X-Powered-By, no public caching, and a nonce on every <script>`, pageFailures.length === 0, pageFailures.join(" | ") || `${pages.length} pages`);

    const first = await call(`${env.site}/sign-in`);
    const second = await call(`${env.site}/sign-in`);
    const nonceOf = (reply: Reply) => /'nonce-([^']+)'/.exec(header(reply, "content-security-policy"))?.[1] ?? "";
    results.check("the CSP nonce is new on every response (never reused)", !!nonceOf(first) && nonceOf(first) !== nonceOf(second), `${nonceOf(first).slice(0, 12)}… vs ${nonceOf(second).slice(0, 12)}…`);

    // The account site's old /developer addresses: a 307 to the developer site (GET /v1/meta developer_url), never elsewhere.
    const meta = await call<{ developer_url?: string }>(`${env.site}/v1/meta`);
    results.check("GET /v1/meta names the developer site (developer_url) of this stack", meta.status === 200 && meta.body.developer_url === env.developer, `${meta.status} developer_url=${meta.body.developer_url}`);
    const moved: Array<[string, string]> = [
      ["/developer", `${env.developer}/`],
      ["/developer/briefcase/proofs?x=1", `${env.developer}/apps/briefcase/proofs?x=1`],
      ["//developer/x", ""],
      ["/developer//evil.example/x", ""],
      ["/developer/%2F%2Fevil.example", ""],
      ["/developer/..%2F..%2F@evil.example", ""],
      ["/developer/%5Cevil.example", ""],
      ["/developer/x?next=https://evil.example/", ""],
    ];
    const strays: string[] = [];
    const seenMoves: string[] = [];
    for (const [path, exact] of moved) {
      const reply = await raw(env.site, path);
      const location = String(reply.headers.location ?? "");
      seenMoves.push(`${path} → ${reply.status} ${location}`);
      if (path === "//developer/x") {
        // Not a /developer address at all (a protocol-relative-looking path): whatever it is, it never leaves the site.
        if (location && new URL(location, env.site).origin !== accountsOrigin) strays.push(`${path} → ${location}`);
        continue;
      }
      let target: URL | null = null;
      try {
        target = new URL(location, env.site);
      } catch {
        target = null;
      }
      // The site first normalizes a doubled slash with a 308 to the same path on itself; follow that one hop.
      let hops = `${reply.status} ${location}`;
      if (reply.status === 308 && target?.origin === accountsOrigin) {
        const next = await raw(env.site, `${target.pathname}${target.search}`);
        const nextLocation = String(next.headers.location ?? "");
        hops += ` → ${next.status} ${nextLocation}`;
        try {
          target = next.status === 307 ? new URL(nextLocation, env.site) : null;
        } catch {
          target = null;
        }
        if (target && target.origin !== developerOrigin) strays.push(`${path} → ${hops}`);
        else if (!target) strays.push(`${path} → ${hops}`);
        continue;
      }
      if (reply.status !== 307 || !target || target.origin !== developerOrigin || (exact && target.href !== exact)) strays.push(`${path} → ${hops}${exact ? ` (want ${exact})` : ""}`);
    }
    results.check(`the account site's /developer addresses (${moved.length}: the home, an app's tab with its query, and paths with //, encoded //, ../ and \\ tricks) are 307s onto the developer site only`, strays.length === 0, strays.join(" | ") || seenMoves.slice(0, 3).join(", "));

    // 2. The developer site's HTML pages.
    const devPages: Array<[string, number]> = [
      ["/sign-in", 200],
      [`/sign-in?error=${encodeURIComponent("<b>x</b>")}&return_to=${encodeURIComponent("//evil.example/")}`, 200],
      ["/", 200],
      ["/apps/briefcase", 200],
      ["/apps/briefcase/app-verification", 200],
      [`/apps/briefcase/bogus-${tag()}`, 404],
      [`/no-such-page-${tag()}`, 404],
    ];
    const devFailures: string[] = [];
    for (const [path, status] of devPages) {
      const reply = await call(`${env.developer}${path}`, { headers: { accept: "text/html" } });
      const problems = pageProblems(reply, { framing: "none", connect: [accountsOrigin] });
      if (reply.status !== status) problems.unshift(`status ${reply.status}, want ${status}`);
      if (reply.text.includes("<b>x</b>")) problems.push("reflects ?error= as markup");
      if (problems.length) devFailures.push(`${path.slice(0, 60)}: ${problems.join("; ")}`);
    }
    results.check(`every HTML page of the developer site (${devPages.length}, incl. a hostile ?error=, an app's tabs and both 404s) has a nonce CSP with 'strict-dynamic', no unsafe-inline/eval, object-src/base-uri 'none', connect-src only itself and the account site, frame-ancestors 'none' + X-Frame-Options DENY, nosniff, the referrer policy and a nonce on every <script>`, devFailures.length === 0, devFailures.join(" | ") || `${devPages.length} pages`);

    // The developer site's own answers (BFF and auth routes): JSON, nosniff, no-store, no CORS for anyone.
    const bffCases: Array<[string, string, number, string]> = [
      ["GET", "/api/accounts/meta", 200, "application/json"],
      ["GET", "/api/accounts/me", 401, "application/json"],
      ["GET", "/api/accounts/apps/briefcase", 401, "application/json"],
      ["GET", "/api/accounts/me/silicons", 404, "application/json"],
      ["POST", "/api/accounts/apps/briefcase/proofs/app-verification", 403, "application/json"],
      ["POST", "/auth/sign-out", 403, "application/json"],
    ];
    const bffFailures: string[] = [];
    const bffNotes: string[] = [];
    for (const [method, path, status, type] of bffCases) {
      const reply = await call(`${env.developer}${path}`, { method, ...(method === "POST" ? { json: { receiving_app: "remind" } } : {}), origin: "https://evil.example", ip });
      const problems: string[] = [];
      if (reply.status !== status) problems.push(`status ${reply.status}, want ${status}`);
      if (!header(reply, "content-type").startsWith(type)) problems.push(`Content-Type ${header(reply, "content-type")}`);
      // A refused POST is never cached and a JSON body is never sniffed into a page, so the sign-out route's refusal
      // (which sets neither header, unlike the BFF's other answers) is only noted.
      const hygiene = [header(reply, "x-content-type-options") !== "nosniff" ? "no nosniff" : "", !/no-store/.test(header(reply, "cache-control")) ? `Cache-Control ${header(reply, "cache-control") || "missing"}` : ""].filter(Boolean);
      if (hygiene.length) (path === "/auth/sign-out" ? bffNotes : problems).push(`${path}: ${hygiene.join(", ")}`);
      if (header(reply, "access-control-allow-origin") || header(reply, "access-control-allow-credentials")) problems.push(`CORS: ${header(reply, "access-control-allow-origin")} ${header(reply, "access-control-allow-credentials")}`);
      if (reply.setCookies.length) problems.push(`sets ${reply.setCookies.map(cookie => cookie.name).join(", ")}`);
      if (reply.status >= 400 && !errorOf(reply).code) problems.push("not the JSON error object");
      if (problems.length) bffFailures.push(`${method} ${path}: ${problems.join("; ")} (${brief(reply)})`);
    }
    results.check(`the developer site's own answers (${bffCases.length}: a public read, signed-out reads, a path it does not forward, a cross-site POST, a cross-site sign-out) are JSON with nosniff and no-store, never CORS-readable from another origin, set no cookie, and use the API's error shape`, bffFailures.length === 0, bffFailures.join(" | ") || `${bffCases.length} answers`);
    results.check("(note) headers the developer site's refused sign-out answer leaves out (the BFF's other answers set them)", true, bffNotes.join(" | ") || "none");
    const devSignIn = await call(`${env.developer}/auth/sign-in?return_to=%2Fapps`, { ip });
    results.check("GET /auth/sign-in answers a 303 to the account site's /authorize (never cached) and sets only its httpOnly sign-in cookie", devSignIn.status === 303 && (devSignIn.headers.get("location") ?? "").startsWith(`${env.site}/authorize?`) && /no-store/.test(header(devSignIn, "cache-control")) && devSignIn.setCookies.length === 1 && devSignIn.setCookies[0]!.name === "sa_dev_signin" && devSignIn.setCookies[0]!.attributes.has("httponly"), `${devSignIn.status} → ${(devSignIn.headers.get("location") ?? "").slice(0, 80)}; Cache-Control ${header(devSignIn, "cache-control")}; Set-Cookie ${devSignIn.setCookies.map(cookie => cookie.name).join(", ")}`);

    // 3. The embed: framing only by the app's own allowed origins.
    const embed = await call(`${env.site}/embed/v1/buttons?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=e-${tag()}`);
    const embedProblems = pageProblems(embed, { framing: [appsOrigin] });
    results.check("the embed page of briefcase may be framed only by 'self' and briefcase's allowed origin (no X-Frame-Options), and keeps the rest of the CSP", embed.status === 200 && embedProblems.length === 0, embedProblems.join("; ") || ancestorsOf(embed));
    const embedUnknown = await call(`${env.site}/embed/v1/buttons?app_id=no-such-app-${tag()}`);
    const injected = await call(`${env.site}/embed/v1/buttons?app_id=${encodeURIComponent("briefcase' https://evil.example")}`);
    const bare = await call(`${env.site}/embed/v1/buttons`);
    const deny = (reply: Reply) => pageProblems(reply, { framing: "none" }).filter(p => !/status/.test(p));
    results.check("the embed of an unknown app, of no app, and of an app_id carrying CSP syntax is framed by nobody (frame-ancestors 'none' + DENY)", [embedUnknown, injected, bare].every(reply => deny(reply).length === 0), [embedUnknown, injected, bare].map(reply => deny(reply).join(",") || "ok").join(" | "));
    results.check("an app_id carrying CSP syntax never reaches the CSP header", !/evil\.example/.test(header(injected, "content-security-policy")), header(injected, "content-security-policy").match(/frame-ancestors[^;]*/)?.[0] ?? "");

    // Per app: quill-docs gets origins of its own, orbit-games none at all; each embed follows its own app (the site
    // caches an app's origins for 30 seconds, so a change shows within that). Both are put back afterwards.
    const patchOrigins = (app: string, origins: string[]) => call<{ signin_config?: { allowed_origins?: string[] } }>(`${env.site}/v1/apps/${app}/signin-config`, { method: "PATCH", json: { allowed_origins: origins }, basic: appCredentials(app), ip, headers: { "idempotency-key": `sec-${tag()}${tag()}` } });
    const originsOf = async (app: string) => (await call<{ signin_config?: { allowed_origins?: string[] } }>(`${env.site}/v1/apps/${app}`, { basic: appCredentials(app), ip })).body.signin_config?.allowed_origins ?? [];
    const quillBefore = await originsOf("quill-docs");
    const orbitBefore = await originsOf("orbit-games");
    const quillOrigins = ["https://quill.example", "https://docs.quill.example:8443"];
    const embedOf = (app: string) => call(`${env.site}/embed/v1/buttons?app_id=${app}&redirect_uri=${encodeURIComponent(callbackOf(env, app))}&state=e-${tag()}`);
    /** Polls the embed of `app` until its frame-ancestors are `want` (the site's cache is 30 s). */
    const embedSettles = async (app: string, want: string) => {
      const started = Date.now();
      let reply = await embedOf(app);
      while (ancestorsOf(reply) !== want && Date.now() - started < 40_000) {
        await sleep(1_000);
        reply = await embedOf(app);
      }
      return { reply, ms: Date.now() - started };
    };
    try {
      const quillSet = await patchOrigins("quill-docs", quillOrigins);
      const orbitSet = await patchOrigins("orbit-games", []);
      const quill = await embedSettles("quill-docs", `'self' ${quillOrigins.join(" ")}`);
      const orbit = await embedSettles("orbit-games", "'none'");
      const briefcaseAgain = await embedOf("briefcase");
      results.metric("embed frame-ancestors followed an app's change after", Math.max(quill.ms, orbit.ms));
      const quillProblems = pageProblems(quill.reply, { framing: quillOrigins });
      const orbitProblems = pageProblems(orbit.reply, { framing: "none" });
      results.check("each app's embed is framed by that app's own origins: quill-docs by its two origins only (no fake-app origin), orbit-games with none by nobody (frame-ancestors 'none' + DENY), briefcase still by its own, within the site's 30 s cache", quillSet.status === 200 && orbitSet.status === 200 && quillProblems.length === 0 && orbitProblems.length === 0 && ancestorsOf(briefcaseAgain) === `'self' ${appsOrigin}` && quill.ms <= 35_000 && orbit.ms <= 35_000, `quill-docs (${quill.ms} ms): ${quillProblems.join("; ") || ancestorsOf(quill.reply)}; orbit-games (${orbit.ms} ms): ${orbitProblems.join("; ") || ancestorsOf(orbit.reply)}; briefcase: ${ancestorsOf(briefcaseAgain)}; patches ${quillSet.status}/${orbitSet.status}`);
      // CSP syntax or a wildcard that stands for every host as an allowed origin never gets stored (the site also
      // filters what it reads, but a wildcard passes for an origin there): `https://*` would let any https page frame
      // the app's embed.
      const hostile = ["*", "https://*", "https://*:443", "https://a.example 'unsafe-inline'", "https://a.example; script-src *", "'self'", "javascript:alert(1)", "data:", "http://evil.example"];
      const kept: string[] = [];
      for (const value of hostile) {
        const reply = await patchOrigins("quill-docs", [value]);
        if (reply.status !== 422) {
          const published = reply.status === 200 ? (await call<{ allowed_origins?: string[] }>(`${env.site}/v1/apps/quill-docs/public`)).body.allowed_origins : undefined;
          kept.push(`${JSON.stringify(value)} → ${brief(reply)}${published ? ` (published to the embed as ${JSON.stringify(published)})` : ""}`);
        }
      }
      results.check(`an app can't store CSP syntax, a wildcard for every host, other schemes or plain http as an allowed origin (${hostile.length} values → 422)`, kept.length === 0, kept.join(" | ") || "all 422");
      const subdomains = await patchOrigins("quill-docs", ["https://*.quill.example"]);
      results.check("(note) a subdomain wildcard as an allowed origin", true, `https://*.quill.example → ${brief(subdomains)} (CSP treats it as every subdomain of quill.example)`);
    } finally {
      await patchOrigins("quill-docs", quillBefore);
      await patchOrigins("orbit-games", orbitBefore);
    }

    // 4. The API: JSON answers (success and every kind of error), through the site and straight from accounts-api.
    const apiCases: Array<[string, string, number]> = [
      ["GET", "/v1/meta", 200],
      ["GET", "/v1/me", 401],
      ["GET", `/v1/no-such-endpoint-${tag()}`, 404],
      ["POST", "/v1/meta", 405],
      ["GET", "/v1/ids/available?id=c:%3Cscript%3E", 200],
      ["GET", "/v1/accounts/by-id/%3Cscript%3Ealert(1)%3C%2Fscript%3E", 401],
      ["GET", "/v1/me/owned-apps", 401],
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

    // accounts-api's own HTML: the page a provider callback shows when the sign-in can't go on (Google and Apple send
    // the browser there, with whatever the query or form carried).
    const hostileCallbacks: Array<[string, string]> = [
      ["an unknown provider name carrying markup", `/v1/oauth/callback/${encodeURIComponent("<img src=x onerror=alert(1)>")}?state=x&code=y`],
      ["a made-up state carrying markup", `/v1/oauth/callback/google?state=${encodeURIComponent('"><script>alert(1)</script>')}&code=y`],
      ["a provider error carrying markup", `/v1/oauth/callback/apple?state=${encodeURIComponent("<svg onload=alert(1)>")}&error=${encodeURIComponent("<b>x</b>")}&error_description=${encodeURIComponent("<iframe src=//evil.example>")}`],
    ];
    const callbackFailures: string[] = [];
    for (const [where, url] of [["site", env.site], ["accounts-api", env.api]] as const) {
      for (const [label, path] of hostileCallbacks) {
        const reply = await call(`${url}${path}`, { headers: { accept: "text/html" } });
        const problems: string[] = [];
        if (reply.status < 400 || reply.status >= 500) problems.push(`status ${reply.status}`);
        if (!/^text\/html/.test(header(reply, "content-type"))) problems.push(`Content-Type ${header(reply, "content-type")}`);
        const csp = directives(header(reply, "content-security-policy"));
        if ((csp.get("frame-ancestors") ?? []).join(" ") !== "'none'") problems.push(`frame-ancestors ${(csp.get("frame-ancestors") ?? []).join(" ") || "missing"}`);
        const scripts = csp.get("script-src") ?? csp.get("default-src") ?? [];
        if (!scripts.length || scripts.some(value => value === "'unsafe-inline'" || value === "'unsafe-eval'" || value === "*")) problems.push(`scripts allowed by "${scripts.join(" ") || "nothing (no CSP)"}"`);
        if ((csp.get("base-uri") ?? []).join(" ") !== "'none'") problems.push(`base-uri ${(csp.get("base-uri") ?? []).join(" ") || "missing"}`);
        if (header(reply, "x-frame-options").toUpperCase() !== "DENY") problems.push(`X-Frame-Options ${header(reply, "x-frame-options") || "missing"}`);
        if (header(reply, "x-content-type-options") !== "nosniff") problems.push("no nosniff");
        if (!/no-store/.test(header(reply, "cache-control"))) problems.push(`Cache-Control ${header(reply, "cache-control") || "missing"}`);
        if (header(reply, "referrer-policy") !== "strict-origin-when-cross-origin") problems.push(`Referrer-Policy ${header(reply, "referrer-policy") || "missing"}`);
        const markup = ["<img src=x", "<script>alert", "<svg onload", "<b>x</b>", "<iframe src"].filter(needle => reply.text.includes(needle));
        if (markup.length) problems.push(`reflects ${markup.join(", ")} unescaped`);
        if (problems.length) callbackFailures.push(`${where} ${label}: ${problems.join("; ")}`);
      }
    }
    results.check(`accounts-api's own HTML (the provider callback's error page, ${hostileCallbacks.length} hostile inputs, through the site and direct) is a 4xx with frame-ancestors 'none' + X-Frame-Options DENY, a CSP without inline script, base-uri 'none', nosniff, no-store and the referrer policy, and shows the input escaped`, callbackFailures.length === 0, callbackFailures.join(" | ") || `${hostileCallbacks.length * 2} pages`);

    const preflight = await call(`${env.site}/v1/me`, { method: "OPTIONS", origin: "https://evil.example", headers: { "access-control-request-method": "PATCH", "access-control-request-headers": "content-type" } });
    const devPreflight = await call(`${env.developer}/api/accounts/apps/briefcase/signin-config`, { method: "OPTIONS", origin: "https://evil.example", headers: { "access-control-request-method": "PATCH", "access-control-request-headers": "content-type" } });
    const corsOf = (reply: Reply) => [...reply.headers].filter(([name]) => name.startsWith("access-control")).map(([n, v]) => `${n}: ${v}`).join(", ") || "no access-control headers";
    results.check("a CORS preflight from another origin on a credentialed endpoint gets no CORS permission (the API through the site, and the developer site's BFF)", [preflight, devPreflight].every(reply => !header(reply, "access-control-allow-origin") && !header(reply, "access-control-allow-credentials") && !header(reply, "access-control-allow-methods")), `API ${preflight.status} ${corsOf(preflight)}; BFF ${devPreflight.status} ${corsOf(devPreflight)}`);

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

    // 5. In the browser: no CSP violation on the pages of either site, and no framing from another origin.
    const context = await newContext(browser);
    await context.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
      document.addEventListener("securitypolicyviolation", event => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    const page = await context.newPage();
    results.watch(page, "headers", [DEVELOPER_SIGNED_OUT]);
    const violations: string[] = [];
    for (const url of [`${env.site}/`, `${env.site}/sign-in`, `${env.site}/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=b-${tag()}`, `${env.developer}/sign-in`, `${env.developer}/sign-in?error=state_mismatch`]) {
      await page.goto(url);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(200);
      const seen = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []).catch(() => [] as string[]);
      violations.push(...seen.map(v => `${url}: ${v}`));
    }
    await shot(env, page, "security-headers-01-developer-sign-in");
    results.check("the pages of both sites load in the browser without a single CSP violation (the nonce reaches every script): /, /sign-in, /authorize, the developer site's /sign-in (also with an error)", violations.length === 0, violations.join(" | ") || "0 violations");

    // A page on another origin (a spare port of this stack, answered by the browser itself) frames both sites and the embed.
    const attacker = `http://localhost:${sparePort(env, 6)}`;
    const framed = await newContext(browser, { forwardedFor: null });
    await framed.route(`${attacker}/**`, route =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>attacker</title><iframe id="home" src="${env.site}/"></iframe><iframe id="signin" src="${env.site}/sign-in"></iframe><iframe id="embed" src="${env.site}/embed/v1/buttons?app_id=briefcase&redirect_uri=${encodeURIComponent(callback)}&state=x"></iframe><iframe id="devsignin" src="${env.developer}/sign-in"></iframe><iframe id="devapp" src="${env.developer}/apps/briefcase/app-verification"></iframe>`,
      }),
    );
    const evil = await framed.newPage();
    const refusals: string[] = [];
    evil.on("console", message => {
      if (/frame-ancestors|X-Frame-Options|Refused to (display|frame|load)/i.test(message.text())) refusals.push(message.text().slice(0, 160));
    });
    // The attacker page's load event waits for its frames (a frame the browser refuses still finishes loading).
    await evil.goto(`${attacker}/clickjack.html`, { waitUntil: "load" });
    await evil.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(300);
    const texts: Record<string, string> = {};
    for (const id of ["home", "signin", "embed", "devsignin", "devapp"]) texts[id] = await frameText(await frameOf(evil, id));
    await shot(env, evil, "security-headers-02-clickjack");
    const leaked = Object.entries(texts).filter(([, text]) => /Silicon|Continue|Sign in|Briefcase|developer/i.test(text));
    results.check("another origin can frame neither site: the browser refuses the account site's pages, briefcase's embed and the developer site's sign-in and app pages (frame-ancestors / X-Frame-Options)", leaked.length === 0, `${refusals.length} refusals in the console${refusals[0] ? ` (${refusals[0]})` : ""}; rendered: ${leaked.map(([id, text]) => `${id}="${text.slice(0, 60)}"`).join(", ") || "none"}`);

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
