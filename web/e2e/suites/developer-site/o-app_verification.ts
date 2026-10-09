/**
 * The App verification tab (UNDERSTANDING "Proofs (User verification and App verification)"): Commit's owner makes app-to-app proofs on the developer site, each
 * for exactly one receiving app. The receiver is picked once (typed or from the owner's own apps; a second pick
 * replaces the first; the issuing app itself, a malformed id and an app that does not exist are refused in place),
 * scopes are checked as they are typed, the lifetime is chosen; the proof token and its refresh token are shown once,
 * masked until shown. The receiving app verifies it ({valid, expires_at, issuing app, receiving app}); any other app
 * is told {valid: false, expires_at: null}. The refresh token gets new proof tokens, and presenting a used one revokes
 * the proof. Every proof Commit issued is listed by kind and status (an expired one by SQL time travel), any active one
 * is revoked from its row, and a request for several apps at once is refused with `app_verification_single_app` through the BFF.
 */
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { api, developerApi, issueAppVerification, shot, sleep, sql, tag, verifyProof } from "../../lib";
import { addTag, appBasic, errorCode, errorMessage, ownerSignIn, pressSegment } from "./_helpers";
import { until } from "./_kit";

const APP = "commit";

interface ListedProof {
  proof_id: string;
  kind: string;
  receiving_app?: string | null;
  audiences?: string[];
  scopes: string[];
  status: string;
  revoke_reason: string | null;
  access_ttl_seconds: number;
}

const appIdOf = (value: unknown) => (typeof value === "string" ? value : (value as { app_id?: string } | null)?.app_id ?? "");

/** The field's own error text (aria-describedby), or "". */
async function describedError(field: Locator): Promise<string> {
  const ids = ((await field.getAttribute("aria-describedby").catch(() => null)) ?? "").split(/\s+/).filter(Boolean);
  const texts = await Promise.all(ids.map(id => field.page().locator(`[id="${id}"]`).innerText().catch(() => "")));
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

async function choose(page: Page, id: string): Promise<void> {
  // A receiver already chosen stays until removed (one app per proof).
  const chosen = page.getByRole("tabpanel", { name: "App verification" }).getByRole("button", { name: /^Remove [a-z0-9-]+$/ });
  if (await chosen.count()) await chosen.first().click();
  const field = page.getByRole("textbox", { name: "The app that receives it" });
  await field.fill(id);
  await page.getByRole("button", { name: "Choose", exact: true }).click();
  await sleep(350);
}

/** Makes the proof with the tab's button and reads the reveal: both tokens (shown with their eye buttons) and its words. */
async function makeProof(page: Page): Promise<{ token: string; refresh: string; masked: string; text: string; ms: number }> {
  const started = performance.now();
  await page.getByRole("button", { name: "Create token" }).click();
  const reveal = page.getByRole("group", { name: "Your verification tokens" });
  await reveal.waitFor({ timeout: 20_000 });
  const ms = performance.now() - started;
  const masked = ((await reveal.locator("code").first().textContent()) ?? "").trim();
  await reveal.getByRole("button", { name: "Show the verification token" }).click();
  await reveal.getByRole("button", { name: "Show the verification refresh token" }).click();
  const shown = await reveal.locator("code[data-shown]").allTextContents();
  return { token: (shown[0] ?? "").trim(), refresh: (shown[1] ?? "").trim(), masked, text: (await reveal.innerText()).replace(/\s+/g, " "), ms };
}

export const journey: Journey = {
  name: "developer-site-app_verification",
  title: "the App verification tab: one receiving app per proof (typed or suggested; a second pick replaces the first; itself, a malformed id and a missing app refused), scopes checked as typed, the lifetime chosen, both tokens shown once; the receiver verifies it and any other app is told valid:false; refresh and reuse; listed by kind and status (expired by time travel); revoked from its row; several apps at once refused (app_verification_single_app) through the BFF",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const { context, page } = await ownerSignIn(ctx, APP, { label: "app_verification", returnTo: `/apps/${APP}/app-verification`, expected: [/status of 422 \(Unprocessable Entity\) @ .*\/proofs\/app-verification/, /status of 404 \(Not Found\) @ .*\/api\/accounts\/apps\/no-such-app-[a-z0-9]+\/public/] });
    try {
      const panel = page.getByRole("tabpanel", { name: "App verification" });
      const field = panel.getByRole("textbox", { name: "The app that receives it" });
      await field.waitFor({ timeout: 30_000 });
      const proofs = async (query = "") => (await developerApi<{ items?: ListedProof[] }>(env, page, `/apps/${APP}/proofs?limit=100${query}`)).body.items ?? [];

      // Picking the one app that receives it.
      const suggestions = (await panel.getByText("Your apps:").locator("xpath=..").getByRole("button").allInnerTexts()).map(text => text.trim()).sort();
      results.check("the owner's other apps are offered as receivers (briefcase, remind, spacestation; never commit itself, accounts or developer)", suggestions.join(" ") === "briefcase remind spacestation", suggestions.join(" "));
      await choose(page, APP);
      const self = await describedError(field);
      await choose(page, "Not An App!");
      const malformed = await describedError(field);
      results.check("Commit itself is refused as the receiver, and so is a malformed app id, each in place", /commit is the app issuing the proof; pick the app that receives it/.test(self) && malformed.length > 0 && (await panel.getByRole("button", { name: /^Remove / }).count()) === 0, `${self} | ${malformed}`);
      await choose(page, `no-such-app-${t}`);
      const missing = panel.getByRole("alert").filter({ hasText: "This app can't receive the proof" });
      await missing.waitFor({ timeout: 10_000 }).catch(() => undefined);
      const missingText = (await missing.innerText().catch(() => "")).replace(/\s+/g, " ");
      results.check("an app id that does not exist is looked up and refused before anything is sent (Make the proof stays off)", missingText.includes(`no-such-app-${t}`) && (await panel.getByRole("button", { name: "Create token" }).isDisabled()), missingText);
      await panel.getByRole("button", { name: `Remove no-such-app-${t}` }).click();
      await panel.getByRole("button", { name: "remind", exact: true }).click();
      await sleep(300);
      await panel.getByRole("button", { name: "briefcase", exact: true }).click();
      await sleep(400);
      const chips = await panel.getByRole("button", { name: /^Remove / }).allInnerTexts().catch(() => []);
      const forWho = (await panel.getByText(/^For [a-z0-9-]+ only, valid/).innerText().catch(() => "")).trim();
      results.check("a second pick replaces the first: one receiving app per proof", (await panel.getByRole("button", { name: /^Remove / }).count()) === 1 && (await panel.getByRole("button", { name: "Remove briefcase" }).count()) === 1 && /^For briefcase only, valid 30 minutes at a time$/.test(forWho), `${chips.length} chip(s); ${forWho}`);
      await panel.getByRole("button", { name: "Remove briefcase" }).click();
      await panel.getByRole("button", { name: "remind", exact: true }).click();
      await sleep(300);

      // Scopes and lifetime.
      const refused = await addTag(panel, "Scopes (optional)", "bad scope!");
      const accepted = await addTag(panel, "Scopes (optional)", "notify.send");
      const scopeChips = (await panel.innerText()).includes("notify.send");
      results.check("a scope with a space and \"!\" is refused as it is typed; notify.send is taken", refused.length > 0 && !(await panel.innerText()).includes("bad scope!") && scopeChips, `${refused.join(" ")} | ${accepted.join(" ")}`);
      await pressSegment(panel, "Token lifetime", "1 minute");
      results.check("the lifetime picked says what the proof will be", /^For remind only, valid 1 minute at a time$/.test((await panel.getByText(/^For [a-z0-9-]+ only, valid/).innerText().catch(() => "")).trim()));

      // The proof, shown once.
      const first = await makeProof(page);
      results.metric("Make the proof → shown", first.ms, "ms");
      await shot(env, page, "ds-o-01-proof");
      results.check("both tokens are shown once, masked until shown (sap_… and sapr_…), naming the receiver and the scope", /^sap_•+$/.test(first.masked) && /^sap_/.test(first.token) && /^sapr_/.test(first.refresh) && /Commit → remind, scopes notify\.send/.test(first.text) && /This is the only time they are shown/.test(first.text), `${first.masked} ${first.token.slice(0, 8)} ${first.refresh.slice(0, 9)} — ${first.text.slice(0, 160)}`);
      results.check("…with the receiving app's verify call ready to copy (its own credentials, /v1/proofs/verify)", /curl -u remind:\$APP_SECRET/.test(first.text) && first.text.includes(`${env.site}/v1/proofs/verify`), first.text.slice(first.text.indexOf("Verify it"), first.text.indexOf("Verify it") + 160));

      const verified = await verifyProof(ctx, "remind", first.token, { direct: true });
      const expiresIn = verified.body.expires_at ? Date.parse(verified.body.expires_at) - Date.now() : NaN;
      results.metric("remind verifies the proof", verified.ms, "ms");
      results.check("remind verifies it: valid, issued by commit, for remind, with its scope, for about a minute", verified.body.valid === true && appIdOf(verified.body.issuing_app) === APP && appIdOf(verified.body.receiving_app) === "remind" && JSON.stringify(verified.body.scopes ?? []) === '["notify.send"]' && expiresIn > 20_000 && expiresIn <= 61_000, `${JSON.stringify(verified.body).slice(0, 240)} (expires in ${Math.round(expiresIn / 1000)} s)`);
      const wrong = await verifyProof(ctx, "waveform", first.token, { direct: true });
      results.check("waveform, which the proof is not for, is told {valid: false, expires_at: null}", wrong.body.valid === false && wrong.body.expires_at === null && Object.keys(wrong.body).length === 2, JSON.stringify(wrong.body));

      await page.getByRole("group", { name: "Your verification tokens" }).getByRole("button", { name: "I've stored them" }).click();
      await sleep(500);
      const content = await page.content();
      results.check("\"I've stored them\" takes both tokens off the page for good", !content.includes(first.token) && !content.includes(first.refresh));

      // Refresh, and a used refresh token presented again.
      const refresh = (token: string) => api<{ proof_token?: string; proof_refresh_token?: string }>(ctx, "/v1/proofs/refresh", { method: "POST", direct: true, headers: { authorization: appBasic(APP) }, json: { proof_refresh_token: token } });
      const renewed = await refresh(first.refresh);
      const renewedOk = renewed.status === 200 && !!renewed.body.proof_token && (await verifyProof(ctx, "remind", renewed.body.proof_token!, { direct: true })).body.valid === true;
      results.check("Commit's server refreshes it: a new proof token remind verifies, and a new refresh token", renewedOk && /^sapr_/.test(renewed.body.proof_refresh_token ?? "") && renewed.body.proof_refresh_token !== first.refresh, `${renewed.status} ${JSON.stringify(renewed.body).slice(0, 120)}`);
      const reused = await refresh(first.refresh);
      const afterReuse = renewed.body.proof_token ? await verifyProof(ctx, "remind", renewed.body.proof_token, { direct: true }) : null;
      results.check("presenting the used refresh token again is refused and revokes the proof (the newest token stops verifying)", reused.status >= 400 && afterReuse?.body.valid === false, `${reused.status} ${errorCode(reused.body)}; then ${JSON.stringify(afterReuse?.body)}`);

      // A proof for an app the owner does not own (typed), revoked from its row.
      await choose(page, "waveform");
      await pressSegment(panel, "Token lifetime", "30 minutes");
      const second = await makeProof(page);
      await page.getByRole("group", { name: "Your verification tokens" }).getByRole("button", { name: "I've stored them" }).click();
      const secondValid = await verifyProof(ctx, "waveform", second.token, { direct: true });
      results.check("a proof for waveform (typed: not one of the owner's apps), verified by waveform", secondValid.body.valid === true && appIdOf(secondValid.body.receiving_app) === "waveform", JSON.stringify(secondValid.body).slice(0, 200));

      // One more from the server, which ends (time travel on its own family).
      const third = await issueAppVerification(ctx, APP, "remind", { direct: true });
      if (third.body.proof_id) await sql(env, `update proof_families set expires_at = now() - interval '1 second' where id = '${third.body.proof_id}'`);
      const listed = await until(async () => {
        const items = await proofs();
        return items.some(item => item.proof_id === third.body.proof_id) ? items : null;
      }, 10_000) ?? [];
      const mine = listed.filter(item => [first, second].length && item.kind === "app_verification");
      const firstListed = listed.find(item => item.status === "revoked" && (item.receiving_app ?? item.audiences?.[0]) === "remind" && item.scopes.includes("notify.send"));
      const secondListed = listed.find(item => item.status === "active" && (item.receiving_app ?? item.audiences?.[0]) === "waveform");
      const thirdListed = listed.find(item => item.proof_id === third.body.proof_id);
      results.check("the listing names each proof's one receiving app, its scopes, lifetime and status (revoked after reuse, active, expired)", !!firstListed && firstListed.access_ttl_seconds === 60 && !!firstListed.revoke_reason && !!secondListed && thirdListed?.status === "expired" && mine.every(item => (item.receiving_app ? 1 : (item.audiences ?? []).length) === 1), JSON.stringify({ first: firstListed, second: secondListed?.status, third: thirdListed?.status }).slice(0, 300));

      // The list on the tab: kinds and statuses.
      await page.reload();
      await field.waitFor({ timeout: 30_000 });
      const list = panel.locator("ul[role='list']").filter({ has: page.getByText("App verification", { exact: true }) }).first();
      await list.waitFor({ timeout: 20_000 });
      const statusFilter = async (label: string) => {
        await pressSegment(panel, "Status", label);
        await sleep(700);
        return (await panel.locator("li").filter({ has: page.locator("[data-proof-status]") }).allInnerTexts()).map(text => text.replace(/\s+/g, " "));
      };
      const expired = await statusFilter("Expired");
      const revokedRows = await statusFilter("Revoked");
      const active = await statusFilter("Active");
      results.check("Status filters: Expired, Revoked and Active show only those", expired.length >= 1 && expired.every(row => /Expired/.test(row)) && revokedRows.length >= 1 && revokedRows.every(row => /Revoked/.test(row)) && active.length >= 1 && active.every(row => /Active/.test(row)), `expired ${expired.length}, revoked ${revokedRows.length}, active ${active.length}`);
      await pressSegment(panel, "Status", "Any status");
      await pressSegment(panel, "Kind", "User verification");
      await sleep(700);
      const user_verification = (await panel.innerText()).replace(/\s+/g, " ");
      results.check("Kind · On behalf of: Commit issued no User verification proof, and the tab says so", /No verifications match/.test(user_verification) && /Try another kind or status/.test(user_verification), user_verification.slice(user_verification.indexOf("Verifications this app issued"), user_verification.indexOf("Verifications this app issued") + 200));
      await pressSegment(panel, "Kind", "App verification");
      await sleep(600);

      // Revoke the waveform proof from its row.
      const row = panel.locator("li").filter({ has: page.locator('[aria-label="Commit to waveform"]') }).filter({ hasText: "Active" }).first();
      await row.getByRole("button", { name: "Revoke", exact: true }).first().click();
      await row.getByRole("button", { name: "Revoke", exact: true }).last().click();
      const gone = await until(async () => (await verifyProof(ctx, "waveform", second.token, { direct: true })).body.valid === false, 10_000, 400);
      const revokedNow = (await proofs()).find(item => item.status === "revoked" && (item.receiving_app ?? item.audiences?.[0]) === "waveform");
      await sleep(800);
      await shot(env, page, "ds-o-02-revoked");
      results.check("Revoke on its row revokes it: waveform's verify now answers valid:false, the list says Revoked", !!gone && !!revokedNow && (await panel.getByText("Revoked").count()) > 0, String(revokedNow?.status));

      // Several apps at once, through the developer site's BFF: refused, nothing made.
      const before = (await proofs()).length;
      const several = await developerApi(env, page, `/apps/${APP}/proofs/app-verification`, { method: "POST", json: { audiences: ["remind", "waveform"] }, headers: { "idempotency-key": `ds-${t}-several` } });
      const one = await developerApi(env, page, `/apps/${APP}/proofs/app-verification`, { method: "POST", json: { audiences: ["remind"] }, headers: { "idempotency-key": `ds-${t}-one` } });
      results.check("a proof for several apps (audiences) is refused through the BFF: 422 app_verification_single_app, \"An app verification is for exactly one app; ask for one proof per app.\"", several.status === 422 && errorCode(several.body) === "app_verification_single_app" && /An app verification is for exactly one app; ask for one proof per app\./.test(errorMessage(several.body)), `${several.status} ${JSON.stringify(several.body).slice(0, 240)}`);
      results.check("…even with one app in `audiences` (receiving_app is the only way)", one.status === 422 && errorCode(one.body) === "app_verification_single_app", `${one.status} ${errorCode(one.body)}`);
      results.check("…and nothing was made", (await proofs()).length === before, `${before} → ${(await proofs()).length}`);
    } finally {
      await context.close();
    }
  },
};
