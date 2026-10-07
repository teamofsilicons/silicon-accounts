/**
 * Bring-your-own provider secrets are write-only: the Sign-in tab, the API (owner and app credentials), the public
 * config and the version history only ever say that one is stored. Replacing one makes a version whose history says
 * "a secret → a secret"; re-entering the stored one changes nothing. The stored secret is the one Google and Apple
 * actually receive (a wrong one makes the provider refuse, the original works again). Removing one, or a key that is
 * not a P-256 .p8, is refused with the reason.
 */
import { generateKeyPairSync } from "node:crypto";
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { json, newContext, shot, sleep, tag } from "../../lib";
import { appBasic, asSession, chooseMockIdentity, fakeApp, oidcLog, ownerSignIn } from "./_helpers";

interface HistoryItem {
  version: number;
  changes: Array<{ path: string; before: unknown; after: unknown; secret?: boolean }>;
}

interface Detail {
  config_version: number;
  signin_config: { google: Record<string, unknown>; apple: Record<string, unknown> };
}

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      keysOf(child, out);
    }
  }
  return out;
}

async function allHistory(page: Page, ctx: Ctx, appId: string): Promise<HistoryItem[]> {
  return (await asSession<{ items: HistoryItem[] }>(page, ctx.env, "GET", `/v1/apps/${appId}/signin-config/history?limit=200`)).body.items ?? [];
}

/** A fresh visitor tries the provider button of `appId`; returns where it ended (signup, an error code, or neither). */
async function tryProvider(ctx: Ctx, appId: string, provider: "Google" | "Apple", label: string): Promise<{ outcome: "signup" | "error" | "nothing"; code: string | null; ms: number }> {
  const { env, browser, results } = ctx;
  const context = await newContext(browser);
  const page = await context.newPage();
  results.watch(page, label);
  const started = Date.now();
  await page.goto(`${env.apps}/${appId}/?only=hosted`);
  await page.locator("#signin-hosted").click();
  await page.getByRole("button", { name: `Continue with ${provider}` }).click({ timeout: 30_000 });
  const t = tag();
  await chooseMockIdentity(env, page, `dvb.byo.${t}@${provider === "Google" ? "gmail" : "icloud"}.test`, `Byo Tester ${t}`);
  const signup = page.getByRole("button", { name: "Create account" }).waitFor({ timeout: 30_000 }).then(() => "signup" as const);
  const error = page.locator("main [data-error-code]").first().waitFor({ timeout: 30_000 }).then(() => "error" as const);
  const outcome = await Promise.race([signup, error]).catch(() => "nothing" as const);
  const code = outcome === "error" ? await page.locator("main [data-error-code]").first().getAttribute("data-error-code") : null;
  await sleep(400);
  await shot(env, page, `${label}-${outcome}`);
  await context.close();
  return { outcome, code, ms: Date.now() - started };
}

export const journey: Journey = {
  name: "developer-branding-byo-secrets",
  title: "BYO Google secret and Apple key: masked in the tab, the API, public config and history; replace (history redacted), same value no-op, wrong secret reaches Google and fails, original restored works; removal and bad keys refused",
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();

    /* ------------------------------------------------------------------ Google: acme-notes */
    const acme = fakeApp("acme-notes");
    const googleSecret = String(acme.signin_defaults?.google?.client_secret);
    const googleClient = String(acme.signin_defaults?.google?.client_id);
    const owner = await ownerSignIn(ctx, "acme-notes", "dvb-c-acme", { expected: [/status of 422/] });
    const { page } = owner;
    const saveBar = page.getByRole("region", { name: "Unsaved changes" });

    const asOwner = await asSession<Detail>(page, env, "GET", "/v1/apps/acme-notes");
    const asApp = await json<Detail>(`${env.site}/v1/apps/acme-notes`, { headers: { authorization: appBasic("acme-notes") } });
    const publicConfig = await json(`${env.site}/v1/apps/acme-notes/public`);
    const v0 = asOwner.body.config_version;
    const google = asOwner.body.signin_config.google;
    results.check("the owner's GET says a Google secret is stored (client_secret_set) without the secret itself", google.mode === "byo" && google.client_id === googleClient && google.client_secret_set === true && !keysOf(asOwner.body).includes("client_secret") && !JSON.stringify(asOwner.body).includes(googleSecret), JSON.stringify(google));
    results.check("the app's own GET masks it the same way", asApp.status === 200 && asApp.body.signin_config.google.client_secret_set === true && !JSON.stringify(asApp.body).includes(googleSecret));
    results.check("the public config carries no Google secret (nor whether one is set)", publicConfig.status === 200 && !/client_secret|GOCSPX/.test(JSON.stringify(publicConfig.body)));
    const history0 = await allHistory(page, ctx, "acme-notes");
    results.check("the version history never holds the secret", history0.length > 0 && !JSON.stringify(history0).includes(googleSecret), `${history0.length} entries`);

    await page.goto(`${env.site}/developer/acme-notes/sign-in`);
    await page.getByText(`Stored version ${v0}`).waitFor({ timeout: 20_000 });
    const google0 = page.getByRole("region", { name: "Google" });
    results.check("the Sign-in tab says \"A client secret is stored\" next to the client ID", (await google0.getByText("A client secret is stored").count()) === 1 && (await google0.getByRole("textbox", { name: "Client ID" }).inputValue()) === googleClient);
    const html = await page.content();
    const inputs = await page.locator("input, textarea").evaluateAll(fields => fields.map(field => (field as HTMLInputElement).value));
    results.check("neither the page's HTML nor any field holds the stored secret", !html.includes(googleSecret) && !inputs.includes(googleSecret));
    await shot(env, page, "dvb-c-01-google-stored");

    // Replace, type something, then think better of it: "Keep the stored secret" shows the stored state again, drops
    // what was typed, leaves nothing to save, and hands focus to Replace (not to the page).
    const typedThenKept = `GOCSPX-dvb${t}TypedThenKept`;
    await google0.getByRole("button", { name: "Replace" }).click();
    await google0.getByLabel("Client secret").fill(typedThenKept);
    await sleep(200);
    const dirtyWhileTyped = await saveBar.count();
    await google0.getByRole("button", { name: "Keep the stored secret" }).click();
    await sleep(400);
    const keptValues = await page.locator("input, textarea").evaluateAll(fields => fields.map(field => (field as HTMLInputElement).value));
    results.check("\"Keep the stored secret\" after typing a replacement shows \"A client secret is stored\" again, drops the typed value and leaves nothing to save", dirtyWhileTyped > 0 && (await google0.getByText("A client secret is stored").count()) === 1 && !keptValues.includes(typedThenKept) && (await saveBar.count()) === 0, `save bar while typing ${dirtyWhileTyped}, after ${await saveBar.count()}; stored line ${await google0.getByText("A client secret is stored").count()}`);
    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active ? `${active.tagName.toLowerCase()} "${(active.textContent ?? "").trim().slice(0, 40)}"` : "nothing";
    });
    results.check("focus goes to the stored secret's Replace when its replace field closes", await google0.getByRole("button", { name: "Replace" }).evaluate(el => el === document.activeElement).catch(() => false), `focus on ${focused}`);

    // Re-entering the stored secret is no change at all: no version, no history entry.
    await google0.getByRole("button", { name: "Replace" }).click();
    await google0.getByLabel("Client secret").fill(googleSecret);
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await sleep(1500);
    const same = (await asSession<Detail>(page, env, "GET", "/v1/apps/acme-notes")).body;
    results.check("saving the same secret again makes no new version and no history entry", same.config_version === v0 && (await allHistory(page, ctx, "acme-notes")).length === history0.length, `v${same.config_version}`);

    // A new (wrong) secret: a version whose history says only that a secret changed.
    const wrong = `GOCSPX-dvb${t}WrongSecretForTheMock`;
    await page.reload();
    await page.getByText(`Stored version ${v0}`).waitFor({ timeout: 20_000 });
    const google1 = page.getByRole("region", { name: "Google" });
    await google1.getByRole("button", { name: "Replace" }).click();
    const field = google1.getByLabel("Client secret");
    results.check("the replacement field is a password field (the typed secret is not shown)", (await field.getAttribute("type")) === "password");
    await field.fill(wrong);
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await saveBar.getByText(`Saved as version ${v0 + 1}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    const history1 = await allHistory(page, ctx, "acme-notes");
    const replaced = history1[0];
    results.check(`replacing the secret stores version ${v0 + 1} with one redacted change: google.client_secret, "[redacted]" → "[redacted]"`, replaced?.version === v0 + 1 && replaced.changes.length === 1 && replaced.changes[0]?.path === "google.client_secret" && replaced.changes[0]?.secret === true && replaced.changes[0]?.before === "[redacted]" && replaced.changes[0]?.after === "[redacted]", JSON.stringify(replaced).slice(0, 300));
    results.check("the history and the page never show the new secret", !JSON.stringify(history1).includes(wrong) && !(await page.content()).includes(wrong), `history ${JSON.stringify(history1).includes(wrong)}, page ${(await page.content()).includes(wrong)}`);
    const afterSave = (await google1.innerText()).replace(/\s+/g, " ");
    results.check("after the save the secret field is back to \"A client secret is stored\" (not an empty replace field)", (await google1.getByText("A client secret is stored").count()) === 1, `shows: ${/Keep the stored secret/.test(afterSave) ? "an empty \"Client secret\" field with \"Keep the stored secret\"" : afterSave.slice(-160)}`);
    await page.getByRole("complementary", { name: "On this page" }).getByRole("button", { name: "History" }).click();
    const drawer = page.getByRole("dialog", { name: "Version history" });
    await drawer.getByText(`Version ${v0 + 1}`).first().waitFor({ timeout: 15_000 });
    await sleep(500);
    const drawerText = (await drawer.innerText()).replace(/\s+/g, " ");
    results.check("the History drawer lists the change as \"a secret → a secret\"", /a secret\s*→\s*a secret/.test(drawerText) && !drawerText.includes(wrong), drawerText.slice(0, 240));
    await shot(env, page, "dvb-c-02-google-history");
    await page.keyboard.press("Escape");

    // The stored secret is what Google gets: with the wrong one the provider refuses the code exchange.
    const failing = await tryProvider(ctx, "acme-notes", "Google", "dvb-c-google-wrong-secret");
    const token1 = (await oidcLog(env, "google", "token"))[0];
    results.check("with the wrong secret stored, Google's token endpoint refuses acme's client (invalid_client)", token1?.client_id === googleClient && token1.status === 401 && token1.error === "invalid_client", JSON.stringify(token1).slice(0, 240));
    results.check("the Carbon sees why on acme's sign-in page (a provider error), not a sign-up", failing.outcome === "error" && /^provider_/.test(failing.code ?? ""), `${failing.outcome} ${failing.code}`);

    // Restoring the original: version +1, and Google sign-in works again.
    await page.reload();
    await page.getByText(`Stored version ${v0 + 1}`).waitFor({ timeout: 20_000 });
    const google2 = page.getByRole("region", { name: "Google" });
    await google2.getByRole("button", { name: "Replace" }).click();
    await google2.getByLabel("Client secret").fill(googleSecret);
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await saveBar.getByText(`Saved as version ${v0 + 2}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    const working = await tryProvider(ctx, "acme-notes", "Google", "dvb-c-google-restored");
    const token2 = (await oidcLog(env, "google", "token"))[0];
    results.check("with the original secret back, Google answers acme's exchange and the Carbon reaches sign-up", working.outcome === "signup" && token2?.client_id === googleClient && token2.status === 200, `${working.outcome} ${JSON.stringify(token2).slice(0, 160)}`);
    results.metric("Google BYO sign-in (button → sign-up step)", working.ms);

    // Removing the only secret of a BYO Google is refused before anything is sent; the API refuses it too.
    await page.reload();
    await page.getByText(`Stored version ${v0 + 2}`).waitFor({ timeout: 20_000 });
    const google3 = page.getByRole("region", { name: "Google" });
    await google3.getByRole("button", { name: "Remove" }).click();
    await google3.getByText("It will be removed when you save.").waitFor({ timeout: 5_000 });
    await sleep(300);
    const blocked = (await saveBar.innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("marking the BYO secret for removal blocks saving (Google needs both the ID and the secret)", /problem blocks saving/.test(blocked), blocked);
    await google3.getByRole("button", { name: "Keep it" }).click();
    const removal = await asSession<{ error?: { details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", "/v1/apps/acme-notes/signin-config", { google: { client_secret: null } });
    const spaced = await asSession<{ error?: { details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", "/v1/apps/acme-notes/signin-config", { google: { client_secret: "has a space" } });
    const masked = await asSession<Detail>(page, env, "PATCH", "/v1/apps/acme-notes/signin-config", { google: { client_secret_set: false } });
    results.check("PATCH removing it answers 422 google.client_secret \"is required when google.mode is byo\"", removal.status === 422 && /is required when google.mode is byo/.test(removal.body.error?.details?.fields?.["google.client_secret"] ?? ""), JSON.stringify(removal.body).slice(0, 200));
    results.check("PATCH with spaces in a secret answers 422 with the rule", spaced.status === 422 && /visible ASCII characters without spaces/.test(spaced.body.error?.details?.fields?.["google.client_secret"] ?? ""), JSON.stringify(spaced.body).slice(0, 200));
    results.check("echoing the read-only client_secret_set back changes nothing (still set, same version)", masked.status === 200 && masked.body.config_version === v0 + 2 && masked.body.signin_config.google.client_secret_set === true, `${masked.status} v${masked.body.config_version}`);
    await owner.context.close();

    /* ------------------------------------------------------------------ Apple: orbit-games */
    const orbit = fakeApp("orbit-games");
    const appleKey = String(orbit.signin_defaults?.apple?.private_key);
    const keyBody = appleKey.split("\n")[1] ?? "";
    const apple = await ownerSignIn(ctx, "orbit-games", "dvb-c-orbit", { expected: [/status of 422/] });
    const applePage = apple.page;
    const appleBar = applePage.getByRole("region", { name: "Unsaved changes" });
    const orbitDetail = (await asSession<Detail>(applePage, env, "GET", "/v1/apps/orbit-games")).body;
    const a0 = orbitDetail.config_version;
    results.check("the owner's GET says an Apple key is stored (private_key_set) without any key material", orbitDetail.signin_config.apple.mode === "byo" && orbitDetail.signin_config.apple.private_key_set === true && !keysOf(orbitDetail).includes("private_key") && !JSON.stringify(orbitDetail).includes(keyBody), JSON.stringify(orbitDetail.signin_config.apple));
    results.check("orbit's history holds no key material", !JSON.stringify(await allHistory(applePage, ctx, "orbit-games")).includes(keyBody));
    await applePage.goto(`${env.site}/developer/orbit-games/sign-in`);
    await applePage.getByText(`Stored version ${a0}`).waitFor({ timeout: 20_000 });
    const appleRegion = applePage.getByRole("region", { name: "Apple" });
    results.check("the Sign-in tab says \"A private key is stored\" and the page holds no key material", (await appleRegion.getByText("A private key is stored").count()) === 1 && !(await applePage.content()).includes(keyBody));
    await shot(env, applePage, "dvb-c-03-apple-stored");

    // A key that is not a P-256 PKCS#8 .p8: the server refuses it with the reason, next to the field.
    await appleRegion.getByRole("button", { name: "Replace" }).click();
    const keyField = appleRegion.getByRole("textbox", { name: "Private key (.p8)" });
    await keyField.fill("-----BEGIN PRIVATE KEY-----\nTm90IGEga2V5IGF0IGFsbA==\n-----END PRIVATE KEY-----");
    await appleBar.getByRole("button", { name: "Save changes" }).click();
    await applePage.getByText("Some settings need fixing").waitFor({ timeout: 15_000 }).catch(() => undefined);
    const refusedText = (await appleRegion.innerText()).replace(/\s+/g, " ");
    results.check("a key that is not an EC P-256 PKCS#8 key is refused next to the field, and nothing is saved", /not a valid PKCS#8 EC P-256 private key/.test(refusedText) && (await applePage.getByText(`Stored version ${a0}`).count()) > 0, refusedText.slice(0, 200));
    await shot(env, applePage, "dvb-c-04-apple-bad-key");
    await appleBar.getByRole("button", { name: "Discard" }).click();
    await sleep(400);
    results.check("Discard puts the key field back to \"A private key is stored\"", (await appleRegion.getByText("A private key is stored").count()) === 1, `shows: ${(await appleRegion.getByRole("button", { name: "Keep the stored key" }).count()) ? "an empty \"Private key (.p8)\" field with \"Keep the stored key\"" : "something else"}`);
    // (A reload shows the stored state again either way.)
    await applePage.reload();
    await applePage.getByText(`Stored version ${a0}`).waitFor({ timeout: 20_000 });
    await applePage.getByRole("textbox", { name: "Team ID" }).fill("SHORT");
    await sleep(300);
    results.check("a Team ID that is not 10 letters or digits blocks saving", /problem blocks saving/.test(await appleBar.innerText().catch(() => "")));
    await appleBar.getByRole("button", { name: "Discard" }).click();

    // A new valid key: a redacted version; Apple then refuses orbit's client secret (signed with the new key)...
    const fresh = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await appleRegion.getByRole("button", { name: "Replace" }).click();
    await appleRegion.getByRole("textbox", { name: "Private key (.p8)" }).fill(fresh);
    await appleBar.getByRole("button", { name: "Save changes" }).click();
    await appleBar.getByText(`Saved as version ${a0 + 1}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    const appleHistory = (await allHistory(applePage, ctx, "orbit-games"))[0];
    results.check(`a new .p8 key stores version ${a0 + 1} with one redacted change (apple.private_key)`, appleHistory?.version === a0 + 1 && appleHistory.changes.length === 1 && appleHistory.changes[0]?.path === "apple.private_key" && appleHistory.changes[0]?.after === "[redacted]" && !JSON.stringify(appleHistory).includes(fresh.split("\n")[1] ?? "x"), JSON.stringify(appleHistory).slice(0, 240));
    const appleFails = await tryProvider(ctx, "orbit-games", "Apple", "dvb-c-apple-new-key");
    const appleToken = (await oidcLog(env, "apple", "token"))[0];
    results.check("with a key Apple does not know, Apple refuses orbit's client secret JWT, and the Carbon sees a provider error", appleToken?.client_id === "test.orbit-games.signin" && appleToken.status >= 400 && appleFails.outcome === "error", `${appleFails.outcome} ${appleFails.code} ${JSON.stringify(appleToken).slice(0, 200)}`);

    // ...and with the original key back, Apple sign-in works again.
    await applePage.reload();
    await applePage.getByText(`Stored version ${a0 + 1}`).waitFor({ timeout: 20_000 });
    const appleRegion2 = applePage.getByRole("region", { name: "Apple" });
    await appleRegion2.getByRole("button", { name: "Replace" }).click();
    await appleRegion2.getByRole("textbox", { name: "Private key (.p8)" }).fill(appleKey);
    await appleBar.getByRole("button", { name: "Save changes" }).click();
    await appleBar.getByText(`Saved as version ${a0 + 2}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    const appleWorks = (await tryProvider(ctx, "orbit-games", "Apple", "dvb-c-apple-restored")).outcome === "signup";
    const appleToken2 = (await oidcLog(env, "apple", "token"))[0];
    results.check("with the original key restored, Apple accepts orbit's client secret and the Carbon reaches sign-up", appleWorks && appleToken2?.status === 200, JSON.stringify(appleToken2).slice(0, 200));
    await apple.context.close();
  },
};
