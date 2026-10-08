/**
 * /proofs: the User verification proofs apps hold about the Carbon (issuing app → receiving app, scopes, the current token's time),
 * revoking one on the page (the receiving app's next verify fails at once, the others stay valid), an expired one
 * (time travel), and the ones that end with an app's access. App verification proofs are about apps, never listed here.
 */
import type { Journey } from "../../context";
import { api, postJson, shot, sleep, sql } from "../../lib";
import { appAuth, call, codeOf, confirmMorph, newCarbon, requestSent, signIntoApp, until } from "./_helpers";

interface Issued {
  status?: number;
  body?: { proof_id?: string; proof_token?: string; proof_refresh_token?: string; expires_at?: string; user?: { uuid?: string; membership_id?: string } };
}

interface Verification {
  valid?: boolean;
  expires_at?: string | null;
  issuing_app?: { app_id?: string };
  receiving_app?: { app_id?: string };
  user?: { uuid?: string } | null;
  scopes?: string[];
}

interface MyProof {
  proof_id: string;
  status: string;
  revoke_reason: string | null;
  scopes: string[];
  issuing_app: { app_id: string };
  receiving_app: { app_id: string };
}

const proofs: Journey = {
  name: "account-site-proofs",
  title: "User verification proofs on /proofs: Briefcase acting at Commit and DM, listed with scopes and token time; one revoked on the page (Commit's verify fails at once, the rest stay valid), one expired (time travel), one ended with Briefcase's access; App verification proofs never listed",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await newCarbon(ctx, "acct-proofs");
    const { page, probe, uuid } = carbon;
    const signed = await signIntoApp(env, page, "briefcase");
    results.check("setup: signed into Briefcase", signed?.uuid === uuid);

    const issue = async (receiving: string, scopes: string[], ttl?: number) => (await postJson<Issued>(`${env.apps}/briefcase/actions/issue-user_verification`, { uuid, receiving_app: receiving, scopes, ...(ttl ? { access_ttl_seconds: ttl } : {}) })).body;
    const verify = async (app: string, token: string) => (await postJson<{ verification?: Verification }>(`${env.apps}/${app}/api/verify-proof`, { proof_token: token })).body.verification ?? {};
    const read = await issue("commit", ["files.read"], 600);
    const write = await issue("commit", ["files.write"]);
    const message = await issue("dm", ["messages.send"]);
    const ids = { read: read.body?.proof_id ?? "", write: write.body?.proof_id ?? "", message: message.body?.proof_id ?? "" };
    const tokens = { read: read.body?.proof_token ?? "", write: write.body?.proof_token ?? "", message: message.body?.proof_token ?? "" };
    results.check("Briefcase got three User verification proofs for this Carbon (two for Commit, one for DM)", read.status === 201 && write.status === 201 && message.status === 201 && read.body?.user?.uuid === uuid, JSON.stringify(read).slice(0, 200));
    // An app verification proof is for exactly one app (06-v2 §7): Commit's for Remind.
    const app_verification = (await postJson<Issued>(`${env.apps}/commit/actions/issue-app_verification`, { receiving_app: "remind" })).body;
    results.check("setup: Commit also holds an app verification proof for Remind (app to app, no Carbon in it)", app_verification.status === 201 && !!app_verification.body?.proof_token, JSON.stringify(app_verification).slice(0, 160));

    const v1 = await verify("commit", tokens.read);
    results.check("Commit verifies the read proof: valid, Briefcase → Commit, for this Carbon, its scopes", v1.valid === true && v1.issuing_app?.app_id === "briefcase" && v1.receiving_app?.app_id === "commit" && v1.user?.uuid === uuid && JSON.stringify(v1.scopes) === '["files.read"]', JSON.stringify(v1).slice(0, 240));
    const notAudience = await verify("dm", tokens.read);
    results.check("DM is not its audience: exactly {valid:false, expires_at:null}", notAudience.valid === false && notAudience.expires_at === null && Object.keys(notAudience).length === 2, JSON.stringify(notAudience));

    // The page lists the three User verification proofs, nothing about the App verification one.
    const mine = async () => (await call<{ items: MyProof[] }>(probe, "/v1/me/proofs?limit=200")).body.items;
    const listed = await mine();
    results.check("/v1/me/proofs lists exactly the three User verification proofs (no App verification)", listed.length === 3 && [ids.read, ids.write, ids.message].every(id => listed.some(item => item.proof_id === id)), listed.map(item => `${item.issuing_app.app_id}→${item.receiving_app.app_id}`).join(", "));
    const started = Date.now();
    await page.goto(`${env.site}/proofs`);
    const active = page.getByRole("list", { name: "Active verifications" });
    await active.waitFor({ timeout: 30_000 });
    results.metric("/proofs list visible after navigation", Date.now() - started);
    await sleep(1200);
    await shot(env, page, "acct-proofs-01-active", true);
    results.check("the switch counts 3 active, 0 ended", (await page.getByRole("button", { name: "Active (3)" }).getAttribute("aria-pressed")) === "true" && (await page.getByRole("button", { name: "Ended (0)" }).count()) === 1);
    const toCommit = page.getByRole("article", { name: "Briefcase acts at Commit for you" });
    const toDm = page.getByRole("article", { name: "Briefcase acts at DM for you" });
    results.check("each proof is drawn issuing → receiving app", (await toCommit.count()) === 2 && (await toDm.count()) === 1, `${await toCommit.count()} to Commit, ${await toDm.count()} to DM`);
    const readCard = toCommit.filter({ hasText: "files.read" });
    const readText = (await readCard.innerText()).replace(/\s+/g, " ");
    results.check("the read proof's card: its scope, Active, and its 10-minute token counting down", readText.includes("files.read") && /Active/.test(readText) && /Current token checks out for (9|10) minutes more/.test(readText), readText.slice(0, 260));

    // Revoke the read proof on the page: Commit's next verify fails, the write proof stays valid.
    const revokeSent = requestSent(page, "DELETE", `/v1/me/proofs/${ids.read}`);
    await confirmMorph(readCard, "Revoke", "Revoke");
    const afterRevoke = await until(async () => verify("commit", tokens.read), value => value.valid === false, 10_000);
    results.metric("revoke DELETE sent → Commit's verify answers not valid", Date.now() - (await revokeSent));
    results.check("Commit's verify of the revoked proof: exactly {valid:false, expires_at:null}", afterRevoke.valid === false && afterRevoke.expires_at === null && Object.keys(afterRevoke).length === 2, JSON.stringify(afterRevoke));
    results.check("the write proof is still valid", (await verify("commit", tokens.write)).valid === true);
    const revoked = (await mine()).find(item => item.proof_id === ids.read);
    results.check("the proof is revoked by the account", revoked?.status === "revoked" && revoked.revoke_reason === "revoked_by_account", JSON.stringify(revoked && { status: revoked.status, reason: revoked.revoke_reason }));
    // Proofs follow the sign-in token logic: Briefcase holds each proof's refresh token. The revoked one's no longer
    // gets a new proof token; the write proof's still does, and the new token verifies.
    const refreshProof = (token: string) => api<{ proof_token?: string; error?: { code?: string } }>(ctx, "/v1/proofs/refresh", { method: "POST", json: { proof_refresh_token: token }, headers: { authorization: appAuth("briefcase") } });
    const deadRefresh = await refreshProof(read.body?.proof_refresh_token ?? "");
    const liveRefresh = await refreshProof(write.body?.proof_refresh_token ?? "");
    const fresh = liveRefresh.body.proof_token ? await verify("commit", liveRefresh.body.proof_token) : {};
    results.check("Briefcase can no longer refresh the revoked proof; the write proof refreshes, and its new token verifies", deadRefresh.status >= 400 && deadRefresh.status < 500 && !!codeOf(deadRefresh.body) && liveRefresh.status === 200 && fresh.valid === true, `revoked: ${deadRefresh.status} ${codeOf(deadRefresh.body)}; write: ${liveRefresh.status} → valid ${String(fresh.valid)}`);
    await until(async () => page.getByRole("button", { name: "Ended (1)" }).count(), n => n === 1, 8_000);
    await page.getByRole("button", { name: "Ended (1)" }).click();
    const ended = page.getByRole("list", { name: "Ended verifications" });
    await ended.waitFor({ timeout: 10_000 });
    await sleep(800);
    const endedText = (await ended.innerText()).replace(/\s+/g, " ");
    results.check("Ended: the read proof, \"You revoked it\", Revoked, no Revoke button", endedText.includes("files.read") && endedText.includes("You revoked it") && /Revoked/.test(endedText) && (await ended.getByRole("button", { name: "Revoke", exact: true }).count()) === 0, endedText.slice(0, 240));
    await shot(env, page, "acct-proofs-02-ended", true);

    // The write proof runs out (time travel): it moves to Ended as Expired and stops verifying.
    await sql(env, `update proof_families set expires_at = now() - interval '1 second' where id = '${ids.write}'`);
    results.check("an expired proof no longer verifies", (await verify("commit", tokens.write)).valid === false);
    await page.reload();
    await page.getByRole("button", { name: /^Ended \(\d+\)$/ }).waitFor({ timeout: 30_000 });
    results.check("after expiry: 1 active (DM), 2 ended", (await page.getByRole("button", { name: "Active (1)" }).count()) === 1 && (await page.getByRole("button", { name: "Ended (2)" }).count()) === 1);
    await page.getByRole("button", { name: "Ended (2)" }).click();
    const expiredCard = page.getByRole("list", { name: "Ended verifications" }).getByRole("article").filter({ hasText: "files.write" });
    await expiredCard.waitFor({ timeout: 10_000 });
    const expiredText = (await expiredCard.innerText()).replace(/\s+/g, " ");
    results.check("the expired proof says Expired", /Expired/.test(expiredText), expiredText.slice(0, 200));
    results.check("/v1/me/proofs says expired", (await mine()).find(item => item.proof_id === ids.write)?.status === "expired");

    // The DM proof ends with Briefcase's access.
    results.check("before the removal DM verifies its proof", (await verify("dm", tokens.message)).valid === true);
    const removed = await call(probe, "/v1/me/apps/briefcase", { method: "DELETE" });
    const cascaded = await verify("dm", tokens.message);
    results.check("removing Briefcase's access ends the proofs it holds: DM's verify fails", removed.status === 204 && cascaded.valid === false && cascaded.expires_at === null, `${removed.status} ${JSON.stringify(cascaded)}`);
    const third = (await mine()).find(item => item.proof_id === ids.message);
    results.check("…and the proof says why (access_removed)", third?.status === "revoked" && third.revoke_reason === "access_removed", JSON.stringify(third && { status: third.status, reason: third.revoke_reason }));
    await page.reload();
    await page.getByRole("button", { name: "Ended (3)" }).click({ timeout: 30_000 });
    const dmCard = page.getByRole("list", { name: "Ended verifications" }).getByRole("article", { name: "Briefcase acts at DM for you" });
    await dmCard.waitFor({ timeout: 10_000 });
    const dmText = (await dmCard.innerText()).replace(/\s+/g, " ");
    results.check("the page says it ended when Briefcase's access was removed", dmText.includes("Ended when Briefcase's access was removed"), dmText.slice(0, 200));
    await page.getByRole("button", { name: "Active (0)" }).click();
    await sleep(500);
    results.check("no active proof left: the empty state says so", (await page.locator("main").innerText()).includes("No app is acting for you"));

    // The API: a proof that is not this account's (or does not exist) can't be revoked.
    const missing = await call(probe, "/v1/me/proofs/01890000-0000-7000-8000-000000000000", { method: "DELETE" });
    results.check("revoking a proof that is not this account's: 404", missing.status === 404, `${missing.status} ${codeOf(missing.body)}`);

    const titles = (await call<{ items: Array<{ title: string; detail: string | null }> }>(probe, "/v1/me/history?kind=proof&limit=50")).body.items.map(item => `${item.title} — ${item.detail ?? ""}`);
    results.check("history: each proof issued", titles.filter(text => text.startsWith("Briefcase got a proof to act for you at Commit")).length === 2 && titles.some(text => text.startsWith("Briefcase got a proof to act for you at DM")), titles.join(" | ").slice(0, 400));
    results.check("history: the revocation by the Carbon", titles.some(text => text.startsWith("Proof for Briefcase to act for you at Commit revoked") && /Revoked by you/.test(text)), titles.join(" | ").slice(0, 400));
    await carbon.context.close();
  },
};

export const journey = proofs;
