/**
 * Cookies: the flow-binding, sign-up and session cookies carry HttpOnly, SameSite=Lax, Path=/ and no Domain with the
 * contract lifetimes, hold 32 random bytes, are invisible to page scripts, die server-side on sign-out, and a session
 * planted by someone else is never upgraded to the Carbon who signs in (fixation). A second accounts-api on the stack's
 * database with ACCOUNTS_COOKIE_SECURE=true names them `__Host-…` with Secure, sends HSTS, and ignores the unprefixed
 * names (a tossed cookie can't stand in for the session).
 */
import type { Journey } from "../../context";
import { newContext, signInOnSite, sql, tag } from "../../lib";
import { brief, call, remember, runBinary, signInWithEmail, sparePort, startFlow, flowOf, viaSite, waitReady, Jar, type SetCookie, type Target } from "./_helpers";

const LIFETIMES: Record<string, number> = { sa_flow: 3600, sa_signup: 172_800, sa_session: 77_760_000 };
const PREFIXES: Record<string, string> = { sa_flow: "saf_", sa_signup: "sau_", sa_session: "sas_" };

/** What is wrong with one Set-Cookie line of `base` (secure: the __Host- form). */
function cookieProblems(cookie: SetCookie | undefined, base: string, secure: boolean): string[] {
  if (!cookie) return [`no ${secure ? "__Host-" : ""}${base} was set`];
  const problems: string[] = [];
  const a = cookie.attributes;
  if (cookie.name !== (secure ? `__Host-${base}` : base)) problems.push(`named ${cookie.name}`);
  if (!a.has("httponly")) problems.push("not HttpOnly");
  if ((a.get("samesite") ?? "").toLowerCase() !== "lax") problems.push(`SameSite=${a.get("samesite") ?? "missing"}`);
  if (a.get("path") !== "/") problems.push(`Path=${a.get("path") ?? "missing"}`);
  if (a.has("domain")) problems.push(`Domain=${a.get("domain")}`);
  if (secure !== a.has("secure")) problems.push(secure ? "not Secure" : "Secure on an http stack");
  if (Number(a.get("max-age")) !== LIFETIMES[base]) problems.push(`Max-Age=${a.get("max-age")} (want ${LIFETIMES[base]})`);
  if (!new RegExp(`^${PREFIXES[base]}[A-Za-z0-9_-]{43}$`).test(cookie.value)) problems.push(`value ${cookie.value.slice(0, 8)}… is not ${PREFIXES[base]} + 32 random bytes`);
  return problems;
}

export const journeys: Journey[] = [
  {
    name: "security-cookies",
    title: "cookie flags: sa_flow / sa_signup / sa_session are HttpOnly, SameSite=Lax, Path=/, host-only, contract lifetimes, 32 random bytes; page scripts can't see them; sign-out revokes the session server-side; a planted session is never upgraded (fixation)",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const t = viaSite(ctx);

      // 1. The three cookies of a sign-up, as the site (the public origin) hands them to the browser.
      const carbon = await signInWithEmail(t, { label: "cookies" });
      remember(ctx, "session cookie", carbon.jar.get("sa_session"));
      remember(ctx, "code", carbon.code);
      for (const base of ["sa_flow", "sa_signup", "sa_session"]) {
        const cookie = carbon.jar.seen.find(c => c.name === base && c.value);
        const problems = cookieProblems(cookie, base, false);
        results.check(`${base}: HttpOnly; SameSite=Lax; Path=/; no Domain; Max-Age ${LIFETIMES[base]} s; ${PREFIXES[base]} + 32 random bytes`, problems.length === 0, problems.join("; ") || cookie!.line.replace(/=[^;]{12}[^;]*/, "=…"));
      }
      const other = await signInWithEmail(t, { label: "cookies2" });
      results.check("every browser gets its own random values (two sign-ups share no cookie value)", ["sa_flow", "sa_session"].every(name => other.jar.get(name) && other.jar.get(name) !== carbon.jar.get(name) && (other.jar.get(name) ?? "").length > 40));

      // 2. Sign-out ends the session on the server, not only in the browser.
      const oldSession = other.jar.get("sa_session") ?? "";
      const signout = await call(`${env.site}/v1/session/signout`, { method: "POST", body: "", jar: other.jar, origin: env.site, ip: ctx.ip });
      const clears = signout.setCookies.filter(cookie => cookie.attributes.get("max-age") === "0").map(cookie => cookie.name);
      const replay = await call(`${env.site}/v1/session`, { headers: { cookie: `sa_session=${oldSession}` }, ip: ctx.ip });
      results.check("sign-out answers 204, clears sa_session and sa_signup, and the old cookie value is dead on the server (a copied cookie can't be replayed)", signout.status === 204 && clears.includes("sa_session") && clears.includes("sa_signup") && replay.status === 401, `sign-out ${brief(signout)} clears ${clears.join(", ")}; replayed old cookie → ${brief(replay)}`);

      // 3. Session fixation: a browser carrying someone else's session (or a made-up one) signs in as its own Carbon.
      const attacker = await signInWithEmail(t, { label: "fixer" });
      const planted = attacker.jar.get("sa_session") ?? "";
      const victimJar = new Jar();
      victimJar.set("sa_session", planted);
      const victim = await signInWithEmail(t, { label: "fixed", jar: victimJar });
      const issued = victim.jar.get("sa_session") ?? "";
      const plantedNow = await call<{ account?: { uuid: string } }>(`${env.site}/v1/session`, { headers: { cookie: `sa_session=${planted}` }, ip: ctx.ip });
      results.check("a session planted in the browser before a sign-up is replaced by a new session for the new Carbon; the planted one never becomes the victim's", issued !== planted && victim.uuid !== attacker.uuid && plantedNow.body.account?.uuid !== victim.uuid, `new cookie ${issued !== planted ? "differs" : "IS THE PLANTED ONE"}; planted cookie now → ${plantedNow.status} ${plantedNow.body.account?.uuid ?? ""} (attacker ${attacker.uuid}, victim ${victim.uuid})`);
      const existingJar = new Jar();
      existingJar.set("sa_session", planted);
      const again = await signInWithEmail(t, { email: victim.email, jar: existingJar });
      const plantedAfter = await call<{ account?: { uuid: string } }>(`${env.site}/v1/session`, { headers: { cookie: `sa_session=${planted}` }, ip: ctx.ip });
      results.check("…and the same for an existing Carbon signing in with a code over a planted session", again.uuid === victim.uuid && (again.jar.get("sa_session") ?? planted) !== planted && plantedAfter.body.account?.uuid !== victim.uuid, `signed in as ${again.id}; planted cookie → ${plantedAfter.status} ${plantedAfter.body.account?.uuid ?? ""}`);
      // A session past its lifetime (time travel on the stack's database) is no session, whatever the cookie's Max-Age.
      const expiring = await signInWithEmail(t, { label: "expiry" });
      const expiringCookie = expiring.jar.get("sa_session") ?? "";
      const liveBefore = await call(`${env.site}/v1/session`, { headers: { cookie: `sa_session=${expiringCookie}` }, ip: ctx.ip });
      await sql(env, `update browser_sessions set expires_at = now() - interval '1 second' where account_uuid = '${expiring.uuid}'`);
      const liveAfter = await call(`${env.site}/v1/session`, { headers: { cookie: `sa_session=${expiringCookie}` }, ip: ctx.ip });
      const mutateAfter = await call(`${env.site}/v1/me`, { method: "PATCH", json: { display_name: "Expired" }, headers: { cookie: `sa_session=${expiringCookie}` }, origin: env.site, ip: ctx.ip });
      results.check("a session past its expiry (time travel) is refused (401) for reads and mutations, though the browser would still send the cookie", liveBefore.status === 200 && liveAfter.status === 401 && mutateAfter.status === 401, `before ${liveBefore.status}, after ${brief(liveAfter)}, PATCH ${mutateAfter.status}`);
      const madeUp = new Jar();
      madeUp.set("sa_session", `sas_${"A".repeat(43)}`);
      const guessed = await call(`${env.site}/v1/session`, { jar: madeUp, ip: ctx.ip });
      results.check("a made-up session cookie is no session", guessed.status === 401, brief(guessed));

      // 4. In the browser: the cookies exist with these flags and page scripts can't read them.
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "cookies");
      await signInOnSite(env, page, `sec.cookies.browser.${tag()}@example.test`);
      const cookies = await context.cookies(env.site);
      const session = cookies.find(cookie => cookie.name === "sa_session");
      results.check("in the browser sa_session is httpOnly, SameSite=Lax and host-only for the site", !!session && session.httpOnly && session.sameSite === "Lax" && session.domain === new URL(env.site).hostname && session.path === "/", JSON.stringify(session ? { httpOnly: session.httpOnly, sameSite: session.sameSite, domain: session.domain, path: session.path, secure: session.secure } : null));
      const visible = await page.evaluate(() => document.cookie);
      results.check("page scripts can't see any of the site's cookies (document.cookie has no sa_session / sa_flow / sa_signup)", !/sa_session|sa_flow|sa_signup/.test(visible), visible ? `document.cookie = ${visible.slice(0, 120)}` : "document.cookie is empty");
      await context.close();
    },
  },
  {
    name: "security-cookies-secure",
    title: "ACCOUNTS_COOKIE_SECURE=true (a second accounts-api on the stack's database): __Host-sa_flow / __Host-sa_signup / __Host-sa_session with Secure, HSTS on every answer, unprefixed (tossed) cookies ignored, no cookie cleared by another site's sign-out",
    engines: ["chromium"],
    async run(ctx) {
      const { env, results } = ctx;
      const port = sparePort(env, 6);
      const server = runBinary(env, "accounts-api", { ACCOUNTS_BIND_ADDR: `127.0.0.1:${port}`, ACCOUNTS_COOKIE_SECURE: "true", ACCOUNTS_WORKER_ENABLED: "false", ACCOUNTS_TELEMETRY_ENABLED: "false" }, { stackEnv: true });
      try {
        const readyMs = await waitReady(`http://127.0.0.1:${port}/readyz`, server);
        results.metric("secure-cookie accounts-api ready after", readyMs);
        const secure: Target = { env, url: `http://127.0.0.1:${port}`, origin: env.site, ip: ctx.ip };

        const meta = await call(`${secure.url}/v1/meta`);
        const hsts = meta.headers.get("strict-transport-security") ?? "";
        results.check("with secure cookies every answer carries HSTS (two years, subdomains)", /max-age=(\d+)/.test(hsts) && Number(/max-age=(\d+)/.exec(hsts)![1]) >= 31_536_000 && /includesubdomains/i.test(hsts), hsts || "no Strict-Transport-Security");

        const flowJar = new Jar();
        const created = await startFlow(secure, flowJar, { app_id: "briefcase", redirect_uri: `${env.apps}/briefcase/callback`, state: `s-${tag()}` });
        const flowProblems = cookieProblems(flowJar.last("__Host-sa_flow"), "sa_flow", true);
        results.check("POST /v1/flows sets __Host-sa_flow: Secure; HttpOnly; SameSite=Lax; Path=/; no Domain", created.status === 201 && flowProblems.length === 0, flowProblems.join("; ") || flowJar.last("__Host-sa_flow")!.line.replace(/=[^;]{12}[^;]*/, "=…"));
        const unprefixedFlow = await call(`${secure.url}/v1/flows/${flowOf(created)?.id ?? "x"}`, { headers: { cookie: `sa_flow=${flowJar.get("__Host-sa_flow")}` } });
        results.check("…and the flow ignores the same value under the unprefixed name sa_flow (403 flow_not_bound)", unprefixedFlow.status === 403, brief(unprefixedFlow));

        const carbon = await signInWithEmail(secure, { label: "secure" });
        remember(ctx, "session cookie", carbon.jar.get("__Host-sa_session"));
        remember(ctx, "code", carbon.code);
        for (const base of ["sa_signup", "sa_session"]) {
          const cookie = carbon.jar.seen.find(c => c.name === `__Host-${base}` && c.value);
          const problems = cookieProblems(cookie, base, true);
          results.check(`a sign-up sets __Host-${base}: Secure; HttpOnly; SameSite=Lax; Path=/; no Domain; Max-Age ${LIFETIMES[base]}`, problems.length === 0, problems.join("; ") || cookie!.line.replace(/=[^;]{12}[^;]*/, "=…"));
        }
        const value = carbon.jar.get("__Host-sa_session") ?? "";
        const prefixed = await call(`${secure.url}/v1/session`, { headers: { cookie: `__Host-sa_session=${value}` } });
        const tossed = await call(`${secure.url}/v1/session`, { headers: { cookie: `sa_session=${value}` } });
        results.check("the session works under __Host-sa_session and is ignored under the unprefixed sa_session (a cookie tossed from a sibling host can't be the session)", prefixed.status === 200 && tossed.status === 401, `__Host- ${prefixed.status}, unprefixed ${brief(tossed)}`);
        const mutation = await call(`${secure.url}/v1/me`, { method: "PATCH", json: { display_name: `Secure ${tag()}` }, headers: { cookie: `__Host-sa_session=${value}` }, origin: "https://evil.example" });
        results.check("the Origin guard holds in secure mode too (403 origin_not_allowed)", mutation.status === 403, brief(mutation));
        const out = await call(`${secure.url}/v1/session/signout`, { method: "POST", body: "", headers: { cookie: `__Host-sa_session=${value}` }, origin: env.site });
        const cleared = out.setCookies.find(cookie => cookie.name === "__Host-sa_session");
        results.check("sign-out clears __Host-sa_session (Secure; Max-Age=0)", out.status === 204 && cleared?.attributes.get("max-age") === "0" && cleared.attributes.has("secure"), cleared?.line ?? brief(out));
        const stranger = await call(`${secure.url}/v1/session/signout`, { method: "POST", body: "", origin: "https://evil.example" });
        const staleOut = await call(`${secure.url}/v1/session/signout`, { method: "POST", body: "", headers: { cookie: `__Host-sa_session=${value}` }, origin: env.site });
        const staleCleared = staleOut.setCookies.filter(cookie => cookie.attributes.get("max-age") === "0").map(cookie => cookie.name);
        results.check("in secure mode too, a cookieless sign-out from another site gets 401 with no Set-Cookie, while the site's own pages clean up the dead session (401, __Host-sa_session and __Host-sa_signup cleared)", stranger.status === 401 && stranger.setCookies.length === 0 && staleOut.status === 401 && staleCleared.includes("__Host-sa_session") && staleCleared.includes("__Host-sa_signup"), `another site: ${brief(stranger)}, Set-Cookie ${stranger.setCookies.map(cookie => cookie.name).join(", ") || "none"}; site: ${brief(staleOut)}, clears ${staleCleared.join(", ") || "nothing"}`);
        results.check("the secure-mode server never printed a secret it handed out", ![value, carbon.code, flowJar.get("__Host-sa_flow") ?? ""].some(secret => secret && server.output().includes(secret)), `${server.output().length} bytes of output scanned`);
      } finally {
        await server.stop();
      }
    },
  },
];
