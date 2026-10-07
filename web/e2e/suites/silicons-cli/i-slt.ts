import type { Journey } from "../../context";
import { codeFor, forgetRateLimits, json, lastSeq, sql, tag } from "../../lib";
import {
  accounts,
  appSecret,
  appSltLogin,
  asApp,
  asCarbon,
  cliError,
  freshDir,
  freshPhone,
  loginCarbon,
  loginSilicon,
  obj,
  said,
  short,
  signInToApp,
  signUpCarbon,
  str,
  type Json,
} from "./_helpers";

/** The scopes of the tokens an app got for an SLT (what the fake app's exchange shows). */
const scopesOf = (exchange: { body: Json }) => str(obj(exchange.body.token).scope).split(" ").filter(Boolean).sort();

/** A details page's rows as `field:mode:shared` (FlowView.details.fields). */
const rowsOf = (page: Json | undefined) => ((Array.isArray(page?.fields) ? page.fields : []) as Json[]).map(field => `${str(field.field)}:${str(field.mode)}:${field.shared === true ? "shared" : "not shared"}`);

export const journey: Journey = {
  name: "silicons-cli-slt",
  title: "a Silicon signs into remind and briefcase with `accounts login --app`: one command signs in and prints a 2-minute single-use token bound to the app; signed in, it is returned directly; the apps exchange it (and only once, only for themselves); a Carbon's token carries the app's required details and only the optional ones it ticked on the app's pages (v2), a missing required phone is asked for, and the first-party apps get none",
  // No browser: the CLI and the API only, so the engine changes nothing (the browser journeys run in WebKit too).
  engines: ["chromium"],
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
    // docs/start/tokens.md: a Silicon has no what's-shared page, so the dob/timezone an app asks for, required or optional, come along.
    results.check(
      "…briefcase asks for the timezone optionally: a Silicon has no page to tick it on, so it comes along (profile + timezone, as documented), never an email",
      JSON.stringify(scopesOf(briefcase)) === JSON.stringify(["profile", "timezone"]) && obj(briefcase.body.account).timezone === "Europe/Berlin",
      `scope ${scopesOf(briefcase).join(" ")}; ${short(briefcase.body.account, 200)}`,
    );
    const siliconDmSlt = await accounts(env, ["login", "--app", "dm", "--json"], { home });
    const siliconDm = await appSltLogin(env, "dm", str(siliconDmSlt.json?.slt));
    results.check(
      "dm requires a phone from Carbons: a Silicon (which has none) is never asked for one — its token is minted and works, and no phone is shared",
      siliconDmSlt.code === 0 && siliconDm.body.ok === true && siliconDm.body.kind === "silicon" && !obj(siliconDm.body.account).phone && !scopesOf(siliconDm).includes("phone"),
      `${said(siliconDmSlt).replace(str(siliconDmSlt.json?.slt), "slt_…")} | scope ${scopesOf(siliconDm).join(" ")} ${short(siliconDm.body.error ?? siliconDm.body.account, 200)}`,
    );
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
    // The developer site is Silicon Accounts' other first-party app (build spec 06-v2 §2: a public client with no secret).
    // The token endpoint refuses it the SLT grant, so a token minted for it could never be exchanged by anyone.
    const developer = await accounts(env, ["login", "--app", "developer", "--json"], { home });
    const developerExchange = developer.code === 0
      ? await json<Json>(`${env.site}/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ctx.ip }, body: new URLSearchParams({ grant_type: "slt", slt: str(developer.json?.slt), client_id: "developer" }).toString() })
      : null;
    results.check(
      "'developer' (the developer site, first-party like 'accounts'): refused the same way (exit 2, first_party_app), not handed a token nobody can exchange",
      developer.code === 2 && cliError(developer).code === "first_party_app",
      `${said(developer).replace(str(developer.json?.slt), "slt_…")}${developerExchange ? ` | exchanging that token as the client 'developer': ${developerExchange.status} ${short(developerExchange.body, 260)}` : ""}`,
    );

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

    // 8. A Carbon gets one the same way (its CLI session from an email code): briefcase requires the email and asks for
    //    the timezone optionally (UNDERSTANDING.md "What's shared with the app": optional is unticked until ticked).
    const carbonHome = freshDir();
    await loginCarbon(env, carbonHome, carbon);
    const carbonSlt = await accounts(env, ["login", "--app", "briefcase", "--json"], { home: carbonHome });
    const carbonIn = await appSltLogin(env, "briefcase", str(carbonSlt.json?.slt));
    results.check("a Carbon's `accounts login --app briefcase` works too (its email is shared, briefcase requires it)", carbonIn.body.ok === true && carbonIn.body.kind === "carbon" && obj(carbonIn.body.account).email === carbon.email, short(carbonIn.body.error ?? carbonIn.body.account));
    results.check(
      "…and only what briefcase requires: profile + email, not the optional timezone the Carbon never ticked",
      JSON.stringify(scopesOf(carbonIn)) === JSON.stringify(["email", "profile"]) && !obj(carbonIn.body.account).timezone,
      `scope ${scopesOf(carbonIn).join(" ")}; timezone ${short(obj(carbonIn.body.account).timezone)}`,
    );
    // Its first sign-in on briefcase's own pages: the Carbon has never been shown what is shared with briefcase (the CLI
    // shows nothing of it), nor offered its optional timezone.
    const firstOnPages = await signInToApp(env, carbon, "briefcase", { share: ["timezone"] });
    results.check(
      "the Carbon's first sign-in on briefcase's own pages, after only `accounts login --app briefcase`, shows briefcase's what's-shared page (email required, timezone optional and unticked)",
      firstOnPages.pages.length === 1 && JSON.stringify(rowsOf(firstOnPages.pages[0])) === JSON.stringify(["email:required:shared", "timezone:optional:not shared"]),
      firstOnPages.pages.length ? `pages ${short(firstOnPages.pages.map(rowsOf))}` : "no details page: the hosted sign-in went straight back to briefcase (the SLT's membership counts as having seen it), so the Carbon was never shown what briefcase gets nor offered the timezone",
    );

    // 9. Another Carbon signs into briefcase on its pages first, ticking the timezone: the CLI's tokens carry it; shown
    //    the page again (prompt=consent) it starts ticked, and unticking it takes it out of the next token.
    const second = await signUpCarbon(env, "slt-ticks");
    const secondHome = freshDir();
    await loginCarbon(env, secondHome, second);
    const ticked = await signInToApp(env, second, "briefcase", { share: ["timezone"] });
    results.check(
      "a Carbon's first sign-in on briefcase's pages shows one details page: email required, timezone optional and unticked; it ticks the timezone",
      ticked.pages.length === 1 && JSON.stringify(rowsOf(ticked.pages[0])) === JSON.stringify(["email:required:shared", "timezone:optional:not shared"]) && ticked.callbackStatus < 400,
      `${short(ticked.pages.map(rowsOf))}; callback ${ticked.callbackStatus}`,
    );
    const withTimezone = await appSltLogin(env, "briefcase", str((await accounts(env, ["login", "--app", "briefcase", "--json"], { home: secondHome })).json?.slt));
    results.check(
      "…then its `accounts login --app briefcase` token carries the ticked timezone too (profile + email + timezone)",
      JSON.stringify(scopesOf(withTimezone)) === JSON.stringify(["email", "profile", "timezone"]) && obj(withTimezone.body.account).timezone === "Asia/Kolkata",
      `scope ${scopesOf(withTimezone).join(" ")}; ${short(withTimezone.body.account, 200)}`,
    );
    const unticked = await signInToApp(env, second, "briefcase", { share: [], prompt: "consent" });
    results.check(
      "shown the page again (prompt=consent), the timezone it shared starts ticked; it unticks it",
      unticked.pages.length === 1 && JSON.stringify(rowsOf(unticked.pages[0])) === JSON.stringify(["email:required:shared", "timezone:optional:shared"]),
      short(unticked.pages.map(rowsOf)),
    );
    const withoutTimezone = await appSltLogin(env, "briefcase", str((await accounts(env, ["login", "--app", "briefcase", "--json"], { home: secondHome })).json?.slt));
    results.check(
      "…and the next token leaves it out again (profile + email)",
      JSON.stringify(scopesOf(withoutTimezone)) === JSON.stringify(["email", "profile"]) && !obj(withoutTimezone.body.account).timezone,
      `scope ${scopesOf(withoutTimezone).join(" ")}`,
    );

    // 10. dm requires a phone the Carbon doesn't have: the CLI says so and how to add it; once added, dm gets the phone
    //     and not the email (optional there, never ticked).
    const noPhone = await accounts(env, ["login", "--app", "dm", "--json"], { home: secondHome });
    results.check(
      "`accounts login --app dm` without a phone: exit 5, requirements_missing naming the phone, and how to add it (`accounts phone add`) or let dm's pages ask for it",
      noPhone.code === 5 && cliError(noPhone).code === "requirements_missing" && JSON.stringify(obj(cliError(noPhone).details).missing) === '["phone"]' && str(cliError(noPhone).hint).includes("accounts phone add") && /phone number/.test(str(cliError(noPhone).message)),
      said(noPhone),
    );
    const phone = await freshPhone(env);
    const before = await lastSeq(env);
    const added = await accounts(env, ["phone", "add", phone, "--json"], { home: secondHome });
    const code = await codeFor(env, phone, before).catch(() => "");
    const verified = await accounts(env, ["phone", "verify", str(added.json?.challenge_id), code, "--json"], { home: secondHome });
    const dmIn = await appSltLogin(env, "dm", str((await accounts(env, ["login", "--app", "dm", "--json"], { home: secondHome })).json?.slt));
    results.check(
      "after `accounts phone add` + `accounts phone verify`, the token works: dm gets the phone (required), not the email (optional, never ticked)",
      added.code === 0 && verified.code === 0 && dmIn.body.ok === true && JSON.stringify(scopesOf(dmIn)) === JSON.stringify(["phone", "profile"]) && obj(dmIn.body.account).phone === phone && !obj(dmIn.body.account).email,
      `${said(added)} | ${said(verified)} | scope ${scopesOf(dmIn).join(" ")} ${short(dmIn.body.error ?? dmIn.body.account, 200)}`,
    );
  },
};
