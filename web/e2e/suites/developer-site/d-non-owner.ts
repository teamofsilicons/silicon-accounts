/**
 * Nobody sees or changes an app they don't own. A fresh Carbon (who owns nothing) signs in to the developer site: the
 * apps page says so and explains where apps come from; every page of someone else's app says "You don't own …" and
 * shows none of it; every owner route answers 403 not_app_owner through the BFF without a byte of the app's setup, and
 * every write is refused with nothing stored. An owner of one app is just as much a stranger to another.
 */
import type { Journey } from "../../context";
import { developerApi, sleep, shot } from "../../lib";
import { appDetail, asApp, errorCode, freshSignIn, ownerSignIn } from "./_helpers";

const TABS = ["", "/sign-in", "/details", "/flows", "/pages", "/users", "/import", "/webhooks", "/ata", "/embed"];
/** The browser logs the 403/404 answers these pages are built on as failed resources. */
const EXPECTED = [/status of 403 \(Forbidden\)/, /status of 404 \(Not Found\)/];

export const journey: Journey = {
  name: "developer-site-non-owner",
  title: "a Carbon who owns no app sees an empty apps page and where apps come from; another Carbon's app shows \"You don't own …\" on every tab, its owner routes answer 403 with nothing of the app, and every write is refused with nothing stored; an owner of one app is a stranger to the others",
  async run(ctx) {
    const { env, results } = ctx;
    const target = "briefcase";
    const before = await appDetail(ctx, target);
    const proofsBefore = ((await asApp<{ items?: unknown[] }>(ctx, target, `/v1/apps/${target}/proofs?limit=100`)).body.items ?? []).length;
    const { context, page } = await freshSignIn(ctx, "stranger", { expected: EXPECTED });

    // The apps page of a Carbon who owns nothing.
    await page.getByRole("heading", { name: "No apps yet" }).waitFor({ timeout: 30_000 });
    await sleep(400);
    await shot(env, page, "ds-d-01-no-apps");
    const home = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the apps page says there are no apps yet, and that apps are created in Silicon Apps", /No apps yet/.test(home) && /Apps are created in Silicon Apps/.test(home) && !/Silicon Apps isn't open yet/.test(home), home.slice(0, 240));
    const owned = await developerApi<{ items?: unknown[] }>(env, page, "/me/owned-apps");
    results.check("…GET /me/owned-apps through the BFF is empty", owned.status === 200 && (owned.body.items ?? []).length === 0, `${owned.status} ${(owned.body.items ?? []).length}`);
    await page.getByRole("button", { name: "How apps are made" }).click();
    const dialog = page.getByRole("dialog", { name: "Apps come from Silicon Apps" });
    await dialog.waitFor({ timeout: 10_000 });
    const dialogText = (await dialog.innerText()).replace(/\s+/g, " ");
    await shot(env, page, "ds-d-02-new-app");
    results.check("\"How apps are made\" explains Silicon Apps and that this Carbon owns no stand-in app", /Silicon Apps isn.t open yet/.test(dialogText) && /You don.t own a stand-in app/.test(dialogText), dialogText.slice(0, 300));
    await dialog.getByRole("button", { name: "Done" }).click();

    // Someone else's app, on every tab.
    const leaked: string[] = [];
    for (const tab of TABS) {
      await page.goto(`${env.developer}/apps/${target}${tab}`);
      const refusal = page.getByRole("heading", { name: `You don't own ${target}` });
      const shown = await refusal.waitFor({ timeout: 20_000 }).then(() => true, () => false);
      const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
      const tabs = await page.getByRole("tablist").count();
      if (!shown || tabs > 0 || /Briefcase|Redirect URI|webhook|whsec_|@example\.test/.test(text)) leaked.push(`${tab || "/"}: shown=${shown} tabs=${tabs} ${text.slice(0, 120)}`);
      if (!tab) await shot(env, page, "ds-d-03-not-yours");
    }
    results.check(`every tab of ${target} (${TABS.length}) says "You don't own ${target}" and shows no tabs and nothing of the app`, leaked.length === 0, leaked.join(" | ") || "all refused");
    const notOwnerText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("…in the server's words, with the way back to the Carbon's own apps", /is not the owner of the app 'briefcase'/.test(notOwnerText) && (await page.getByRole("link", { name: "Open your apps" }).count()) === 1, notOwnerText.slice(0, 200));
    await page.goto(`${env.developer}/apps/no-such-app`);
    const missing = await page.getByRole("heading", { name: "No app with the id no-such-app" }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
    results.check("an app that doesn't exist says so (\"No app with the id no-such-app\")", missing, (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 160));
    const unknownTab = await page.goto(`${env.developer}/apps/${target}/bogus`);
    results.check("an address under an app that names no tab is a real 404", unknownTab?.status() === 404, String(unknownTab?.status()));

    // Through the BFF: reads give 403 and nothing of the app.
    const reads = ["", "/users", "/imports", "/webhook/deliveries", "/proofs", "/signin-config/history", `/users/${before.owner?.uuid ?? "x"}`];
    const readProblems: string[] = [];
    for (const path of reads) {
      const answer = await developerApi(env, page, `/apps/${target}${path}`);
      const body = JSON.stringify(answer.body);
      if (answer.status !== 403 || errorCode(answer.body) !== "not_app_owner" || /signin_config|redirect_uris|webhook|"items"|@/.test(body)) readProblems.push(`${path || "/"} → ${answer.status} ${body.slice(0, 80)}`);
    }
    results.check(`the ${reads.length} owner reads of ${target} answer 403 not_app_owner with nothing of the app`, readProblems.length === 0, readProblems.join(" | ") || "all refused");

    // …and writes are refused with nothing stored.
    const writes: Array<[string, string, unknown]> = [
      ["PATCH", "/signin-config", { copy: { title: "Taken over" }, redirect_uris: ["https://evil.example/cb"] }],
      ["PUT", "/webhook", { url: "https://evil.example/hook" }],
      ["POST", "/webhook/rotate-secret", {}],
      ["POST", "/webhook/test", {}],
      ["POST", "/webhook/replay", { status: "failed" }],
      ["DELETE", "/webhook", undefined],
      ["POST", "/proofs/ata", { receiving_app: "remind" }],
      ["POST", "/imports", { rows: [{ email: "planted@example.test" }], options: {} }],
    ];
    const writeProblems: string[] = [];
    for (const [method, path, body] of writes) {
      const answer = await developerApi(env, page, `/apps/${target}${path}`, { method, ...(body === undefined ? {} : { json: body }) });
      if (answer.status !== 403 || errorCode(answer.body) !== "not_app_owner") writeProblems.push(`${method} ${path} → ${answer.status} ${errorCode(answer.body)}`);
    }
    results.check(`the ${writes.length} owner writes (setup, webhook, its secret, test, replay, removal, an ATA proof, an import) answer 403 not_app_owner`, writeProblems.length === 0, writeProblems.join(" | ") || "all refused");
    const after = await appDetail(ctx, target);
    const proofsAfter = ((await asApp<{ items?: unknown[] }>(ctx, target, `/v1/apps/${target}/proofs?limit=100`)).body.items ?? []).length;
    results.check(`…and ${target} is untouched: same setup version, same webhook, no new proof`, after.config_version === before.config_version && after.webhook.url === before.webhook.url && after.webhook.secret_set === before.webhook.secret_set && proofsAfter === proofsBefore, `version ${before.config_version}→${after.config_version}, webhook ${after.webhook.url}, proofs ${proofsBefore}→${proofsAfter}`);
    await context.close();

    // The owner of one app is a stranger to the others.
    const quill = await ownerSignIn(ctx, "quill-docs", { label: "non-owner-quill", expected: EXPECTED });
    const list = quill.page.getByRole("list", { name: "Your apps" });
    await list.waitFor({ timeout: 30_000 });
    const hrefs = await list.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href") ?? ""));
    results.check("quill-dev's apps page lists quill-docs and nothing else", hrefs.length === 1 && hrefs[0] === "/apps/quill-docs", hrefs.join(" "));
    await quill.page.goto(`${env.developer}/apps/pixel-studio/pages`);
    const stranger = await quill.page.getByRole("heading", { name: "You don't own pixel-studio" }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const pixel = await developerApi(env, quill.page, "/apps/pixel-studio");
    results.check("…pixel-studio's Pages tab says \"You don't own pixel-studio\" and its details answer 403", stranger && pixel.status === 403 && errorCode(pixel.body) === "not_app_owner", `${stranger} ${pixel.status}`);
    await quill.context.close();
  },
};
