import type { Journey } from "../context";
import { DEVELOPER_SIGNED_OUT, developerApi, fakeApp, hostedTitle, newContext, shot, signInOnDeveloper, sleep, startAtApp, tag, verifyProof } from "../lib";

interface AppProof {
  proof_id: string;
  kind: string;
  status: string;
  receiving_app?: string | { app_id?: string } | null;
}

const appIdOf = (value: unknown) => (typeof value === "string" ? value : value && typeof value === "object" ? (value as { app_id?: string }).app_id : undefined);

export const journey: Journey = {
  name: "j-developer",
  title: "the developer site as an app's owner: signed in through its BFF, the apps they own, a sign-in title saved on the Pages tab and shown by the hosted page at once, an ATA proof made for exactly one app on the ATA tab (verified by it, refused to another, revoked there), signing out of the developer site only",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "j", [DEVELOPER_SIGNED_OUT]);
    const owner = fakeApp("commit").owner_email;
    const t = tag();

    // Signing in: the developer site's own sign-in card, then the account site's hosted pages, then back.
    await signInOnDeveloper(env, page, owner);
    results.check("signed in, the developer site opens on the apps the Carbon owns", page.url() === `${env.developer}/`, page.url());
    const list = page.getByRole("list", { name: "Your apps" });
    await list.waitFor({ timeout: 30_000 });
    await sleep(600);
    await shot(env, page, "j-01-apps");
    const owned = await list.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href") ?? ""));
    results.check("…briefcase, commit, remind and spacestation (saket's), and no app of another Carbon", ["briefcase", "commit", "remind", "spacestation"].every(app => owned.includes(`/apps/${app}`)) && !owned.includes("/apps/dm"), owned.join(" "));

    // The Pages tab: a new sign-in title, saved, is what the hosted page shows next.
    const title = `Space Station ${t}`;
    await page.goto(`${env.developer}/apps/spacestation/pages`);
    const field = page.getByRole("textbox", { name: "Sign-in title", exact: true });
    await field.waitFor({ timeout: 30_000 });
    const before = await field.inputValue();
    await field.fill(title);
    const save = page.getByRole("button", { name: "Save changes" });
    await save.click({ timeout: 10_000 });
    await save.waitFor({ state: "detached", timeout: 20_000 });
    await shot(env, page, "j-02-pages-saved");
    const stored = await developerApi<{ signin_config?: { copy?: { title?: string } }; config_version?: number }>(env, page, "/apps/spacestation");
    results.check("Save changes stores the new title (read back through the BFF)", stored.body.signin_config?.copy?.title === title, `${stored.status} version ${stored.body.config_version}: ${JSON.stringify(stored.body.signin_config?.copy ?? stored.body).slice(0, 200)}`);
    const hosted = await context.newPage();
    results.watch(hosted, "j-hosted");
    await startAtApp(env, hosted, "spacestation");
    results.check("the hosted sign-in page shows the saved title at once", (await hostedTitle(hosted)) === title, await hostedTitle(hosted));
    await hosted.close();
    // Put the seeded title back (suites walking this stack after core expect it).
    await field.fill(before);
    await save.click({ timeout: 10_000 });
    await save.waitFor({ state: "detached", timeout: 20_000 });

    // The ATA tab: a proof from commit for remind alone.
    await page.goto(`${env.developer}/apps/commit/ata`);
    const receiver = page.getByRole("textbox", { name: "The app that receives it" });
    await receiver.waitFor({ timeout: 30_000 });
    await receiver.fill("remind");
    await page.getByRole("button", { name: "Choose", exact: true }).click();
    const make = page.getByRole("button", { name: "Create token" });
    await make.click({ timeout: 15_000 });
    const reveal = page.getByRole("group", { name: "Your verification tokens" });
    await reveal.waitFor({ timeout: 20_000 });
    await reveal.getByRole("button", { name: "Show the verification token" }).click();
    const token = (await reveal.locator("code[data-shown]").first().innerText()).trim();
    await sleep(400);
    await shot(env, page, "j-03-ata-proof");
    results.check("Make the proof shows the proof token once", /^sap_/.test(token), token.slice(0, 12));
    const verified = await verifyProof(ctx, "remind", token);
    results.check("remind verifies it: issued by commit, for remind", verified.body.valid === true && appIdOf(verified.body.issuing_app) === "commit" && appIdOf(verified.body.receiving_app) === "remind", JSON.stringify(verified.body).slice(0, 200));
    const other = await verifyProof(ctx, "waveform", token);
    results.check("waveform is told {valid:false, expires_at:null}: the proof is for remind alone", other.body.valid === false && other.body.expires_at === null, JSON.stringify(other.body));
    await reveal.getByRole("button", { name: "I've stored them" }).click();
    const proofs = async () => (await developerApi<{ items?: AppProof[] }>(env, page, "/apps/commit/proofs?kind=ata&limit=50")).body.items ?? [];
    const newest = (await proofs())[0];
    results.check("the proof is listed with its one receiving app", newest?.kind === "ata" && appIdOf(newest.receiving_app) === "remind" && newest.status === "active", JSON.stringify(newest).slice(0, 200));
    await page.getByRole("button", { name: "Revoke", exact: true }).first().click({ timeout: 15_000 });
    await page.getByRole("button", { name: "Revoke", exact: true }).first().click({ timeout: 10_000 });
    await sleep(1500);
    const revoked = (await proofs()).find(proof => proof.proof_id === newest?.proof_id);
    results.check("Revoke on the ATA tab revokes it", revoked?.status === "revoked", String(revoked?.status));
    const after = await verifyProof(ctx, "remind", token);
    results.check("…and remind's verify then answers {valid:false, expires_at:null}", after.body.valid === false && after.body.expires_at === null, JSON.stringify(after.body));

    // Signing out of the developer site leaves the account site's own sign-in alone.
    await page.getByRole("button", { name: /^Account menu/ }).click();
    await page.getByRole("menuitem", { name: /Sign out/ }).click();
    await page.waitForURL(url => url.href.startsWith(`${env.developer}/sign-in`), { timeout: 20_000 });
    await shot(env, page, "j-04-signed-out");
    results.check("signed out of the developer site: its BFF answers 401", (await developerApi(env, page, "/me")).status === 401);
    results.check("…while the account site's own sign-in stays", (await page.request.get(`${env.site}/v1/session`)).status() === 200);
    await context.close();
  },
};
