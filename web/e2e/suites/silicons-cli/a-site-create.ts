import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { forgetRateLimits, shot, sleep, tag } from "../../lib";
import { accounts, asCarbon, carbonContext, freshDir, idAvailable, loginSilicon, obj, said, short, signUpCarbon, str, type Json } from "./_helpers";

/** The secret a reveal card shows (its screen-reader copy holds the plain value once it has decoded). */
async function revealedStk(page: Page): Promise<string> {
  await sleep(1800);
  const texts = await page.locator(".sr-only, [class*=srOnly]").allInnerTexts();
  return texts.map(text => text.trim()).find(text => /^stk-[0-9a-f]+$/.test(text)) ?? "";
}

export const journey: Journey = {
  name: "silicons-cli-site-create",
  title: "a Carbon creates a Silicon on the site: the generated STK is shown exactly once and signs the Silicon in; it is the custodian; the site refuses chosen STKs of 7 and 33 hex digits and accepts 32",
  async run(ctx) {
    const { env, results, browser } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "site");
    const context = await carbonContext(browser, carbon);
    const page = await context.newPage();
    results.watch(page, "scli-site");
    const sid = `si:site-${t}`;
    const stored = page.getByRole("button", { name: "I've stored it" }).first();

    // 1. Create it in the drawer: the generated STK comes back once.
    await page.goto(`${env.site}/silicons`);
    await page.getByRole("button", { name: "Create a Silicon" }).first().click({ timeout: 30_000 });
    let drawer = page.getByRole("dialog", { name: "Create a Silicon" });
    await drawer.getByRole("textbox", { name: "Display name" }).fill(`Site ${t}`);
    await drawer.getByRole("textbox", { name: "Id" }).fill(`site-${t}`);
    // The form refuses to submit while the id is still being checked ("Still checking the id; try again in a moment").
    await drawer.getByText(`${sid} is available.`).waitFor({ timeout: 30_000 });
    const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/me/silicons", { timeout: 30_000 }).catch(() => null);
    await drawer.getByRole("button", { name: "Create Silicon" }).click();
    const createdAnswer = await created;
    await stored.waitFor({ timeout: 20_000 });
    const stk = await revealedStk(page);
    await shot(env, page, "scli-site-01-stk-revealed");
    results.check("create: the site shows the generated STK (stk- + 12 hex)", /^stk-[0-9a-f]{12}$/.test(stk), stk ? "stk-…" : "nothing revealed");
    const main = await page.locator("main").innerText();
    results.check("…with the command the Silicon signs in with", main.includes(`silicon-accounts login --silicon ${sid} --stk-stdin`), main.includes(sid) ? "the reveal card names the Silicon" : "no reveal card");

    // The service keeps only the hash: no read of the Silicon returns the STK.
    const list = await asCarbon<Json>(env, carbon, "GET", "/v1/me/silicons");
    const items = (Array.isArray(obj(list.body).items) ? obj(list.body).items : []) as Json[];
    const mine = items.find(item => item.id === sid);
    results.check("the custodian's list has it, active, with the Carbon as custodian (shown as its c:id)", mine?.status === "active" && obj(mine?.custodian).id === carbon.id && obj(mine?.custodian).uuid === carbon.uuid, short(mine));
    const shown = await asCarbon<Json>(env, carbon, "GET", `/v1/me/silicons/${encodeURIComponent(sid)}`);
    const anyRead = JSON.stringify([list.body, shown.body]);
    results.check("no later read of the Silicon carries its STK (list, show)", shown.status === 200 && !!stk && !anyRead.includes(stk) && !/"stk"\s*:/.test(anyRead), `show ${shown.status}`);
    results.check("its date of birth is the day the account was created", !!mine && str(mine.dob) === str(mine.created_at).slice(0, 10), `dob ${str(mine?.dob)}, created ${str(mine?.created_at)}`);
    results.check("the create answer was 201 and the site never re-reads the STK", createdAnswer?.status() === 201, String(createdAnswer?.status()));

    // 2. "I've stored it" drops the only copy: after a reload the STK is nowhere on the page.
    await stored.click();
    await sleep(500);
    await page.reload();
    await page.getByRole("button", { name: new RegExp(`^Manage ${sid}`) }).waitFor({ timeout: 30_000 });
    await sleep(800);
    const after = `${await page.content()}\n${(await page.locator(".sr-only, [class*=srOnly]").allInnerTexts()).join("\n")}`;
    results.check("after storing it and reloading, the STK is shown nowhere (shown exactly once)", !!stk && !after.includes(stk), "");
    await page.getByRole("button", { name: new RegExp(`^Manage ${sid}`) }).click();
    const manage = page.getByRole("dialog").filter({ hasText: sid }).first();
    await manage.waitFor({ timeout: 10_000 });
    await sleep(700);
    const drawerText = `${await manage.innerText()}\n${await manage.innerHTML()}`;
    results.check("its drawer does not show the STK either", !!stk && !drawerText.includes(stk));
    await shot(env, page, "scli-site-02-drawer");
    await page.keyboard.press("Escape");
    await sleep(400);

    // 3. The STK signs the Silicon in with the CLI; the CLI shows its custodian's c:id.
    const home = freshDir();
    const login = await loginSilicon(env, home, sid, stk);
    results.check("`silicon-accounts login --silicon` with the revealed STK signs it in", login.code === 0 && login.json?.authenticated === true && login.json?.kind === "silicon" && login.json?.id === sid, said(login));
    const whoami = await accounts(env, ["whoami", "--json"], { home });
    results.check("`silicon-accounts whoami` shows its custodian by c:id", whoami.code === 0 && obj(whoami.json?.custodian).id === carbon.id && whoami.json?.kind === "silicon", said(whoami));
    const wrong = await loginSilicon(env, freshDir(), sid, `stk-${"0".repeat(12)}`);
    results.check("a wrong STK is refused (exit 3, invalid_credentials)", wrong.code === 3 && obj(wrong.json?.error).code === "invalid_credentials", said(wrong));
    const history = await accounts(env, ["history", "--kind", "custodian", "--json"], { home });
    const entries = (Array.isArray(history.json?.items) ? history.json?.items : []) as Json[];
    results.check("the Silicon's history says who created it and became its custodian", entries.some(entry => obj(entry.meta).kind === "created_by_custodian" && str(entry.title).includes(carbon.id)), short(entries.map(entry => entry.title)));
    const carbonHistory = await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?kind=custodian");
    const carbonEntries = (Array.isArray(obj(carbonHistory.body).items) ? obj(carbonHistory.body).items : []) as Json[];
    results.check("the Carbon's history lists the Silicon it created", carbonEntries.some(entry => str(entry.title) === `Created the Silicon ${sid}`), short(carbonEntries.map(entry => entry.title)));

    // 4. A chosen STK: 7 and 33 hex digits are refused before anything is sent; 32 is accepted and never echoed.
    const posts: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/v1/me/silicons") posts.push(request.url());
    });
    const own = `own-${t}`;
    await page.getByRole("button", { name: "Create a Silicon" }).first().click({ timeout: 30_000 });
    drawer = page.getByRole("dialog", { name: "Create a Silicon" });
    await drawer.getByRole("textbox", { name: "Display name" }).fill(`Own ${t}`);
    await drawer.getByRole("textbox", { name: "Id" }).fill(own);
    await drawer.getByRole("checkbox", { name: /Choose its STK yourself/ }).click();
    const stkField = drawer.getByRole("textbox", { name: "STK" });
    await drawer.getByText(`si:${own} is available.`).waitFor({ timeout: 30_000 });
    for (const length of [7, 33]) {
      await stkField.fill(`stk-${"a1".repeat(17).slice(0, length)}`);
      await drawer.getByRole("button", { name: "Create Silicon" }).click();
      await sleep(600);
      const text = await drawer.innerText();
      results.check(`the site refuses a chosen STK of ${length} hex digits and says why`, text.includes(`this one has ${length}`), short(text.match(/An STK[^.]*\./)?.[0] ?? text, 200));
    }
    await shot(env, page, "scli-site-03-stk-refused");
    results.check("…without sending anything", posts.length === 0, `${posts.length} create requests`);
    const chosen = `stk-${"0123456789abcdef".repeat(2)}`;
    await stkField.fill(chosen.toUpperCase().replace("STK-", "stk-"));
    const second = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/me/silicons", { timeout: 30_000 }).catch(() => null);
    await drawer.getByRole("button", { name: "Create Silicon" }).click();
    const secondAnswer = await second;
    const secondBody = obj(await secondAnswer?.json().catch(() => ({})));
    results.check("a chosen STK of 32 hex digits is accepted, and never echoed back", secondAnswer?.status() === 201 && secondBody.stk === null && !JSON.stringify(secondBody).includes(chosen), `${secondAnswer?.status()} ${short(secondBody, 200)}`);
    await sleep(1200);
    const noReveal = (await page.getByRole("button", { name: "I've stored it" }).count()) === 0;
    results.check("…and the site shows no STK card for it (there is nothing to reveal)", noReveal);
    const ownLogin = await loginSilicon(env, freshDir(), `si:${own}`, chosen);
    results.check("the chosen STK signs that Silicon in", ownLogin.code === 0 && ownLogin.json?.id === `si:${own}`, said(ownLogin));
    const taken = await idAvailable(ctx, `si:${own}`);
    results.check("its si:id is taken now", taken.available === false, short(taken));
    await shot(env, page, "scli-site-04-created-own");
    await context.close();
  },
};
