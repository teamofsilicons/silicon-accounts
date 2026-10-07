/**
 * The ATA creator (commit's Proofs tab, its owner signs in), held to UNDERSTANDING.md as the Carbons edited it on
 * 2026-10-07: "An ATA proof is always for exactly one app; a proof can't be made for several apps at once. If App A
 * wants to talk to App B and App C, it makes one proof for App B and another one for App C, and each of them verifies
 * its own proof with us."
 *
 * Audiences are checked as they are typed (not an app id, the issuing app itself, an app that does not exist); the
 * creator never takes a second app for one proof, and the API refuses a proof that names two (the owner's session and
 * the app's own credentials). A proof for remind is issued once and its tokens are revealed exactly once (masked until
 * shown, gone after "I've stored them": not in the page, a reload, the API's proof list, or browser storage); remind
 * verifies it and no other app does; a second proof, for waveform, verifies for waveform only; the refresh token
 * rotates once, and the owner's revoke ends a proof at once.
 */
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
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

interface Issued {
  proof_id?: string;
  proof_token?: string;
  proof_refresh_token?: string;
  error?: { code?: string; message?: string; details?: { fields?: Record<string, string> } };
}

interface Listed {
  proof_id: string;
  scopes: string[];
  audiences: string[];
  status: string;
}

/** Exactly {valid: false, expires_at: null}, nothing more (in any key order). */
const invalid = (body: Verification) => body.valid === false && body.expires_at === null && Object.keys(body).length === 2;

/** The apps the creator's draft names now: the tags of its "Apps that may verify it" field. */
async function draftApps(field: Locator): Promise<string[]> {
  await sleep(450); // a removed tag animates out
  return field.locator("xpath=..").locator("[data-tag]").evaluateAll(tags => tags.map(tag => tag.getAttribute("data-tag") ?? ""));
}

/** Leaves exactly `app` in the draft, whatever the creator did with the apps typed before. */
async function draftOnly(page: Page, field: Locator, app: string): Promise<void> {
  for (const other of (await draftApps(field)).filter(id => id !== app)) await page.getByRole("button", { name: `Remove ${other}`, exact: true }).first().click();
  if (!(await draftApps(field)).includes(app)) {
    await field.fill(app);
    await field.press("Enter");
  }
}

/** Every ATA proof commit issued (newest first). */
async function ataProofs(page: Page, ctx: Ctx): Promise<Listed[]> {
  return (await asSession<{ items: Listed[] }>(page, ctx.env, "GET", `/v1/apps/${APP}/proofs?kind=ata&limit=200`)).body.items ?? [];
}

export const journey: Journey = {
  name: "developer-branding-ata",
  title: "ATA creator: audience refusals as typed, exactly one app per proof (creator and API refuse a second), a proof for remind revealed once (masked, then gone from page, reload, API and storage) that only remind verifies, another for waveform that only waveform verifies, refresh rotates once, revoke ends it",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const verify = (app: string, token: string) => json<Verification>(`${env.site}/v1/proofs/verify`, { method: "POST", headers: { authorization: appBasic(app), "content-type": "application/json" }, body: JSON.stringify({ proof_token: token }) });
    // Looking up the app that does not exist answers 404 (the browser logs it).
    const owner = await ownerSignIn(ctx, APP, "dvb-k-owner", { expected: [/status of 404/] });
    const { page } = owner;
    const before = (await ataProofs(page, ctx)).length;
    await page.goto(`${env.site}/developer/${APP}/proofs`);
    const audiences = page.getByRole("textbox", { name: "Apps that may verify it" });
    await audiences.waitFor({ timeout: 20_000 });
    const lastProblem = () => page.locator("ul[aria-live='polite'] li").first().innerText().catch(() => "");
    const issue = page.getByRole("button", { name: "Issue the proof" });

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
    results.check("an app that does not exist is named, and Issue stays off", (await page.getByText("Some apps can't receive the proof").count()) > 0 && (await issue.isDisabled()), (await page.getByRole("tabpanel").innerText()).replace(/\s+/g, " ").slice(0, 200));
    await page.getByRole("button", { name: `Remove no-such-app-${t}` }).first().click();

    // One app per proof: with remind in the draft, waveform does not join it.
    await audiences.fill("remind");
    await audiences.press("Enter");
    await audiences.fill("waveform");
    await audiences.press("Enter");
    const both = await draftApps(audiences);
    const summary = ((await page.getByText(/^For .+ valid /).first().textContent().catch(() => "")) ?? "").trim();
    results.check("the creator takes exactly one app per proof: with remind chosen, adding waveform does not make a proof for both (UNDERSTANDING.md: \"An ATA proof is always for exactly one app\")", both.length === 1, `the draft names ${both.join(", ") || "nothing"}${summary ? `; it says "${summary}"` : ""}; the field reads "${await page.getByText(/App ids, up to/).first().textContent().catch(() => "")}"`);
    await shot(env, page, "dvb-k-00-two-apps");
    await draftOnly(page, audiences, "remind");

    // A proof for remind: a scope, five minutes.
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
    results.check("the reveal names remind as the one receiving app", /→ remind\b/.test(await reveal.innerText()) && !/waveform/.test(await reveal.innerText()), (await reveal.innerText()).replace(/\s+/g, " ").slice(0, 120));
    await reveal.getByRole("button", { name: "Show the proof token" }).click();
    await reveal.getByRole("button", { name: "Show the proof refresh token" }).click();
    const shown = await reveal.locator("code[data-shown]").allInnerTexts();
    const token = (shown[0] ?? "").trim();
    const refresh = (shown[1] ?? "").trim();
    results.check("Show reveals the proof token and its refresh token", /^sap_\S{20,}$/.test(token) && /^sapr_\S{20,}$/.test(refresh), `${token.slice(0, 8)}… ${refresh.slice(0, 9)}…`);
    const snippets = (await reveal.innerText()).replace(/\s+/g, " ");
    results.check("the verify and refresh commands use $PROOF_TOKEN / $PROOF_REFRESH_TOKEN, never the tokens themselves", /\$PROOF_TOKEN/.test(snippets) && /\$PROOF_REFRESH_TOKEN/.test(snippets) && (snippets.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length ?? 0) === 1);
    await shot(env, page, "dvb-k-01-revealed");

    // What the token proves: valid for remind, and for no other app.
    const forRemind = await verify("remind", token);
    const forWaveform = await verify("waveform", token);
    const forBriefcase = await verify("briefcase", token);
    const forIssuer = await verify(APP, token);
    const expires = Date.parse(forRemind.body.expires_at ?? "");
    results.check("remind verifies it: valid ATA from commit to remind, with the scope, about five minutes left", forRemind.status === 200 && forRemind.body.valid === true && forRemind.body.kind === "ata" && forRemind.body.issuing_app?.app_id === APP && forRemind.body.receiving_app?.app_id === "remind" && (forRemind.body.scopes ?? []).includes(`notify.send.${t}`) && expires - Date.now() > 240_000 && expires - Date.now() <= 300_000, JSON.stringify(forRemind.body).slice(0, 240));
    results.check("every other app (waveform, briefcase) and the issuer itself get exactly {valid:false, expires_at:null} for remind's proof", invalid(forWaveform.body) && invalid(forBriefcase.body) && invalid(forIssuer.body), `${JSON.stringify(forWaveform.body)} ${JSON.stringify(forBriefcase.body)} ${JSON.stringify(forIssuer.body)}`);

    // Stored once: after "I've stored them" the tokens are nowhere to be read again.
    await reveal.getByRole("button", { name: "I've stored them" }).click();
    await reveal.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    results.check("after \"I've stored them\" neither token is in the page or in browser storage", !(await page.content()).includes(token) && !(await page.content()).includes(refresh) && !storage.includes(token) && !storage.includes(refresh));
    await page.reload();
    await audiences.waitFor({ timeout: 20_000 });
    const row = page.locator("li").filter({ hasText: `notify.send.${t}` }).first();
    await row.waitFor({ timeout: 15_000 });
    const rowText = (await row.innerText()).replace(/\s+/g, " ");
    results.check("after a reload the proof is listed (Active, for remind) and its tokens are not", /Active/.test(rowText) && /remind/i.test(rowText) && !/waveform/i.test(rowText) && !(await page.content()).includes(token), rowText.slice(0, 200));

    // App B and App C get a proof each: the second one, for waveform, verifies for waveform only.
    await draftOnly(page, audiences, "waveform");
    await scopes.fill(`notify.wave.${t}`);
    await scopes.press("Enter");
    await issue.click();
    await reveal.waitFor({ timeout: 15_000 });
    await reveal.getByRole("button", { name: "Show the proof token" }).click();
    const waveToken = ((await reveal.locator("code[data-shown]").first().textContent()) ?? "").trim();
    const waveForWaveform = await verify("waveform", waveToken);
    const waveForRemind = await verify("remind", waveToken);
    results.check("a second proof, for waveform, verifies for waveform and not for remind (one proof per receiving app)", waveForWaveform.body.valid === true && waveForWaveform.body.receiving_app?.app_id === "waveform" && invalid(waveForRemind.body), `${JSON.stringify(waveForWaveform.body).slice(0, 160)} / ${JSON.stringify(waveForRemind.body)}`);
    await reveal.getByRole("button", { name: "I've stored them" }).click();
    await reveal.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);

    // The API holds the same rule: a proof that names two apps is refused, with the owner's session or the app's own
    // credentials, and nothing is issued. (Any that were issued anyway are revoked again below.)
    const twoScope = `dvb.two.${t}`;
    const asOwner = await asSession<Issued>(page, env, "POST", `/v1/apps/${APP}/proofs/ata`, { audiences: ["remind", "waveform"], scopes: [twoScope] });
    const asTheApp = await json<Issued>(`${env.site}/v1/proofs/ata`, { method: "POST", headers: { authorization: appBasic(APP), "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ audiences: ["remind", "waveform"], scopes: [twoScope] }) });
    const wronglyIssued = (await ataProofs(page, ctx)).filter(proof => proof.scopes.includes(twoScope));
    results.check("the API refuses an ATA proof that names two apps (422 with the owner's session and with commit's own credentials) and issues nothing", asOwner.status === 422 && asTheApp.status === 422 && wronglyIssued.length === 0, `owner session ${asOwner.status} ${asOwner.body?.error?.code ?? ""}${asOwner.body?.proof_id ? " (issued)" : ""}; app credentials ${asTheApp.status} ${asTheApp.body?.error?.code ?? ""}${asTheApp.body?.proof_id ? " (issued)" : ""}; ${wronglyIssued.length} proof(s) issued for ${wronglyIssued[0]?.audiences.join(" + ") ?? "-"}`);
    for (const proof of wronglyIssued) await asSession(page, env, "DELETE", `/v1/apps/${APP}/proofs/${proof.proof_id}`);

    // Retrying never issues twice (UNDERSTANDING.md "History": idempotency keys "so retrying something never does it
    // twice"): the same Idempotency-Key within its replay window (10 minutes for an answer holding secrets) answers the
    // same proof, marked Idempotent-Replayed, and issues no second one; the same key with another body is refused.
    const idemScope = `dvb.idem.${t}`;
    const key = randomUUID();
    const issueWith = (scope: string) => page.request.fetch(`${env.site}/v1/apps/${APP}/proofs/ata`, { method: "POST", headers: { origin: env.site, "content-type": "application/json", "idempotency-key": key }, data: JSON.stringify({ audiences: ["remind"], scopes: [scope] }), failOnStatusCode: false });
    const firstIssue = await issueWith(idemScope);
    const retried = await issueWith(idemScope);
    const otherBody = await issueWith(`${idemScope}.other`);
    const [firstAnswer, retriedAnswer, otherAnswer] = await Promise.all([firstIssue, retried, otherBody].map(answer => answer.json().catch(() => null) as Promise<Issued | null>));
    const idemIssued = (await ataProofs(page, ctx)).filter(proof => proof.scopes.some(scope => scope.startsWith(idemScope)));
    results.check("a retried ATA issue with the same Idempotency-Key answers the same proof (Idempotent-Replayed) and issues no second one; the key with another body is refused (409 idempotency_key_reused)", firstIssue.status() === 201 && retried.status() === 201 && retried.headers()["idempotent-replayed"] === "true" && !!firstAnswer?.proof_id && retriedAnswer?.proof_id === firstAnswer.proof_id && idemIssued.length === 1 && otherBody.status() === 409 && otherAnswer?.error?.code === "idempotency_key_reused", `${firstIssue.status()} ${firstAnswer?.proof_id?.slice(0, 8)} / ${retried.status()} replayed=${retried.headers()["idempotent-replayed"]} ${retriedAnswer?.proof_id?.slice(0, 8)} / ${otherBody.status()} ${otherAnswer?.error?.code}; ${idemIssued.length} issued`);
    for (const proof of idemIssued) await asSession(page, env, "DELETE", `/v1/apps/${APP}/proofs/${proof.proof_id}`);

    // The proof list: exactly the two new single-app proofs (and the ones issued through the API above), no token in it.
    const list = await ataProofs(page, ctx);
    const remindProof = list.find(item => item.scopes.includes(`notify.send.${t}`));
    const waveProof = list.find(item => item.scopes.includes(`notify.wave.${t}`));
    results.check("the API's proof list has the two new proofs, one app each, and no token in it", list.length === before + 2 + wronglyIssued.length + idemIssued.length && JSON.stringify(remindProof?.audiences) === JSON.stringify(["remind"]) && JSON.stringify(waveProof?.audiences) === JSON.stringify(["waveform"]) && ![token, refresh, waveToken].some(secret => JSON.stringify(list).includes(secret)), `${before} → ${list.length} (${wronglyIssued.length} two-app and ${idemIssued.length} idempotency proofs, revoked); remind's for ${remindProof?.audiences.join(",")}, waveform's for ${waveProof?.audiences.join(",")}`);

    // The refresh token works once (rotates); a second use is reuse and ends the proof.
    const rotated = await json<{ proof_token?: string; proof_refresh_token?: string }>(`${env.site}/v1/proofs/refresh`, { method: "POST", headers: { authorization: appBasic(APP), "content-type": "application/json" }, body: JSON.stringify({ proof_refresh_token: refresh }) });
    const freshToken = rotated.body.proof_token ?? "";
    const freshValid = (await verify("remind", freshToken)).body.valid;
    results.check("the issuer's refresh gives a new proof token (and a new refresh token) that verifies", rotated.status === 200 && freshToken.startsWith("sap_") && freshToken !== token && (rotated.body.proof_refresh_token ?? "") !== refresh && freshValid === true, `${rotated.status} ${freshValid}`);

    // The owner revokes remind's proof in the tab: every token of it stops verifying at once; waveform's stays.
    await page.reload();
    const remindRow = page.locator("li").filter({ hasText: `notify.send.${t}` }).first();
    await remindRow.waitFor({ timeout: 15_000 });
    await remindRow.getByRole("button", { name: "Revoke", exact: true }).click();
    // The trigger morphs into "Revoke this proof?" with Cancel and Revoke (the trigger's face leaves first).
    await sleep(450);
    await remindRow.getByRole("button", { name: "Revoke", exact: true }).last().click();
    await remindRow.getByText(/revoked just now/i).waitFor({ timeout: 10_000 }).catch(() => undefined);
    const afterRevoke = await verify("remind", freshToken);
    const reuse = await json<{ error?: string }>(`${env.site}/v1/proofs/refresh`, { method: "POST", headers: { authorization: appBasic(APP), "content-type": "application/json" }, body: JSON.stringify({ proof_refresh_token: rotated.body.proof_refresh_token ?? "" }) });
    const waveStill = (await verify("waveform", waveToken)).body.valid;
    results.check("after the owner's revoke remind's proof says Revoked, its token is invalid and its refresh token refused; waveform's proof still verifies", (await remindRow.getByText(/revoked just now/i).count()) > 0 && invalid(afterRevoke.body) && reuse.status >= 400 && waveStill === true, `${JSON.stringify(afterRevoke.body)} refresh ${reuse.status}, waveform's ${waveStill}`);
    await shot(env, page, "dvb-k-02-revoked");

    // Nothing of this run stays active.
    if (waveProof) await asSession(page, env, "DELETE", `/v1/apps/${APP}/proofs/${waveProof.proof_id}`);
    await owner.context.close();
  },
};
