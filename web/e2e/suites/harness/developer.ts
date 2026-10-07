/**
 * The harness checks its developer site: every stack runs its own (developer/, base + 5, its own build directory), wired
 * to this stack's accounts-api and account site, so a sign-in on one stack never lands on another. Fast, no browser.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { REPO_ROOT, json } from "../../lib";

export const journey: Journey = {
  name: "harness-developer",
  title: "the harness itself: this stack's developer site (base + 5) is its own build, its BFF reaches this stack's API, and its sign-in goes to this stack's account site and back to its own origin",
  async run(ctx) {
    const { env, results } = ctx;
    const developer = new URL(env.developer);
    results.check("the developer site is on base + 5 (http://localhost, its public origin)", developer.hostname === "localhost" && (env.base === 8590 ? developer.port === "8600" : developer.port === String(env.base + 5)), env.developer);
    if (env.base !== 8590) {
      const build = join(REPO_ROOT, "developer", `.next-${env.base}`);
      // A production build (standalone server) or `next dev` (scripts/e2e.sh --dev) in its own directory.
      results.check("…built into its own directory (developer/.next-<base>)", existsSync(join(build, "standalone", "server.js")) || existsSync(join(build, "dev")) || existsSync(join(build, "BUILD_ID")), build);
    }

    // accounts-api knows it (the `developer` app's redirect rule, GET /v1/meta developer_url).
    const meta = await json<{ public_url?: string; developer_url?: string }>(`${env.api}/v1/meta`);
    results.check("this stack's accounts-api names this developer site (developer_url)", meta.body.developer_url === env.developer, String(meta.body.developer_url));

    // Its BFF reaches this stack's accounts-api: the public meta read goes through without a session.
    const viaBff = await json<{ public_url?: string; developer_url?: string }>(`${env.developer}/api/accounts/meta`);
    results.check("its BFF (/api/accounts/meta) reaches this stack's accounts-api", viaBff.status === 200 && viaBff.body.public_url === env.site && viaBff.body.developer_url === env.developer, `${viaBff.status} ${JSON.stringify(viaBff.body).slice(0, 160)}`);
    const signedOut = await fetch(`${env.developer}/api/accounts/me`);
    results.check("…and answers 401 for account reads without its session cookie", signedOut.status === 401, String(signedOut.status));

    // Its sign-in starts on this stack's account site, as the app `developer`, back to its own /auth/callback.
    const start = await fetch(`${env.developer}/auth/sign-in?return_to=%2Fapps%2Fbriefcase`, { redirect: "manual" });
    const location = new URL(start.headers.get("location") ?? "about:blank");
    results.check("/auth/sign-in sends the browser to this stack's /authorize as `developer` with PKCE S256", (start.status === 303 || start.status === 307 || start.status === 302) && location.href.startsWith(`${env.site}/authorize?`) && location.searchParams.get("app_id") === "developer" && location.searchParams.get("redirect_uri") === `${env.developer}/auth/callback` && location.searchParams.get("code_challenge_method") === "S256" && !!location.searchParams.get("state"), `${start.status} ${location.href.slice(0, 200)}`);
    const pending = start.headers.get("set-cookie") ?? "";
    results.check("…remembering its state in an httpOnly cookie", /HttpOnly/i.test(pending) && /SameSite=Lax/i.test(pending), pending.replace(/=[^;]+/, "=…").slice(0, 160));

    // Its pages may show this stack's mock Iris photos and call the account site (the Embed tab's live SDK).
    const page = await fetch(`${env.developer}/sign-in`);
    const csp = page.headers.get("content-security-policy") ?? "";
    results.check("its CSP allows this stack's mock Iris and account site", csp.includes(new URL(env.iris).origin) && csp.includes(new URL(env.site).origin), csp.match(/img-src[^;]*/)?.[0] ?? csp.slice(0, 200));
  },
};
