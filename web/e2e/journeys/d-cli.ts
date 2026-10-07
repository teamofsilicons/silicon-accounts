import type { Journey } from "../context";
import { cli, cliHome, newContext, postJson, shot, sleep, tag } from "../lib";

interface DeviceEvent {
  event?: string;
  verification_uri_complete?: string;
  user_code?: string;
}

export const journey: Journey = {
  name: "d-cli",
  title: "the CLI: device sign-in approved in the browser, silicon create, a self-created Silicon accepted on the site, login --silicon, an SLT for remind",
  needs: ["ada"],
  async run({ env, results, browser, shared }) {
    const ada = shared.ada!;
    const context = await newContext(browser, { cookies: ada.cookies });
    const page = await context.newPage();
    results.watch(page, "d");
    const t = tag();

    // 1. `accounts login` (device flow), approved on /device in the signed-in browser.
    const homeA = cliHome();
    let device: DeviceEvent | null = null;
    const login = cli(env, homeA, ["login", "--no-browser", "--json", "--label", "e2e walk"], {
      onStderr: line => {
        try {
          const event = JSON.parse(line) as DeviceEvent;
          if (event.event === "device_code") device = event;
        } catch {
          // A text line.
        }
      },
    });
    for (let waited = 0; !device && waited < 150; waited++) await sleep(100);
    const shown = device as DeviceEvent | null;
    results.check("the CLI prints a device code with the site's /device link", !!shown?.verification_uri_complete?.startsWith(`${env.site}/device?code=`), JSON.stringify(shown));
    await page.goto(shown?.verification_uri_complete ?? `${env.site}/device`);
    const approve = page.getByRole("button", { name: "Approve sign-in" });
    await approve.waitFor({ timeout: 30_000 });
    await sleep(800);
    await shot(env, page, "d-01-device-review");
    results.check("the device page names the terminal's label", (await page.locator("main").innerText()).includes("e2e walk"));
    await approve.click();
    const signedIn = await login;
    results.check("the CLI is signed in as the Carbon who approved", signedIn.code === 0 && signedIn.json?.id === ada.id, `exit ${signedIn.code} in ${signedIn.ms} ms`);

    // 2. `accounts silicon create` as that Carbon: the STK is printed once.
    const sid = `si:walker-${t}`;
    const created = await cli(env, homeA, ["silicon", "create", "--id", sid, "--display-name", `Walker ${t}`, "--json"]);
    const stk = typeof created.json?.stk === "string" ? created.json.stk : "";
    results.check("`accounts silicon create` prints the generated STK once", created.code === 0 && /^stk-[0-9a-f]{12}$/.test(stk), created.stderr.slice(-200));
    await page.goto(`${env.site}/silicons`);
    await page.waitForLoadState("networkidle");
    await sleep(800);
    results.check("the site lists the new Silicon", (await page.locator("main").innerText()).includes(sid.slice(3)));

    // 3. A Silicon creates its own account naming the Carbon; `--wait` returns once the Carbon accepts on the site.
    const homeB = cliHome();
    const selfId = `si:selfmade-${t}`;
    const selfRun = cli(env, homeB, ["silicon", "create", "--id", selfId, "--custodian", ada.id, "--wait", "--timeout", "3m", "--json"]);
    await sleep(1500);
    await page.goto(`${env.site}/silicons`);
    const accept = page.getByRole("button", { name: "Accept and become custodian" });
    await accept.waitFor({ timeout: 30_000 });
    await shot(env, page, "d-02-request-deck");
    const acceptedAt = Date.now();
    await accept.click();
    const selfDone = await selfRun;
    results.check("the self-created Silicon's --wait returns after the accept on the site", selfDone.code === 0 && selfDone.json?.final_status === "accepted", `exit ${selfDone.code}, ${Date.now() - acceptedAt} ms after the accept`);
    const status = await cli(env, homeB, ["login", "status", "--json"]);
    results.check("…and it is signed in as itself", status.json?.authenticated === true && status.json?.id === selfId);

    // 4. `accounts login --silicon` with the STK, then `--app remind` (an SLT) that the fake remind app exchanges.
    const homeC = cliHome();
    const silicon = await cli(env, homeC, ["login", "--silicon", sid, "--stk-stdin", "--json"], { stdin: `${stk}\n` });
    results.check("`accounts login --silicon` with the STK", silicon.code === 0 && silicon.json?.id === sid, silicon.stderr.slice(-200));
    const slt = silicon.code === 0 ? await cli(env, homeC, ["login", "--app", "remind", "--json"]) : null;
    const token = typeof slt?.json?.slt === "string" ? slt.json.slt : "";
    results.check("`accounts login --app remind` prints a short-lived token", token.startsWith("slt_"), `${slt?.ms ?? 0} ms`);
    const exchanged = await postJson<{ ok?: boolean; id?: string; exchange_ms?: number }>(`${env.apps}/remind/slt-login`, { slt: token });
    results.check("the fake remind app exchanges the SLT for the Silicon's tokens", exchanged.status === 200 && exchanged.body.ok === true && exchanged.body.id === sid, JSON.stringify(exchanged.body).slice(0, 160));
    const again = await postJson(`${env.apps}/remind/slt-login`, { slt: token });
    results.check("an SLT works once", again.status >= 400, String(again.status));
    await context.close();
  },
};
