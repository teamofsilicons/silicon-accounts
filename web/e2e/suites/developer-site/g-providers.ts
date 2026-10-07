/**
 * Google and Apple on the Sign-in tab (UNDERSTANDING "Google and Apple"): one click (Silicon Accounts' own clients) or
 * bring your own. The owner of pixel-studio registers their own Google OAuth client and Apple Services ID at the mock
 * providers (as they would at Google and Apple), pastes them in, and the secrets are written only: the API, the BFF,
 * the page and the version history only ever say that one is stored. Real sign-ins then show which client signed the
 * Carbon in: the managed one before, the app's own after (Google's consent page names the app; Apple's client secret is
 * a JWT signed with the app's own key). Replacing the Google secret with a wrong one breaks the sign-in at Google's
 * token step, which shows the stored secret really changed. The app's setup is put back afterwards.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { REPO_ROOT, appAccount, chooseMockIdentity, developerApi, finishSignup, json, newContext, postJson, shot, sleep, startAtApp, tag, waitForOpening } from "../../lib";
import { appDetail, ownerSignIn, restoreConfig, saveChanges } from "./_helpers";

const APP = "pixel-studio";

interface OidcLog {
  endpoint: string;
  client_id: string | null;
  status: number;
  outcome: string;
  error: string | null;
  client_secret_jwt: { kid: string | null; iss: string | null; sub: string | null } | null;
}

/** The mock provider's log of calls by a client, newest first. */
async function oidcLog(ctx: Ctx, provider: "google" | "apple", clientId: string): Promise<OidcLog[]> {
  return (await json<{ items?: OidcLog[] }>(`${ctx.env.oidc}/_requests?provider=${provider}&client_id=${encodeURIComponent(clientId)}`)).body.items ?? [];
}

/** A Carbon signs in to pixel-studio with Google or Apple from its own "Continue with …" button (the Opening page first). */
async function providerSignIn(ctx: Ctx, provider: "google" | "apple", label: string): Promise<{ page: Page; providerText: string; account: Record<string, unknown> | null; close: () => Promise<void> }> {
  const context = await newContext(ctx.browser);
  const page = await context.newPage();
  ctx.results.watch(page, label, [/status of 4\d\d .* @ .*\/v1\/flows\//, /status of 502/]);
  await startAtApp(ctx.env, page, APP, { method: provider });
  await waitForOpening(ctx.env, page, provider);
  await page.waitForURL(url => url.href.startsWith(ctx.env.oidc), { timeout: 30_000 });
  const providerText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  await chooseMockIdentity(ctx.env, page, `ds-${provider}-${tag()}@example.test`, `Pixel ${provider === "google" ? "Googler" : "Appler"}`);
  await page.waitForURL(url => url.href.startsWith(ctx.env.site) || url.href.startsWith(ctx.env.apps), { timeout: 30_000 });
  const create = page.getByRole("button", { name: /^(Create account|Finish setup)$/ });
  const alert = page.locator("[data-error-code]").first();
  const next = await Promise.race([create.waitFor({ timeout: 30_000 }).then(() => "signup" as const), alert.waitFor({ timeout: 30_000 }).then(() => "error" as const)]).catch(() => "neither" as const);
  let account: Record<string, unknown> | null = null;
  if (next === "signup") {
    await finishSignup(ctx.env, page, APP);
    account = await appAccount(page);
  }
  return { page, providerText, account, close: () => context.close() };
}

export const journey: Journey = {
  name: "developer-site-providers",
  title: "Google and Apple, one click or bring your own: pixel-studio's owner pastes their own Google client and Apple Services ID and key; the secrets are write-only (API, BFF, page, history); sign-ins switch from the managed clients to the app's own (Google's consent names the app, Apple's client secret is signed with the app's key); a replaced secret is really replaced",
  timeoutMs: 12 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const before = (await appDetail(ctx, APP)).signin_config;
    const managed = (JSON.parse(readFileSync(join(REPO_ROOT, "testkit/dev-credentials.json"), "utf8")) as { managed: { google: { client_id: string }; apple: { services_id: string } } }).managed;

    // The app's own clients, created at the (mock) providers the way a developer creates them at Google and Apple.
    const googleId = `ds${randomBytes(5).toString("hex")}-pixel.apps.googleusercontent.com`;
    const googleSecret = `GOCSPX-${randomBytes(12).toString("base64url")}`;
    const servicesId = `test.pixel-${tag()}.signin`;
    const teamId = randomBytes(5).toString("hex").toUpperCase();
    const keyId = randomBytes(5).toString("hex").toUpperCase();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const applePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const registered = await postJson(`${env.oidc}/_clients`, [
      { provider: "google", client_id: googleId, client_secret: googleSecret, display_name: "Pixel Studio", label: "byo:pixel-studio (developer-site)" },
      { provider: "apple", client_id: servicesId, team_id: teamId, key_id: keyId, private_key_pem: applePem, display_name: "Pixel Studio", label: "byo:pixel-studio (developer-site)" },
    ]);
    results.check("the app's own Google client and Apple Services ID exist at the (mock) providers", registered.status === 201, String(registered.status));

    const { context, page } = await ownerSignIn(ctx, APP, { label: "providers", returnTo: `/apps/${APP}/sign-in` });
    try {
      const panel = page.getByRole("tabpanel", { name: "Sign-in" });
      const google = panel.getByRole("region", { name: "Google" });
      const apple = panel.getByRole("region", { name: "Apple" });
      await google.waitFor({ timeout: 30_000 });
      const googleOneClick = google.getByRole("radio", { name: "One click" });
      results.check("one click is chosen for both, and this deployment has the managed clients (\"Ready here\")", (await googleOneClick.getAttribute("aria-checked")) === "true" && /Ready here/.test(await googleOneClick.innerText()) && (await apple.getByRole("radio", { name: "One click" }).getAttribute("aria-checked")) === "true", await googleOneClick.innerText());
      const googleRow = panel.getByRole("listitem").filter({ has: page.getByRole("switch", { name: "Google", exact: true }) });
      results.check("…and the Google row says it runs on Silicon Accounts' Google setup", /One click, with Silicon Accounts' Google setup/.test(await googleRow.innerText()), await googleRow.innerText());

      // A sign-in with the managed client, to compare with later.
      const viaManaged = await providerSignIn(ctx, "google", "providers-managed");
      const managedToken = (await oidcLog(ctx, "google", managed.google.client_id)).find(entry => entry.endpoint === "token");
      results.check("a Google sign-in now goes through Silicon Accounts' own Google client (its consent page shows Silicon Accounts)", !!viaManaged.account && managedToken?.status === 200 && /Silicon Accounts/.test(viaManaged.providerText), `${managedToken?.client_id} ${managedToken?.status}; account ${String(viaManaged.account?.uuid)}`);
      await viaManaged.close();

      // Bring your own Google: the exact callback to paste, the ID and the secret.
      await google.getByRole("radio", { name: "Bring your own" }).click();
      const callback = (await google.locator('code[aria-label^="Authorized redirect URI: "]').innerText().catch(() => "")).trim();
      results.check("Bring your own shows the exact authorized redirect URI to paste into Google", callback === `${env.site}/v1/oauth/callback/google`, callback);
      const empty = await saveChanges(page);
      results.check("saving without the client ID and secret is stopped in place, naming both", !empty.saved && /client ID/i.test(empty.text) && /client secret/i.test(empty.text), empty.text.slice(0, 300));
      await google.getByRole("textbox", { name: "Client ID" }).fill(googleId);
      await google.getByLabel("Client secret").fill(googleSecret);
      const savedGoogle = await saveChanges(page);
      const viaApp = await appDetail(ctx, APP);
      const viaBff = await developerApi<{ signin_config?: { google?: Record<string, unknown> } }>(env, page, `/apps/${APP}`);
      const history = await developerApi(env, page, `/apps/${APP}/signin-config/history?limit=50`);
      const everywhere = [JSON.stringify(viaApp), JSON.stringify(viaBff.body), JSON.stringify(history.body), await page.content()];
      results.check("saved: mode byo with the client ID, and the secret only as client_secret_set", savedGoogle.saved && viaApp.signin_config.google.mode === "byo" && viaApp.signin_config.google.client_id === googleId && viaApp.signin_config.google.client_secret_set === true && viaBff.body.signin_config?.google?.client_secret_set === true, `${savedGoogle.text}; ${JSON.stringify(viaApp.signin_config.google)}`);
      results.check("…the secret itself is in none of: the API's answer, the BFF's, the version history, the page", everywhere.every(text => !text.includes(googleSecret)), everywhere.map(text => text.length).join(", "));
      const storedState = (await google.innerText()).replace(/\s+/g, " ");
      results.check("…the field now says \"A client secret is stored\", with Replace and Remove, and no secret input", /A client secret is stored/.test(storedState) && (await google.getByRole("button", { name: "Replace" }).count()) === 1 && (await google.getByLabel("Client secret").count()) === 0, storedState.slice(0, 200));
      results.check("…and the Google row names the app's own client", (await googleRow.innerText()).includes(`Bring your own: ${googleId}`), await googleRow.innerText());
      const historyItems = (history.body as { items?: Array<{ changes?: Array<{ path: string; secret?: boolean }> }> }).items ?? [];
      results.check("…the history records that the secret changed, as a secret", historyItems.some(item => (item.changes ?? []).some(change => change.path === "google.client_secret" && change.secret === true)));
      await shot(env, page, "ds-g-01-google-byo");

      const viaOwn = await providerSignIn(ctx, "google", "providers-byo-google");
      const ownToken = (await oidcLog(ctx, "google", googleId)).find(entry => entry.endpoint === "token");
      await shot(env, viaOwn.page, "ds-g-02-google-byo-signed-in");
      results.check("a Google sign-in now uses the app's own client: Google's consent page names Pixel Studio, and the token call authenticated with the pasted secret", !!viaOwn.account && ownToken?.status === 200 && /Pixel Studio/.test(viaOwn.providerText) && !/to continue to Silicon Accounts/.test(viaOwn.providerText), `${ownToken?.client_id} ${ownToken?.status} ${ownToken?.outcome}; account ${String(viaOwn.account?.uuid)}`);
      await viaOwn.close();

      // Replace the secret with a wrong one: Google refuses the token call, so the stored secret really changed.
      await google.getByRole("button", { name: "Replace" }).click();
      await google.getByLabel("Client secret").fill(`GOCSPX-wrong-${tag()}`);
      const replaced = await saveChanges(page);
      const broken = await providerSignIn(ctx, "google", "providers-wrong-secret");
      const refusedToken = (await oidcLog(ctx, "google", googleId)).find(entry => entry.endpoint === "token");
      const brokenText = (await broken.page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
      await shot(env, broken.page, "ds-g-03-wrong-secret");
      results.check("Replace stores a new secret: with a wrong one Google refuses the token call (invalid_client) and the Carbon is told", replaced.saved && refusedToken?.status === 401 && refusedToken.error === "invalid_client" && !broken.account, `${replaced.text}; token ${refusedToken?.status} ${refusedToken?.error}; page: ${brokenText.slice(0, 200)}`);
      await broken.close();
      await google.getByRole("button", { name: "Replace" }).click();
      await google.getByLabel("Client secret").fill(googleSecret);
      const fixed = await saveChanges(page);
      results.check("…and replacing it with the right one again saves", fixed.saved, fixed.text);
      await google.getByRole("button", { name: "Remove" }).click();
      const removing = (await google.innerText()).replace(/\s+/g, " ");
      const blocked = await saveChanges(page);
      results.check("Remove marks it for removal, and saving is stopped: bring-your-own Google needs a secret", /It will be removed when you save/.test(removing) && !blocked.saved && /client secret/i.test(blocked.text), `${removing.slice(0, 120)} | ${blocked.text.slice(0, 200)}`);
      await google.getByRole("button", { name: "Keep it" }).click();
      await page.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Discard" }).click().catch(() => undefined);

      // Bring your own Apple: the domain and return URL to configure, the IDs, and the .p8 key.
      await apple.getByRole("radio", { name: "Bring your own" }).click();
      const appleSteps = (await apple.innerText()).replace(/\s+/g, " ");
      results.check("Apple's bring-your-own shows the domain and the exact return URL to configure", appleSteps.includes(new URL(env.site).host) && appleSteps.includes(`${env.site}/v1/oauth/callback/apple`), appleSteps.slice(0, 300));
      await apple.getByRole("textbox", { name: "Services ID" }).fill(servicesId);
      await apple.getByRole("textbox", { name: "Team ID" }).fill(teamId.slice(0, 9));
      await apple.getByRole("textbox", { name: "Key ID" }).fill(keyId);
      await apple.getByRole("textbox", { name: "Private key (.p8)" }).fill("not a key");
      const wrongApple = await saveChanges(page);
      results.check("a 9-character Team ID and a key that is not a .p8 PEM are stopped in place, each with why", !wrongApple.saved && /exactly 10 letters or digits/.test(wrongApple.text) && /PEM form/.test(wrongApple.text), wrongApple.text.slice(0, 300));
      await apple.getByRole("textbox", { name: "Team ID" }).fill(teamId);
      await apple.getByRole("textbox", { name: "Private key (.p8)" }).fill(applePem);
      const savedApple = await saveChanges(page);
      const appleView = (await appDetail(ctx, APP)).signin_config.apple;
      const keyBody = applePem.split("\n")[2] ?? applePem;
      const appleEverywhere = [JSON.stringify(await appDetail(ctx, APP)), JSON.stringify((await developerApi(env, page, `/apps/${APP}`)).body), JSON.stringify((await developerApi(env, page, `/apps/${APP}/signin-config/history?limit=50`)).body), await page.content()];
      results.check("saved: Apple byo with the Services ID, Team ID and Key ID, and the key only as private_key_set", savedApple.saved && appleView.mode === "byo" && appleView.services_id === servicesId && appleView.team_id === teamId && appleView.key_id === keyId && appleView.private_key_set === true, `${savedApple.text}; ${JSON.stringify(appleView)}`);
      results.check("…the .p8 key is in none of: the API's answer, the BFF's, the history, the page", appleEverywhere.every(text => !text.includes(keyBody)), keyBody.slice(0, 12));
      const viaApple = await providerSignIn(ctx, "apple", "providers-byo-apple");
      const appleToken = (await oidcLog(ctx, "apple", servicesId)).find(entry => entry.endpoint === "token");
      await shot(env, viaApple.page, "ds-g-04-apple-byo-signed-in");
      results.check("an Apple sign-in uses the app's Services ID, with a client secret signed by its own key (kid, team)", !!viaApple.account && appleToken?.status === 200 && appleToken.client_secret_jwt?.kid === keyId && appleToken.client_secret_jwt?.iss === teamId && appleToken.client_secret_jwt?.sub === servicesId, `${appleToken?.status} ${JSON.stringify(appleToken?.client_secret_jwt)}; account ${String(viaApple.account?.uuid)}`);
      await viaApple.close();

      // Back to one click: the managed clients sign Carbons in again.
      await google.getByRole("radio", { name: "One click" }).click();
      await apple.getByRole("radio", { name: "One click" }).click();
      const backToManaged = await saveChanges(page);
      const view = (await appDetail(ctx, APP)).signin_config;
      results.check("switching both back to one click saves", backToManaged.saved && view.google.mode === "managed" && view.apple.mode === "managed", backToManaged.text);
      await sleep(200);
    } finally {
      await restoreConfig(ctx, APP, before);
      await json(`${env.oidc}/_clients?client_id=${encodeURIComponent(googleId)}`, { method: "DELETE" }).catch(() => undefined);
      await json(`${env.oidc}/_clients?client_id=${encodeURIComponent(servicesId)}`, { method: "DELETE" }).catch(() => undefined);
      await context.close();
    }
  },
};
