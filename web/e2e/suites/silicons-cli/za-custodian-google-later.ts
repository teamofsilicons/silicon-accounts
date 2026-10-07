import type { Journey } from "../../context";
import { appAccount, chooseMockIdentity, finishSignup, newContext, shot, signInOnSite, sleep, startAtApp, tag, waitForOpening } from "../../lib";
import { accounts, answerOnSite, dataOf, freshDir, loginSilicon, obj, requestCard, requestStatus, said, selfCreate, setSinkSecret, short, sinkUrl, str, waitSink, type Json } from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-custodian-google-later",
  title: "a Silicon names its custodian by an address nobody has; that Carbon signs up later through an app with the app's own \"Continue with Google\" button (the Opening page, Google, the sign-up, the app's details page) and finds the request on the account site's Silicons page, accepts it, and the Silicon signs in with it as custodian",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const email = `scli.google.${t}@example.test`;
    const sid = `si:google-${t}`;
    const key = `scli-google-${t}`;

    // 1. The Silicon creates its account naming an address with no account yet.
    const created = await selfCreate(ctx, { id: sid, display_name: `Google later ${t}`, custodian: email, webhook_url: sinkUrl(env, key) });
    await setSinkSecret(env, key, created.webhookSecret);
    results.check("the Silicon names an address nobody has signed up with: created, pending", created.status === 201 && obj(created.body.silicon).status === "pending_custodian", `${created.status} ${short(created.body.error ?? created.body.request)}`);

    // 2. The Carbon signs up later through briefcase's own "Continue with Google" button, with that address at Google.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "scli-google-later");
    const href = await startAtApp(env, page, "briefcase", { method: "google" });
    const opening = await waitForOpening(env, page, "google", { shotName: "scli-google-later-01-opening" });
    results.check("briefcase's own \"Continue with Google\": the Opening page names briefcase, then moves on to Google", href.searchParams.get("method") === "google" && /Opening Google to sign you in to Briefcase/.test(opening.title) && opening.movedAfterMs !== null, `${opening.title}; moved after ${opening.movedAfterMs} ms`);
    await chooseMockIdentity(env, page, email, `Google Later ${t}`);
    const signup = await finishSignup(env, page, "briefcase", "scli-google-later-02");
    const account = await appAccount(page);
    results.check("…the sign-up (prefilled from Google) and briefcase's details page lead back to briefcase, signed in with that address", signup.includes(email) && account?.email === email, `${short(account, 200)}`);
    const uuid = str(account?.uuid);

    // 3. The request is waiting on the account site's Silicons page (the same browser is signed in there).
    await page.goto(`${env.site}/silicons`);
    if (new URL(page.url()).pathname.startsWith("/sign-in")) await signInOnSite(env, page, email).then(() => page.goto(`${env.site}/silicons`));
    const card = requestCard(page, sid, "initial");
    await card.waitFor({ timeout: 30_000 }).catch(() => undefined);
    await sleep(600);
    await shot(env, page, "scli-google-later-03-request");
    results.check("the account site's Silicons page shows the request from the Silicon", await card.isVisible(), page.url());
    const status = await answerOnSite(env, page, sid, "initial", "accept");
    results.check("accepting it on the site: 204", status === 204, String(status));

    // 4. The Silicon is active with the new Carbon as its custodian.
    const read = await requestStatus(ctx, created.requestId, created.requestToken);
    results.check("the request reads accepted", read.body.status === "accepted" && obj(read.body.silicon).status === "active", short(read.body, 300));
    const home = freshDir();
    const login = await loginSilicon(env, home, sid, created.stk);
    const whoami = await accounts(env, ["whoami", "--json"], { home });
    const me = (await (await page.request.get(`${env.site}/v1/me`)).json()) as Json;
    results.check(
      "the Silicon's STK signs it in; its custodian is the Carbon who signed up with Google (the account briefcase got)",
      login.code === 0 && !!uuid && obj(whoami.json?.custodian).uuid === uuid && obj(whoami.json?.custodian).id === me.id && me.uuid === uuid,
      `${said(login)} | custodian ${short(whoami.json?.custodian)} | carbon ${short({ id: me.id, uuid: me.uuid })}`,
    );
    const hook = await waitSink(env, key, "silicon.custodian.accepted", candidate => dataOf(candidate).request_id === created.requestId);
    results.check("its webhook got silicon.custodian.accepted naming that Carbon", obj(dataOf(hook).custodian).id === me.id, short(hook?.payload, 200));
    await context.close();
  },
};
