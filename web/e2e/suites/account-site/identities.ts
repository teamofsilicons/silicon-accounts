/**
 * Connected identities on Sign-in methods: Google and Apple accounts linked to a Carbon (their verified emails added
 * without a code), refused when they belong to someone else, signing in with them, and unlinking them (the email
 * stays, so a later Google sign-in with it is still this account's).
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { newContext, shot, sleep, tag, type Env } from "../../lib";
import { call, codeOf, confirmMorph, getMe, newCarbon, probePage, until } from "./_helpers";

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\:/]/g, "\\$&");

/** On the mock provider's chooser: "Use another account" with this email (the mock finds or makes that identity). */
async function choose(env: Env, page: Page, email: string, name: string): Promise<void> {
  await page.waitForURL(new RegExp(escapeRe(env.oidc)), { timeout: 30_000 });
  await page.locator('#new-identity input[name="_auto"]').fill(email);
  await page.locator('#new-identity input[name="_name"]').fill(name);
  await page.locator('#new-identity button[data-action="use-another"]').click();
}

/** "Connect Google/Apple" on /sign-in-methods through the mock provider, back on the page with its outcome alert. */
async function connect(env: Env, page: Page, provider: "Google" | "Apple", email: string, name: string): Promise<string> {
  await page.goto(`${env.site}/sign-in-methods`);
  await page.getByRole("button", { name: `Connect ${provider}` }).click({ timeout: 30_000 });
  await choose(env, page, email, name);
  await page.waitForURL(url => url.pathname === "/sign-in-methods", { timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // A success is a status (role=status), a refusal an alert (role=alert).
  return until(async () => (await page.locator('[role="alert"], [role="status"]').allInnerTexts()).join(" | ").replace(/\s+/g, " "), text => text.includes(`${provider} is connected`) || text.includes(`${provider} was not connected`), 10_000);
}

const identities: Journey = {
  name: "account-site-identities",
  title: "connected identities: Google and Apple linked on Sign-in methods (their emails added without a code), refused when the identity or its email belongs to another Carbon, signing in with Google, unlinking (the email stays; Google signs in to the same account again)",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const ada = await newCarbon(ctx, "acct-links");
    const ben = await newCarbon(ctx, "acct-links-other");
    const gmail = `acct.links.${t}@gmail.test`;
    const icloud = `acct.links.${t}@icloud.test`;

    // 1. Google: connected, its email added without a code (verified by Google), not primary.
    const said = await connect(env, ada.page, "Google", gmail, `Ada Google ${t}`);
    results.check("Google: the page says it is connected and that its email was added", said.includes("Google is connected") && said.includes("its verified email was added to your emails"), said.slice(0, 200));
    results.check("…and cleans the address", !ada.page.url().includes("linked="), ada.page.url());
    let me = await getMe(ada.probe);
    const google = me.identities.find(item => item.provider === "google");
    const gEmail = me.emails.find(item => item.email === gmail);
    results.check("Google is linked with its email", google?.email === gmail, JSON.stringify(me.identities));
    results.check("its email is on the account, verified by Google, not primary", !!gEmail && gEmail.verified_via === "google" && !!gEmail.verified_at && !gEmail.is_primary, JSON.stringify(gEmail ?? null));
    const linkedList = ada.page.getByRole("list", { name: "Linked Google and Apple accounts" });
    const googleRow = linkedList.getByRole("listitem").filter({ hasText: gmail });
    const googleText = (await googleRow.innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("the Google row shows the account and when it was linked", /Google/.test(googleText) && googleText.includes(gmail) && /Linked /.test(googleText), googleText);
    const emailRow = (await ada.page.getByRole("list", { name: "Your emails" }).locator(`[data-key="${gmail}"]`).innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("the email row says it was verified by Google", /Verified by Google on/.test(emailRow), emailRow);

    // 2. Apple too (form_post back through the site).
    const saidApple = await connect(env, ada.page, "Apple", icloud, `Ada Apple ${t}`);
    me = await getMe(ada.probe);
    results.check("Apple: connected, its email added", saidApple.includes("Apple is connected") && me.identities.some(item => item.provider === "apple" && item.email === icloud) && me.emails.some(item => item.email === icloud && item.verified_via === "apple"), `${saidApple.slice(0, 160)} / ${JSON.stringify(me.emails.find(item => item.email === icloud) ?? null)}`);
    await sleep(600);
    await shot(env, ada.page, "acct-links-01-linked", true);
    results.check("Connect buttons are gone once both are linked", (await ada.page.getByRole("button", { name: /^Connect (Google|Apple)$/ }).count()) === 0);

    // 3. Another Carbon can't take them: the same Google account, or a Google account with Ada's email.
    const refusedSame = await connect(env, ben.page, "Google", gmail, `Ben ${t}`);
    results.check("another Carbon connecting Ada's Google account is refused, with the reason", /Google was not connected/.test(refusedSame) && /another|already/i.test(refusedSame), refusedSame.slice(0, 240));
    const refusedEmail = await connect(env, ben.page, "Google", ada.email, `Ben Again ${t}`);
    results.check("another Carbon connecting a Google account whose email is Ada's is refused, with the reason", /Google was not connected/.test(refusedEmail) && /belongs to another account|another account/i.test(refusedEmail), refusedEmail.slice(0, 240));
    results.check("the email refusal reads correctly (\"An email can only belong to one account\", not \"A email…\")", !/\bA email\b/.test(refusedEmail) && /An email can only belong to one account/.test(refusedEmail), refusedEmail.match(/An? email can only[^.]*\./)?.[0] ?? refusedEmail.slice(0, 200));
    await shot(env, ben.page, "acct-links-02-refused");
    const benMe = await getMe(ben.probe);
    results.check("…and nothing was linked or added to the other Carbon", benMe.identities.length === 0 && benMe.emails.length === 1, JSON.stringify({ identities: benMe.identities.length, emails: benMe.emails.map(item => item.email) }));

    // 4. Signing in with Google on the site lands in Ada's account.
    const signIn = async (label: string) => {
      const context = await newContext(ctx.browser);
      const page = await context.newPage();
      results.watch(page, label);
      await page.goto(`${env.site}/sign-in`);
      await page.getByRole("button", { name: "Continue with Google" }).click({ timeout: 30_000 });
      await choose(env, page, gmail, `Ada Google ${t}`);
      await page.waitForURL(`${env.site}/`, { timeout: 30_000 });
      const probe = await probePage(env, context);
      const signedIn = await getMe(probe);
      await context.close();
      return signedIn;
    };
    const viaGoogle = await signIn("google-sign-in");
    results.check("signing in on the site with the linked Google account reaches Ada's account", viaGoogle.uuid === ada.uuid, `${viaGoogle.uuid} vs ${ada.uuid}`);
    me = await getMe(ada.probe);
    results.check("…and the identity's last use is recorded", !!me.identities.find(item => item.provider === "google")?.last_used_at);

    // 5. Unlinking Google: the row goes, the email stays.
    await ada.page.goto(`${env.site}/sign-in-methods`);
    await googleRow.waitFor({ timeout: 30_000 });
    await confirmMorph(googleRow, "Unlink", "Unlink");
    me = await until(() => getMe(ada.probe), value => !value.identities.some(item => item.provider === "google"), 10_000);
    results.check("Google is unlinked", !me.identities.some(item => item.provider === "google"), JSON.stringify(me.identities.map(item => item.provider)));
    results.check("…its email stays on the account", me.emails.some(item => item.email === gmail));
    const offer = await until(async () => ({ buttons: await ada.page.getByRole("button", { name: "Connect Google" }).count(), rows: (await linkedList.getByRole("listitem").allInnerTexts()).map(text => text.replace(/\s+/g, " ")) }), state => state.buttons === 1 && !state.rows.some(row => row.includes(gmail)), 8_000);
    await shot(env, ada.page, "acct-links-03-unlinked");
    results.check("…and the page drops its row and offers to connect Google again", offer.buttons === 1 && !offer.rows.some(row => row.includes(gmail)), JSON.stringify(offer));
    // The email is still Ada's, so a Google sign-in with it is Ada signing in (and links Google again).
    const again = await signIn("google-sign-in-again");
    me = await getMe(ada.probe);
    results.check("a Google sign-in with that email afterwards is still Ada's account, and Google is linked again", again.uuid === ada.uuid && me.identities.some(item => item.provider === "google"), `${again.uuid}, ${me.identities.map(item => item.provider).join(",")}`);

    // 6. The API: unlinking Apple by provider and subject; an unknown provider is refused.
    const apple = me.identities.find(item => item.provider === "apple");
    const unlinked = await call(ada.probe, `/v1/me/identities/apple/${encodeURIComponent(apple?.subject ?? "")}`, { method: "DELETE" });
    results.check("DELETE /v1/me/identities/apple/{subject} unlinks Apple (204)", unlinked.status === 204 && !(await getMe(ada.probe)).identities.some(item => item.provider === "apple"), String(unlinked.status));
    const unknown = await call(ada.probe, "/v1/me/identities/facebook/123", { method: "DELETE" });
    results.check("an unknown provider is refused (400 invalid_provider)", unknown.status === 400 && codeOf(unknown.body) === "invalid_provider", `${unknown.status} ${codeOf(unknown.body)}`);

    const titles = (await call<{ items: Array<{ title: string }> }>(ada.probe, "/v1/me/history?kind=security&limit=50")).body.items.map(item => item.title);
    results.check("history: the disconnections", titles.includes("Google account disconnected") && titles.includes("Apple account disconnected"), titles.slice(0, 6).join(" | "));
    await ada.context.close();
    await ben.context.close();
  },
};

export const journey = identities;
