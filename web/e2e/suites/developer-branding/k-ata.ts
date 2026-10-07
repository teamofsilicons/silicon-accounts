/**
 * The ATA creator (commit's Proofs tab, its owner signs in): audiences are checked as they are typed (not an app id,
 * the issuing app itself, an app that does not exist); a proof for remind and waveform is issued once and its tokens
 * are revealed exactly once (masked until shown, gone after "I've stored them": not in the page, a reload, the API's
 * proof list, or browser storage); it verifies for its audiences only, its refresh token rotates once, and the owner's
 * revoke ends it at once.
 */
import type { Journey } from "../../context";
import { json, shot, sleep, tag } from "../../lib";
import { appBasic, asSession, ownerSignIn } from "./_helpers";

const APP = "commit";

interface Verification {
  valid: boolean;
  expires_at: string | null;
  kind?: string;
  issuing_app?: { app_id: string };
  receiving_app?: { app_id: string };
  scopes?: string[];
}

/** Exactly {valid: false, expires_at: null}, nothing more (in any key order). */
const invalid = (body: Verification) => body.valid === false && body.expires_at === null && Object.keys(body).length === 2;

export const journey: Journey = {
  name: "developer-branding-ata",
  title: "ATA creator: audience refusals as typed, one proof for remind+waveform revealed once (masked, then gone from page, reload, API and storage), verifies for its audiences only, refresh rotates once, revoke ends it",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const verify = (app: string, token: string) => json<Verification>(`${env.site}/v1/proofs/verify`, { method: "POST", headers: { authorization: appBasic(app), "content-type": "application/json" }, body: JSON.stringify({ proof_token: token }) });
    // Looking up the app that does not exist answers 404 (the browser logs it).
    const owner = await ownerSignIn(ctx, APP, "dvb-k-owner", { expected: [/status of 404/] });
    const { page } = owner;
    const before = (await asSession<{ items: Array<{ proof_id: string }> }>(page, env, "GET", `/v1/apps/${APP}/proofs?kind=ata&limit=200`)).body.items?.length ?? 0;
    await page.goto(`${env.site}/developer/${APP}/proofs`);
    const audiences = page.getByRole("textbox", { name: "Apps that may verify it" });
    await audiences.waitFor({ timeout: 20_000 });
    const lastProblem = () => page.locator("ul[aria-live='polite'] li").first().innerText().catch(() => "");

    // Refusals while typing: not an app id, the issuing app itself, an app nobody created.
    await audiences.fill("Not An App!");
    await audiences.press("Enter");
    results.check("\"Not An App!\" is refused: not an app id", /is not an app id/.test(await lastProblem()), await lastProblem());
    await audiences.fill(APP);
    await audiences.press("Enter");
    results.check("commit itself is refused: it is the app issuing the proof", /is the app issuing the proof/.test(await lastProblem()), await lastProblem());
    await audiences.fill(`no-such-app-${t}`);
    await audiences.press("Enter");
    await page.getByText("Some apps can't receive the proof").waitFor({ timeout: 10_000 }).catch(() => undefined);
    const issue = page.getByRole("button", { name: "Issue the proof" });
    results.check("an app that does not exist is named, and Issue stays off", (await page.getByText("Some apps can't receive the proof").count()) > 0 && (await issue.isDisabled()), (await page.getByRole("tabpanel").innerText()).replace(/\s+/g, " ").slice(0, 200));
    await page.getByRole("button", { name: `Remove no-such-app-${t}` }).first().click();

    // remind and waveform, a scope, five minutes.
    for (const app of ["remind", "waveform"]) {
      await audiences.fill(app);
      await audiences.press("Enter");
    }
    const scopes = page.getByRole("textbox", { name: "Scopes (optional)" });
    await scopes.fill(`notify.send.${t}`);
    await scopes.press("Enter");
    await page.getByRole("button", { name: "5 minutes", exact: true }).click();
    await sleep(300);
    const issued = Date.now();
    await issue.click();
    const reveal = page.getByRole("group", { name: "Your proof" });
    await reveal.waitFor({ timeout: 15_000 });
    results.metric("ATA issue (click → revealed)", Date.now() - issued);
    const maskedValues = await reveal.locator("code").allInnerTexts();
    results.check("both tokens arrive masked (sap_•••, sapr_•••) and the reveal takes focus", maskedValues.length >= 2 && /^sap_•+$/.test(maskedValues[0] ?? "") && /^sapr_•+$/.test(maskedValues[1] ?? "") && (await reveal.evaluate(el => el === document.activeElement)), maskedValues.join(" "));
    await reveal.getByRole("button", { name: "Show the proof token" }).click();
    await reveal.getByRole("button", { name: "Show the proof refresh token" }).click();
    const shown = await reveal.locator("code[data-shown]").allInnerTexts();
    const token = (shown[0] ?? "").trim();
    const refresh = (shown[1] ?? "").trim();
    results.check("Show reveals the proof token and its refresh token", /^sap_\S{20,}$/.test(token) && /^sapr_\S{20,}$/.test(refresh), `${token.slice(0, 8)}… ${refresh.slice(0, 9)}…`);
    const snippets = (await reveal.innerText()).replace(/\s+/g, " ");
    results.check("the verify and refresh commands use $PROOF_TOKEN / $PROOF_REFRESH_TOKEN, never the tokens themselves", /\$PROOF_TOKEN/.test(snippets) && /\$PROOF_REFRESH_TOKEN/.test(snippets) && (snippets.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length ?? 0) === 1);
    await shot(env, page, "dvb-k-01-revealed");

    // What the token proves: valid for remind and waveform only.
    const forRemind = await verify("remind", token);
    const forWaveform = await verify("waveform", token);
    const forBriefcase = await verify("briefcase", token);
    const forIssuer = await verify(APP, token);
    const expires = Date.parse(forRemind.body.expires_at ?? "");
    results.check("remind verifies it: valid ATA from commit to remind, with the scope, about five minutes left", forRemind.status === 200 && forRemind.body.valid === true && forRemind.body.kind === "ata" && forRemind.body.issuing_app?.app_id === APP && forRemind.body.receiving_app?.app_id === "remind" && (forRemind.body.scopes ?? []).includes(`notify.send.${t}`) && expires - Date.now() > 240_000 && expires - Date.now() <= 300_000, JSON.stringify(forRemind.body).slice(0, 240));
    results.check("waveform verifies it too", forWaveform.body.valid === true && forWaveform.body.receiving_app?.app_id === "waveform");
    results.check("an app outside the audience (briefcase), and the issuer itself, get exactly {valid:false, expires_at:null}", invalid(forBriefcase.body) && invalid(forIssuer.body), `${JSON.stringify(forBriefcase.body)} ${JSON.stringify(forIssuer.body)}`);

    // Stored once: after "I've stored them" the tokens are nowhere to be read again.
    await reveal.getByRole("button", { name: "I've stored them" }).click();
    await reveal.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    results.check("after \"I've stored them\" neither token is in the page or in browser storage", !(await page.content()).includes(token) && !(await page.content()).includes(refresh) && !storage.includes(token) && !storage.includes(refresh));
    await page.reload();
    await page.getByRole("textbox", { name: "Apps that may verify it" }).waitFor({ timeout: 20_000 });
    const row = page.locator("li").filter({ hasText: `notify.send.${t}` }).first();
    await row.waitFor({ timeout: 15_000 });
    results.check("after a reload the proof is listed (Active, both audiences) and its tokens are not", /Active/.test(await row.innerText()) && /remind/i.test(await row.innerText()) && /waveform/i.test(await row.innerText()) && !(await page.content()).includes(token), (await row.innerText()).replace(/\s+/g, " ").slice(0, 200));
    const list = await asSession<{ items: Array<{ proof_id: string; scopes: string[] }> }>(page, env, "GET", `/v1/apps/${APP}/proofs?kind=ata&limit=200`);
    const mine = list.body.items.find(item => item.scopes.includes(`notify.send.${t}`));
    results.check("the API's proof list has exactly one new ATA proof, and no token in it", list.body.items.length === before + 1 && !!mine && !JSON.stringify(list.body).includes(token) && !JSON.stringify(list.body).includes(refresh), `${before} → ${list.body.items.length}`);

    // The refresh token works once (rotates); a second use is reuse and ends the proof.
    const rotated = await json<{ proof_token?: string; proof_refresh_token?: string }>(`${env.site}/v1/proofs/refresh`, { method: "POST", headers: { authorization: appBasic(APP), "content-type": "application/json" }, body: JSON.stringify({ proof_refresh_token: refresh }) });
    const fresh = rotated.body.proof_token ?? "";
    const freshValid = (await verify("remind", fresh)).body.valid;
    results.check("the issuer's refresh gives a new proof token (and a new refresh token) that verifies", rotated.status === 200 && fresh.startsWith("sap_") && fresh !== token && (rotated.body.proof_refresh_token ?? "") !== refresh && freshValid === true, `${rotated.status} ${freshValid}`);

    // The owner revokes it in the tab: every token of it stops verifying at once.
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
    await page.getByText(/revoked just now/).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    const afterRevoke = await verify("remind", fresh);
    const reuse = await json<{ error?: string }>(`${env.site}/v1/proofs/refresh`, { method: "POST", headers: { authorization: appBasic(APP), "content-type": "application/json" }, body: JSON.stringify({ proof_refresh_token: rotated.body.proof_refresh_token ?? "" }) });
    results.check("after the owner's revoke the proof says Revoked, its token is invalid and its refresh token refused", (await page.getByText(/revoked just now/).count()) > 0 && invalid(afterRevoke.body) && reuse.status >= 400, `${JSON.stringify(afterRevoke.body)} refresh ${reuse.status}`);
    await shot(env, page, "dvb-k-02-revoked");
    await owner.context.close();
  },
};
