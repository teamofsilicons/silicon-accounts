/**
 * A signed-in Carbon reaches the apps workspace (/apps) and stays there, whatever Silicon Apps answers.
 *
 * The workspace reads the Carbon's apps from Silicon Accounts and their publishing state from Silicon Apps, both through
 * the developer site's BFF with the same `aud=developer` token. Silicon Apps can refuse that token while Silicon
 * Accounts accepts it (an Apps API that trusts another Accounts service, as a local stack's could). That 401 used to
 * read as "signed out": the shell sent the Carbon to /sign-in, the sign-in page found the session fine and sent them
 * back, and the two pages looped. Now the BFF asks Silicon Accounts (GET /v1/session) before it says signed out
 * (developer/lib/server/apps-refusal.ts), a refusal by Apps alone is 502 `apps_rejected_sign_in` shown in words on the
 * page, and the browser asks /auth/session and /v1/me again before it leaves (developer/lib/query/session.ts).
 *
 * The stack's developer site publishes through the testkit's stand-in Silicon Apps API (scripts/dev.sh --apps=stand-in,
 * the default: testkit/src/mock-silicon-apps.ts, on base + 6), which this journey tells to refuse every token and to
 * answer again (E2E_SILICON_APPS overrides where it is). A stack started with `--apps=on` runs the real Apps API there
 * instead: walk this journey on another stack.
 */
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, api, fakeApp, newContext, shot, signInOnDeveloper, sleep, type Env } from "../../lib";
import { freshCodeWindow, readDevSession } from "./_helpers";

/** What the stand-in Silicon Apps API saw (GET /_requests). */
interface AppsCall {
  method: string;
  path: string;
  aud: unknown;
}

/** The stand-in Silicon Apps API of the stack (scripts/dev.sh: base + 6). */
function siliconAppsOf(env: Env): string {
  return (process.env.E2E_SILICON_APPS ?? `http://127.0.0.1:${env.base + 6}`).replace(/\/+$/, "");
}

/** Steers the stand-in: refuse every token (as an Apps API that trusts another Silicon Accounts) or answer again. */
async function standIn(url: string) {
  const health = await fetch(`${url}/_health`).then(response => response.json() as Promise<{ service?: string }>, () => null);
  if (health?.service !== "mock-silicon-apps") return null;
  await fetch(`${url}/_requests`, { method: "DELETE" });
  return {
    refuse: async (on: boolean) => {
      await fetch(`${url}/_refuse`, { method: on ? "PUT" : "DELETE" });
    },
    calls: async () => ((await (await fetch(`${url}/_requests`)).json()) as { items: AppsCall[] }).items,
  };
}

export const journey: Journey = {
  name: "developer-site-apps-workspace",
  title: "a signed-in Carbon reaches the apps workspace at /apps and stays there: Silicon Apps refusing the developer token (401) shows in words and never sends the Carbon to /sign-in and back; the sign-in page sends a signed-in Carbon on to /apps once; a sign-in that really ended at Silicon Accounts lands on the sign-in card and stays",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const appsUrl = siliconAppsOf(env);
    const apps = await standIn(appsUrl);
    if (!apps) {
      results.check(`the stack's developer site publishes through the testkit's stand-in Silicon Apps API at ${appsUrl}`, false, "no stand-in answers there (a stack started with --apps=on or --apps=off): walk this journey on a stack with the default --apps=stand-in, or set E2E_SILICON_APPS");
      return;
    }
    const appId = "commit";
    const ownerEmail = fakeApp(appId).owner_email;
    const context = await newContext(browser);
    try {
      await freshCodeWindow(env, ownerEmail);
      const page = await context.newPage();
      // Expected while Apps refuses (502 from the BFF) and after the sign-in ends (401 from both proxies).
      results.watch(page, "apps-workspace", [
        DEVELOPER_SIGNED_OUT,
        /status of 502 \(Bad Gateway\) @ https?:\/\/[^ ]+\/api\/apps\/apps\?mine=true/,
        /status of 401 \(Unauthorized\) @ https?:\/\/[^ ]+\/api\/apps\/apps\?mine=true/,
      ]);
      // The main frame's paths, one entry per page (the client router reports one move more than once).
      const visits: string[] = [];
      page.on("framenavigated", frame => {
        if (frame !== page.mainFrame()) return;
        const path = new URL(frame.url()).pathname;
        if (visits.at(-1) !== path) visits.push(path);
      });
      const appsAnswers: Array<{ status: number; body: { error?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> } } }> = [];
      page.on("response", response => {
        if (!response.url().startsWith(`${env.developer}/api/apps/`)) return;
        void response.json().then(body => appsAnswers.push({ status: response.status(), body }), () => appsAnswers.push({ status: response.status(), body: {} }));
      });
      const heading = page.getByRole("heading", { level: 1, name: "Your apps" });
      const tile = page.getByRole("link", { name: new RegExp(`\\b${appId}\\b`) }).first();
      // Arc's Alert: a warning is a status (a danger one would be an alert).
      const notice = page.getByRole("status").filter({ hasText: "Publishing details could not be loaded" });

      // 1. Signed in, the workspace shows the Carbon's apps; the publishing call reached Silicon Apps with the developer token.
      await signInOnDeveloper(env, page, ownerEmail, { returnTo: "/apps" });
      await heading.waitFor({ timeout: 30_000 });
      await tile.waitFor({ timeout: 30_000 });
      await sleep(1_500);
      const seen = await apps.calls();
      const mine = seen.find(call => call.method === "GET" && call.path.startsWith("/v1/apps?mine=true"));
      results.check(`signed in, the Carbon is on /apps with "Your apps" and the ${appId} tile`, new URL(page.url()).pathname === "/apps" && (await tile.isVisible()), page.url());
      results.check("…and its publishing state came from Silicon Apps (GET /v1/apps?mine=true with a bearer token whose aud is developer)", !!mine && mine.aud === "developer", JSON.stringify(seen.slice(0, 4)));
      results.check("…with nothing to warn about", (await notice.count()) === 0);
      const before = (await readDevSession(context, env)).session;

      // 2. Silicon Apps refuses the token while Silicon Accounts accepts it: the page says so and stays.
      await apps.refuse(true);
      const reloadedAt = visits.length;
      visits.push("(reload)");
      await page.reload();
      const shown = await notice.waitFor({ timeout: 20_000 }).then(() => true, () => false);
      await sleep(6_000);
      const after = visits.slice(reloadedAt + 1);
      const refused = appsAnswers.at(-1);
      const noticeText = shown ? (await notice.innerText({ timeout: 3_000 }).catch(() => "(gone from the page)")).replace(/\s+/g, " ") : "";
      await shot(env, page, "ds-r-01-apps-refused");
      results.check("Apps refusing the developer token (401 invalid_token): the page stays on /apps, never visiting /sign-in", after.length === 1 && after[0] === "/apps", after.join(" > "));
      results.check("…and says why in words: \"Publishing details could not be loaded\", Silicon Apps did not accept the sign-in, you are still signed in", shown && /Silicon Apps did not accept your developer site sign-in/.test(noticeText) && /still signed in/.test(noticeText), noticeText.slice(0, 400));
      results.check("…the BFF answered 502 apps_rejected_sign_in naming Apps' own code, not a signed-out 401", refused?.status === 502 && refused.body.error?.code === "apps_rejected_sign_in" && refused.body.error.details?.upstream_code === "invalid_token", JSON.stringify(refused).slice(0, 400));
      results.check("…the Carbon's apps from Silicon Accounts still show", await tile.isVisible());
      const kept = (await readDevSession(context, env)).session;
      results.check("…the session cookie is kept, and the refusal spent no refresh token", !!kept && !!before && kept.rt === before.rt, `${before?.rt.slice(0, 10)}… → ${kept?.rt.slice(0, 10) ?? "gone"}…`);
      const probe = await page.request.get(`${env.developer}/auth/session`);
      results.check("…and /auth/session still says signed in", probe.status() === 200 && (await probe.json()).signed_in === true, String(probe.status()));

      // 3. The sign-in page sends a signed-in Carbon on to where they were going, once, while Apps still refuses.
      const bounceAt = visits.length;
      await page.goto(`${env.developer}/sign-in?return_to=${encodeURIComponent("/apps")}`);
      await page.waitForURL(url => url.pathname === "/apps", { timeout: 20_000 });
      await sleep(5_000);
      const bounced = visits.slice(bounceAt);
      results.check("/sign-in while signed in sends the Carbon on to /apps once, and nothing sends them back", new URL(page.url()).pathname === "/apps" && bounced.join(" > ") === "/sign-in > /apps", bounced.join(" > "));

      // 4. A sign-in that ended at Silicon Accounts: the Carbon lands on the sign-in card and stays there.
      const ended = (await readDevSession(context, env)).session;
      const revoked = await api(ctx, "/v1/oauth/revoke", { method: "POST", direct: true, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: ended?.rt ?? "", client_id: "developer" }).toString() });
      const endedAt = visits.length;
      visits.push("(reload)");
      const answersAt = appsAnswers.length;
      await page.reload().catch(() => undefined);
      await page.waitForURL(url => url.pathname === "/sign-in", { timeout: 30_000 });
      await sleep(5_000);
      const out = visits.slice(endedAt + 1);
      await shot(env, page, "ds-r-02-signed-out");
      results.check("the sign-in revoked at Silicon Accounts: the page goes to the sign-in card (return_to=/apps) and stays there", revoked.status === 200 && new URL(page.url()).pathname === "/sign-in" && new URL(page.url()).searchParams.get("return_to") === "/apps" && out.at(-1) === "/sign-in" && out.filter(path => path === "/sign-in").length === 1, `revoke ${revoked.status}; ${out.join(" > ")}`);
      results.check("…showing \"Continue with Silicon Accounts\"", await page.getByRole("link", { name: /Continue with Silicon Accounts/ }).isVisible());
      const cleared = await readDevSession(context, env);
      results.check("…and its session cookie is cleared", !cleared.cookie?.value, cleared.cookie?.value ? "still set" : "cleared");
      const lastApps = appsAnswers.slice(answersAt);
      results.check("…where Apps' refusal now reads as signed out (Silicon Accounts says the sign-in ended): 401 signed_out", lastApps.every(answer => answer.status === 401 && answer.body.error?.code === "signed_out"), lastApps.length ? JSON.stringify(lastApps).slice(0, 300) : "the page left before asking Silicon Apps");
    } finally {
      await apps.refuse(false);
      await context.close();
    }
  },
};
