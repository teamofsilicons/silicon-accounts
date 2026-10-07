import type { Journey } from "../../context";
import { forgetRateLimits, sql, tag } from "../../lib";
import {
  accounts,
  appSecret,
  appSltLogin,
  asApp,
  asCarbon,
  cliError,
  freshDir,
  loginCarbon,
  loginSilicon,
  obj,
  said,
  short,
  signUpCarbon,
  str,
  type Json,
} from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-slt",
  title: "a Silicon signs into remind and briefcase with `accounts login --app`: one command signs in and prints a 2-minute single-use token bound to the app; signed in, it is returned directly; the apps exchange it (and only once, only for themselves)",
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "slt");
    const sid = `si:slt-${t}`;
    const stk = `stk-5e1f${"0123456789abcdef".slice(0, 12)}`;
    const made = await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: sid, display_name: `Slt ${t}`, stk, timezone: "Europe/Berlin" });
    const uuid = str(obj(obj(made.body).silicon).uuid);
    results.check("the custodian creates the Silicon with a chosen STK", made.status === 201, `${made.status} ${short(made.body)}`);
    const home = freshDir();

    // 1. Sign in and get an SLT for remind in one command.
    const first = await loginSilicon(env, home, sid, stk, ["--app", "remind"]);
    const slt = str(first.json?.slt);
    const ttl = (Date.parse(str(first.json?.expires_at)) - Date.now()) / 1000;
    results.check("`accounts login --silicon … --app remind --json`: {slt, app_id, expires_at}", first.code === 0 && slt.startsWith("slt_") && first.json?.app_id === "remind" && Object.keys(first.json ?? {}).sort().join(",") === "app_id,expires_at,slt", said(first).replace(slt, "slt_…"));
    results.check("…valid for 2 minutes", ttl > 100 && ttl <= 121, `${ttl.toFixed(1)} s`);
    const status = await accounts(env, ["login", "status", "--json"], { home });
    results.check("…and the CLI stays signed in as the Silicon", status.json?.authenticated === true && status.json?.id === sid, said(status));

    // 2. Already signed in: the SLT comes directly, no STK needed.
    const direct = await accounts(env, ["login", "--app", "briefcase", "--json"], { home });
    const sltB = str(direct.json?.slt);
    results.check("signed in already, `accounts login --app briefcase` returns an SLT directly", direct.code === 0 && sltB.startsWith("slt_") && direct.json?.app_id === "briefcase", said(direct).replace(sltB, "slt_…"));
    const plain = await accounts(env, ["login", "--app", "remind"], { home });
    const lines = plain.stdout.trim().split("\n");
    results.check("in text mode stdout is only the token (ready for $(accounts login --app …))", plain.code === 0 && lines.length === 1 && /^slt_[A-Za-z0-9_-]+$/.test(lines[0] ?? ""), `${lines.length} line(s)`);

    // 3. The apps exchange them.
    const remind = await appSltLogin(env, "remind", slt);
    const account = obj(remind.body.account);
    results.check("remind exchanges the SLT: signed in as the Silicon (kind silicon, membership remind:<uuid>)", remind.body.ok === true && remind.body.id === sid && remind.body.kind === "silicon" && remind.body.membership_id === `remind:${uuid}`, short(remind.body.error ?? { id: remind.body.id, kind: remind.body.kind }));
    results.check("…remind requires the timezone: it gets it; a Silicon has no email or phone to share", account.timezone === "Europe/Berlin" && !("email" in account && account.email) && !("phone" in account && account.phone) && str(obj(remind.body.token).scope).split(" ").includes("timezone"), short(account));
    const briefcase = await appSltLogin(env, "briefcase", sltB);
    results.check("briefcase (which requires an email from Carbons) signs the Silicon in too", briefcase.body.ok === true && briefcase.body.id === sid && !obj(briefcase.body.account).email, short(briefcase.body.error ?? briefcase.body.account));
    const reuse = await appSltLogin(env, "remind", slt);
    results.check("an SLT works once (a second exchange: invalid_grant)", reuse.body.ok !== true && str(obj(reuse.body.error).error) === "invalid_grant", short(reuse.body));
    const otherApp = (await accounts(env, ["login", "--app", "remind", "--json"], { home })).json;
    const stolen = await appSltLogin(env, "briefcase", str(otherApp?.slt));
    results.check("an SLT for remind can't be used by briefcase (invalid_grant)", stolen.body.ok !== true && str(obj(stolen.body.error).error) === "invalid_grant", short(stolen.body));
    // Single use counts presentations: a token that reached the wrong app may have leaked, so it is spent there too.
    const spent = await appSltLogin(env, "remind", str(otherApp?.slt));
    results.check("…and presenting it to the wrong app spent it (single use): remind can't use it afterwards", spent.body.ok !== true && /already used/.test(str(obj(spent.body.error).error_description)), short(spent.body.error));

    // 4. Expired after its 2 minutes (time travel).
    const late = (await accounts(env, ["login", "--app", "remind", "--json"], { home })).json;
    await sql(env, `update short_lived_tokens set expires_at = now() - interval '1 second' where account_uuid = '${uuid}' and consumed_at is null`);
    const expired = await appSltLogin(env, "remind", str(late?.slt));
    results.check("an SLT past its 2 minutes is refused (invalid_grant)", expired.body.ok !== true && str(obj(expired.body.error).error) === "invalid_grant", short(expired.body));

    // 5. The app's side with the CLI: `accounts app token slt` exchanges an SLT with the app's credentials.
    const forCli = (await accounts(env, ["login", "--app", "remind", "--json"], { home })).json;
    const exchanged = await accounts(env, ["app", "token", "slt", str(forCli?.slt), "--app-id", "remind", "--app-secret-stdin", "--json"], { home: freshDir(), stdin: `${appSecret("remind")}\n` });
    results.check("`accounts app token slt <slt>` (app mode) exchanges it for the Silicon's tokens", exchanged.code === 0 && str(exchanged.json?.access_token).length > 20 && str(exchanged.json?.membership_id) === `remind:${uuid}`, said(exchanged).replace(/"(access|refresh)_token":\s*"[^"]+"/g, '"$1_token":"…"'));

    // 6. Refusals for the token itself.
    const unknownApp = await accounts(env, ["login", "--app", `nosuch-${t}`, "--json"], { home });
    results.check("an app that doesn't exist: exit 4", unknownApp.code === 4, said(unknownApp));
    const firstParty = await accounts(env, ["login", "--app", "accounts", "--json"], { home });
    results.check("'accounts' itself: exit 2, first_party_app", firstParty.code === 2 && cliError(firstParty).code === "first_party_app", said(firstParty));

    // 7. Where the sign-ins show.
    const apps = await accounts(env, ["apps", "list", "--json"], { home });
    const items = (apps.json?.items ?? []) as Json[];
    const of = (app: string) => items.find(item => obj(item.app).app_id === app);
    results.check("`accounts apps list` (as the Silicon): remind and briefcase, active, through SLTs", of("remind")?.status === "active" && of("briefcase")?.status === "active" && of("remind")?.source === "slt", short(items.map(item => [obj(item.app).app_id, item.status, item.source])));
    const users = await asApp<Json>(ctx, "remind", "GET", `/v1/apps/remind/users?q=${encodeURIComponent(sid)}`);
    const user = ((users.body.items ?? []) as Json[]).find(item => obj(item.account).uuid === uuid || item.uuid === uuid);
    results.check("remind's user base has the Silicon (kind silicon, source slt)", !!user && JSON.stringify(user).includes('"silicon"') && JSON.stringify(user).includes('"slt"'), `${users.status} ${short(user ?? users.body)}`);
    const history = await accounts(env, ["history", "--kind", "signin", "--json"], { home });
    const appSignins = ((history.json?.items ?? []) as Json[]).filter(item => obj(item.app).app_id === "remind" || obj(item.app).app_id === "briefcase");
    results.check("the Silicon's sign-in history lists the app sign-ins", appSignins.length >= 2, short(appSignins.map(item => item.title)));

    // 8. A Carbon gets one the same way (its CLI session from an email code).
    const carbonHome = freshDir();
    await loginCarbon(env, carbonHome, carbon);
    const carbonSlt = await accounts(env, ["login", "--app", "briefcase", "--json"], { home: carbonHome });
    const carbonIn = await appSltLogin(env, "briefcase", str(carbonSlt.json?.slt));
    results.check("a Carbon's `accounts login --app briefcase` works too (its email is shared, briefcase requires it)", carbonIn.body.ok === true && carbonIn.body.kind === "carbon" && obj(carbonIn.body.account).email === carbon.email, short(carbonIn.body.error ?? carbonIn.body.account));
  },
};
