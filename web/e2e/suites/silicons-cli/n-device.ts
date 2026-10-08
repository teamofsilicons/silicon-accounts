import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { forgetRateLimits, shot, sleep, sql, tag } from "../../lib";
import { accounts, asCarbon, carbonContext, cliError, freshDir, obj, said, short, signUpCarbon, str, until, type Json, type Run } from "./_helpers";

interface DeviceStart {
  run: Promise<Run>;
  event: Json | null;
}

/** Starts `silicon-accounts login --no-browser --json` and waits for its device_code event (stderr). */
async function startDeviceLogin(env: Parameters<typeof accounts>[0], home: string, label: string): Promise<DeviceStart> {
  const state: DeviceStart = { run: Promise.resolve({} as Run), event: null };
  state.run = accounts(env, ["login", "--no-browser", "--json", "--label", label], {
    home,
    timeoutMs: 180_000,
    onEvent: event => {
      if (event.event === "device_code") state.event = event;
    },
  });
  await until(async () => state.event, 20_000, 100);
  return state;
}

const heading = async (page: Page) => (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");

export const journey: Journey = {
  name: "silicons-cli-device-flow",
  title: "`silicon-accounts login` (device flow) approved in the browser: the terminal shows a code and link, the site shows the request with its label, approving signs the CLI in as that Carbon; deny, a used code, typing the code by hand, approving from another CLI, and an expired code",
  async run(ctx) {
    const { env, results, browser } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "device");
    const context = await carbonContext(browser, carbon);
    const page = await context.newPage();
    // The unknown code at the end answers 404 on purpose (the browser logs that as a console error).
    results.watch(page, "scli-device", [/status of 404 .*\/v1\/device\/ZZZZ-ZZZZ/]);

    // 1. Approve on the site.
    const home = freshDir();
    const label = `scli terminal ${t}`;
    const first = await startDeviceLogin(env, home, label);
    const event = first.event ?? {};
    const code = str(event.user_code);
    results.check("the CLI prints a device_code event: a code like WDJB-MJHT and the site's /device link", /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) && event.verification_uri === `${env.site}/device` && event.verification_uri_complete === `${env.site}/device?code=${code}` && event.browser_opened === false, short(event));
    const expiresIn = (Date.parse(str(event.expires_at)) - Date.now()) / 60_000;
    results.check("…the code lasts 10 minutes", expiresIn > 9 && expiresIn <= 10.05, `${expiresIn.toFixed(2)} min`);
    await page.goto(str(event.verification_uri_complete));
    const approve = page.getByRole("button", { name: "Approve sign-in" });
    await approve.waitFor({ timeout: 30_000 });
    await sleep(600);
    const review = await heading(page);
    await shot(env, page, "scli-device-01-review");
    results.check("the site shows the request: the code, the terminal's label, who is approving", review.includes("Approve this sign-in?") && review.includes(code) && review.includes(label) && review.includes(carbon.id), short(review, 400));
    const approvedAt = Date.now();
    await approve.click();
    const signedIn = await first.run;
    results.metric("approve → CLI signed in", Date.now() - approvedAt, "ms");
    results.check("the CLI is signed in as the Carbon who approved (exit 0, kind carbon)", signedIn.code === 0 && signedIn.json?.authenticated === true && signedIn.json?.kind === "carbon" && signedIn.json?.id === carbon.id, said(signedIn));
    await page.getByText("Your terminal is signed in").waitFor({ timeout: 15_000 }).catch(() => undefined);
    await shot(env, page, "scli-device-02-approved");
    results.check("the page says the terminal is signed in, as whom", (await heading(page)).includes("Your terminal is signed in") && (await heading(page)).includes(carbon.id));
    const status = await accounts(env, ["login", "status", "--json"], { home });
    results.check("`silicon-accounts login status --json`: authenticated as the Carbon", status.code === 0 && status.json?.id === carbon.id, said(status));
    const sessions = await accounts(env, ["sessions", "list", "--json"], { home });
    const mine = ((sessions.json?.items ?? []) as Json[]).find(item => item.current === true);
    results.check("its session carries the terminal's label and how it signed in (device)", mine?.label === label && mine.origin === "device", short(mine));
    const used = await asCarbon<Json>(env, carbon, "GET", `/v1/device/${code}`);
    const reuse = await asCarbon<Json>(env, carbon, "POST", `/v1/device/${code}/approve`, {});
    results.check("the code is spent: it reads consumed and can't be approved again (409 device_code_used)", obj(used.body).status === "consumed" && reuse.status === 409 && str(obj(obj(reuse.body).error).code) === "device_code_used", `${short(used.body)} ${reuse.status}`);
    await page.goto(`${env.site}/device?code=${code}`);
    await page.getByText("This code was already used").waitFor({ timeout: 15_000 }).catch(() => undefined);
    results.check("opening a used code's link says it was already used", (await heading(page)).includes("This code was already used"));

    // 2. Deny.
    const homeDeny = freshDir();
    const denied = await startDeviceLogin(env, homeDeny, `${label} (deny)`);
    await page.goto(str(denied.event?.verification_uri_complete));
    await page.getByRole("button", { name: "Deny" }).click({ timeout: 30_000 });
    const refused = await denied.run;
    results.check("denying it: the CLI stops with exit 3, access_denied", refused.code === 3 && cliError(refused).code === "access_denied", said(refused));
    await page.getByText("Sign-in denied").waitFor({ timeout: 15_000 }).catch(() => undefined);
    await shot(env, page, "scli-device-03-denied");
    results.check("…the page says it was denied", (await heading(page)).includes("Sign-in denied"));
    const deniedStatus = await accounts(env, ["login", "status", "--json"], { home: homeDeny });
    results.check("…and that terminal is not signed in", deniedStatus.code === 1 && deniedStatus.json?.authenticated === false, said(deniedStatus));

    // 3. Typing the code by hand on /device.
    const homeTyped = freshDir();
    const typed = await startDeviceLogin(env, homeTyped, `${label} (typed)`);
    await page.goto(`${env.site}/device`);
    const field = page.getByRole("textbox", { name: "Code from your terminal" });
    await field.waitFor({ timeout: 30_000 });
    await field.fill(str(typed.event?.user_code).toLowerCase().replace("-", ""));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Approve sign-in" }).click({ timeout: 30_000 });
    const typedIn = await typed.run;
    results.check("typing the code (lower case, no dash) on /device and approving signs that terminal in", typedIn.code === 0 && typedIn.json?.id === carbon.id, said(typedIn));

    // 4. Approved from another terminal (`silicon-accounts device approve`).
    const homeOther = freshDir();
    const other = await startDeviceLogin(env, homeOther, `${label} (cli)`);
    const otherCode = str(other.event?.user_code);
    const shown = await accounts(env, ["device", "show", otherCode, "--json"], { home });
    results.check("`silicon-accounts device show <code>` (signed in as the Carbon): pending, with its label", shown.code === 0 && shown.json?.status === "pending" && shown.json?.client_label === `${label} (cli)`, said(shown));
    const approved = await accounts(env, ["device", "approve", otherCode, "--json"], { home });
    const otherIn = await other.run;
    results.check("`silicon-accounts device approve <code>` signs the other terminal in as the Carbon", approved.code === 0 && otherIn.code === 0 && otherIn.json?.id === carbon.id, `${said(approved)} | ${said(otherIn)}`);

    // 5. A code nobody approves expires (time travel).
    const homeLate = freshDir();
    const late = await startDeviceLogin(env, homeLate, `${label} (late)`);
    await sql(env, `update device_authorizations set expires_at = now() - interval '1 second' where user_code = '${str(late.event?.user_code)}'`);
    const lateRun = await late.run;
    results.check("a code past its 10 minutes: the CLI stops with exit 3, expired_token", lateRun.code === 3 && cliError(lateRun).code === "expired_token", said(lateRun));
    await page.goto(`${env.site}/device?code=${str(late.event?.user_code)}`);
    await page.getByText("This code expired").waitFor({ timeout: 15_000 }).catch(() => undefined);
    results.check("…and its link says the code expired", (await heading(page)).includes("This code expired"));
    await page.goto(`${env.site}/device?code=ZZZZ-ZZZZ`);
    await page.getByText("No sign-in uses").waitFor({ timeout: 15_000 }).catch(() => undefined);
    results.check("a code that doesn't exist: 'No sign-in uses ZZZZ-ZZZZ'", (await heading(page)).includes("No sign-in uses ZZZZ-ZZZZ"));
    await shot(env, page, "scli-device-04-unknown");

    // 6. The Carbon's history: every decision, with the terminal's label, and the sign-ins it led to.
    const security = ((obj((await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?kind=security&limit=100")).body).items ?? []) as Json[]).map(item => `${str(item.title)} | ${str(item.detail)}`);
    const expected = [`Approved a terminal sign-in | ${label}`, `Denied a terminal sign-in | ${label} (deny)`, `Approved a terminal sign-in | ${label} (typed)`, `Approved a terminal sign-in | ${label} (cli)`];
    results.check("the history lists each approval and denial (site and `silicon-accounts device approve`) with the terminal's label", expected.every(entry => security.includes(entry)), short(security.filter(entry => entry.includes("terminal sign-in"))));
    const signins = ((obj((await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?kind=signin&limit=100")).body).items ?? []) as Json[]).filter(item => obj(item.meta).method === "device");
    results.check("…and the three device sign-ins, from the silicon-accounts CLI", signins.length === 3 && signins.every(item => item.title === "Signed in to Silicon Accounts with the silicon-accounts CLI (device code)" && /· silicon-accounts CLI \d+\.\d+\.\d+$/.test(str(item.detail))), short(signins.map(item => [item.title, item.detail])));
    await context.close();
  },
};
