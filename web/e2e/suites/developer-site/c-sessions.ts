/**
 * A sign-in to the developer site is a session of Silicon Accounts itself: the account site lists it under "Where you
 * are signed in" as Silicon Developer, and signing it out there signs the developer site out at once (its next request
 * answers 401 and the page goes back to its sign-in card), while the account site's own sign-in stays. Signing out on
 * the developer site takes the session off the list too.
 */
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, developerApi, newContext, shot, signInOnDeveloper, signInOnSite, sleep } from "../../lib";
import { errorCode, freshEmail, jwtClaims, readDevSession, signOutOfDeveloper, tokenCall, type DevSession } from "./_helpers";

interface SessionInfo {
  id: string;
  kind: string;
  label: string | null;
  origin: string | null;
  user_agent: string | null;
  current: boolean;
  created_at: string;
}

export const journey: Journey = {
  name: "developer-site-sessions",
  title: "a Carbon signed in on the account site continues as themselves on the developer site; the account site lists that sign-in as Silicon Developer, and signing it out there signs the developer site out at once; signing out on the developer site takes it off the list",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const email = freshEmail("sessions");
    const context = await newContext(browser);
    const account = await context.newPage();
    results.watch(account, "sessions-account");
    await signInOnSite(env, account, email);
    const developer = await context.newPage();
    results.watch(developer, "sessions-developer", [DEVELOPER_SIGNED_OUT]);
    const started = Date.now();
    await signInOnDeveloper(env, developer, null);
    results.metric("signing in to the developer site with \"Continue as\"", Date.now() - started);
    results.check("a browser signed in on the account site continues as that Carbon on the developer site (no code)", developer.url() === `${env.developer}/`, developer.url());
    await developer.getByRole("heading", { name: "No apps yet" }).waitFor({ timeout: 30_000 });
    await shot(env, developer, "ds-c-01-no-apps");
    const sealed = (await readDevSession(context, env)).session as DevSession;
    const family = jwtClaims(sealed.at).fid;

    // The account site lists it.
    const list = async () => {
      const answer = await account.request.get(`${env.site}/v1/me/sessions`);
      return ((await answer.json()) as { items?: SessionInfo[] }).items ?? [];
    };
    const listed = (await list()).filter(item => item.kind === "developer");
    results.check("GET /v1/me/sessions lists one developer sign-in, named Silicon Developer (developer.teamofsilicons.com)", listed.length === 1 && listed[0]?.label === "Silicon Developer (developer.teamofsilicons.com)" && listed[0].current === false, JSON.stringify(listed.map(item => ({ kind: item.kind, label: item.label, origin: item.origin }))));
    results.check("…and it is the very sign-in behind the developer site's cookie (the token's family)", typeof family === "string" && listed[0]?.id === family, `${listed[0]?.id} vs fid ${String(family)}`);
    await account.goto(`${env.site}/settings`);
    const rows = account.getByRole("list", { name: "Signed-in sessions" });
    await rows.waitFor({ timeout: 30_000 });
    const row = rows.getByRole("listitem").filter({ hasText: "Silicon Developer" });
    await row.first().waitFor({ timeout: 15_000 });
    await sleep(500);
    await shot(env, account, "ds-c-02-settings-sessions");
    const rowText = (await row.first().innerText()).replace(/\s+/g, " ");
    results.check("Settings shows it under \"Where you are signed in\": Silicon Developer, developer.teamofsilicons.com", (await row.count()) === 1 && /developer\.teamofsilicons\.com/.test(rowText) && !/This browser/.test(rowText), rowText);
    const thisBrowser = rows.getByRole("listitem").filter({ hasText: "This browser" });
    results.check("…next to this browser's own session", (await thisBrowser.count()) === 1, await thisBrowser.first().innerText().catch(() => ""));

    // Signing it out on the account site signs the developer site out.
    // A confirm in place: the row's Sign out turns into "Sign it out?" with Cancel and Sign out.
    await row.getByRole("button", { name: "Sign out", exact: true }).first().click();
    await row.getByRole("group", { name: "Sign it out?" }).getByRole("button", { name: "Sign out", exact: true }).click();
    // "Signed out" shows in place, then the row folds away (a leaving row keeps rendering, inert, while it does).
    const folded = await account.waitForFunction(() => ![...document.querySelectorAll('[aria-label="Signed-in sessions"] [role="listitem"]:not([data-leaving])')].some(item => /Silicon Developer/.test(item.textContent ?? "")), undefined, { timeout: 20_000 }).then(() => true, () => false);
    const gone = (await list()).filter(item => item.kind === "developer");
    results.check("Sign out on that row takes it off the list (and the API's)", gone.length === 0 && folded, `${gone.length} left in the API; row folded away: ${folded}`);
    const call = await developerApi(env, developer, "/me");
    results.check("…the developer site's next call answers 401 (the sign-in behind its cookie is revoked) and clears the cookie", call.status === 401 && ["token_revoked", "signed_out"].includes(errorCode(call.body) ?? "") && !(await readDevSession(context, env)).cookie?.value, `${call.status} ${errorCode(call.body)}`);
    const refresh = await tokenCall<{ error?: string; error_description?: string }>(ctx, { grant_type: "refresh_token", refresh_token: sealed.rt, client_id: "developer" });
    results.check("…its refresh token is refused, naming the revoked session", refresh.status === 400 && refresh.body.error === "invalid_grant" && /revoked/.test(refresh.body.error_description ?? ""), refresh.body.error_description?.slice(0, 200) ?? "");
    await developer.goto(`${env.developer}/`).catch(() => undefined);
    await developer.waitForURL(url => url.pathname === "/sign-in", { timeout: 30_000 });
    await shot(env, developer, "ds-c-03-developer-signed-out");
    results.check("…and the open developer site goes back to its sign-in card", developer.url().startsWith(`${env.developer}/sign-in`), developer.url());
    const own = await account.request.get(`${env.site}/v1/session`);
    results.check("the account site's own sign-in stays (GET /v1/session 200, \"This browser\" still listed)", own.status() === 200 && (await list()).some(item => item.current), String(own.status()));

    // Signing in again, then out on the developer site: the session leaves the list as well.
    await signInOnDeveloper(env, developer, null);
    const again = (await list()).filter(item => item.kind === "developer");
    results.check("signing in again lists a new developer sign-in", again.length === 1 && again[0]?.id !== listed[0]?.id, again.map(item => item.id).join(", "));
    await signOutOfDeveloper(env, developer);
    const afterOut = (await list()).filter(item => item.kind === "developer");
    results.check("…and Sign out on the developer site takes it off the account site's list", afterOut.length === 0, `${afterOut.length} left`);
    await context.close();
  },
};
