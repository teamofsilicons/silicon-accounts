import { statSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { codeFor, forgetRateLimits, lastSeq, sql, tag } from "../../lib";
import { accounts, asCarbon, cliError, codeEmail, freshDir, freshPhone, loginCarbon, obj, said, short, signUpCarbon, str, type Json } from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-email-login",
  title: "headless `silicon-accounts login --email` and `--phone`: the code is sent and the command returns (code_sent), `--code` finishes it (or `--challenge`); wrong, expired and reused codes, an unknown address or number, ten wrong codes lock it for a minute, a local number with --country, and the flags that don't fit together",
  // No browser: the CLI and the API only, so the engine changes nothing (the browser journeys run in WebKit too).
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "headless");
    const home = freshDir();

    // 1. Send the code: the command returns at once (no terminal to prompt in).
    let after = await lastSeq(env);
    const start = await accounts(env, ["login", "--email", carbon.email.toUpperCase(), "--json"], { home });
    results.check("`silicon-accounts login --email <e> --json` (no terminal): exit 0, code_sent, not signed in yet, how to finish", start.code === 0 && start.json?.status === "code_sent" && start.json?.authenticated === false && !!start.json?.challenge_id && str(start.json?.next).includes("--code"), said(start));
    results.check("…the destination is shown masked", /^s\*+@example\.test$/.test(str(start.json?.destination)) || (str(start.json?.destination).includes("*") && !str(start.json?.destination).includes(carbon.email)), str(start.json?.destination));
    const challengeFile = join(home, ".accounts", "login-challenge.json");
    let mode = "";
    try {
      mode = (statSync(challengeFile).mode & 0o777).toString(8);
    } catch (error) {
      mode = String(error);
    }
    results.check("…the pending challenge is kept in the home (mode 600)", mode === "600", mode);
    const code = await codeEmail(env, carbon.email, after);
    const wrongCode = code === "000000" ? "111111" : "000000";
    const wrong = await accounts(env, ["login", "--email", carbon.email, "--code", wrongCode, "--json"], { home });
    results.check("a wrong code: exit 2, invalid_code, says how many tries are left", wrong.code === 2 && cliError(wrong).code === "invalid_code" && Number(obj(cliError(wrong).details).remaining_attempts) === 9, said(wrong));
    const finish = await accounts(env, ["login", "--email", carbon.email, "--code", code, "--json"], { home });
    results.check("`silicon-accounts login --email <e> --code <code>`: signed in as the Carbon (exit 0)", finish.code === 0 && finish.json?.authenticated === true && finish.json?.kind === "carbon" && finish.json?.id === carbon.id, said(finish));
    let gone = false;
    try {
      statSync(challengeFile);
    } catch {
      gone = true;
    }
    results.check("…and the pending challenge file is removed", gone);
    const status = await accounts(env, ["login", "status", "--json"], { home });
    results.check("`silicon-accounts login status`: authenticated as the Carbon", status.code === 0 && status.json?.id === carbon.id, said(status));
    const reused = await accounts(env, ["login", "--challenge", str(start.json?.challenge_id), "--code", code, "--json"], { home: freshDir() });
    results.check("the same code again (--challenge): refused, a code works once (exit 5, code_already_used)", reused.code === 5 && cliError(reused).code === "code_already_used", said(reused));

    // 2. --challenge finishes a sign-in started elsewhere.
    const homeB = freshDir();
    after = await lastSeq(env);
    const startB = await accounts(env, ["login", "--email", carbon.email, "--json"], { home: freshDir() });
    const codeB = await codeEmail(env, carbon.email, after);
    const viaChallenge = await accounts(env, ["login", "--challenge", str(startB.json?.challenge_id), "--code", codeB, "--json"], { home: homeB });
    results.check("`--challenge <id> --code <c>` finishes it from another home", viaChallenge.code === 0 && viaChallenge.json?.id === carbon.id, said(viaChallenge));

    // 3. An expired code (10 minutes; time travel).
    const homeC = freshDir();
    after = await lastSeq(env);
    await accounts(env, ["login", "--email", carbon.email, "--json"], { home: homeC });
    const codeC = await codeEmail(env, carbon.email, after);
    await sql(env, `update otp_challenges set expires_at = now() - interval '1 second' where destination = '${carbon.email}' and consumed_at is null`);
    const expired = await accounts(env, ["login", "--email", carbon.email, "--code", codeC, "--json"], { home: homeC });
    results.check("a code past its 10 minutes: exit 2, code_expired", expired.code === 2 && cliError(expired).code === "code_expired", said(expired));

    // 4. Ten wrong codes in a row: a one-minute cooldown, even for the right code.
    const homeD = freshDir();
    after = await lastSeq(env);
    await accounts(env, ["login", "--email", carbon.email, "--json"], { home: homeD });
    const codeD = await codeEmail(env, carbon.email, after);
    const badD = codeD === "123123" ? "321321" : "123123";
    const tries = [];
    for (let i = 0; i < 10; i++) tries.push(await accounts(env, ["login", "--email", carbon.email, "--code", badD, "--json"], { home: homeD }));
    const tenth = tries[9]!;
    results.check("ten wrong codes: the first nine count down, the 10th starts a cooldown (locked_until)", tries.slice(0, 9).every(run => run.code === 2) && !!obj(cliError(tenth).details).locked_until, `${tries.map(run => run.code).join(",")} ${said(tenth)}`);
    const lockedRight = await accounts(env, ["login", "--email", carbon.email, "--code", codeD, "--json"], { home: homeD });
    results.check("…during it even the right code is refused: exit 6, verification_locked", lockedRight.code === 6 && cliError(lockedRight).code === "verification_locked", said(lockedRight));
    const cooldown = await sql(env, `select max(extract(epoch from (locked_until - now())))::int from otp_challenges where destination = '${carbon.email}'`);
    results.check("…a cooldown of one minute", Number(cooldown[0]?.[0]) > 50 && Number(cooldown[0]?.[0]) <= 60, short(cooldown));
    await sql(env, `update otp_challenges set locked_until = null where destination = '${carbon.email}'`);
    const unlocked = await accounts(env, ["login", "--email", carbon.email, "--code", codeD, "--json"], { home: homeD });
    results.check("…after it (time travel) the right code signs in", unlocked.code === 0 && unlocked.json?.id === carbon.id, said(unlocked));

    // 5. Refusals.
    const unknown = await accounts(env, ["login", "--email", `nobody.${t}@example.test`, "--json"], { home: freshDir() });
    results.check("an address no Carbon has: exit 4, account_not_found, says to sign up at the site", unknown.code === 4 && cliError(unknown).code === "account_not_found" && str(cliError(unknown).hint).includes(env.site), said(unknown));
    const noPending = await accounts(env, ["login", "--email", `other.${t}@example.test`, "--code", "123456", "--json"], { home: freshDir() });
    results.check("--code with no code sent to that address from this home: exit 2, says to send one first", noPending.code === 2 && /No sign-in code is waiting/.test(str(cliError(noPending).message)), said(noPending));
    const codeAlone = await accounts(env, ["login", "--code", "123456", "--json"], { home: freshDir() });
    results.check("--code alone: exit 2, says what it finishes", codeAlone.code === 2 && /--code finishes a code sign-in/.test(str(cliError(codeAlone).message)), said(codeAlone));
    const stkAlone = await accounts(env, ["login", "--stk", "stk-0123456789ab", "--json"], { home: freshDir() });
    results.check("--stk without --silicon: exit 2", stkAlone.code === 2 && /no si:id was given/.test(str(cliError(stkAlone).message)), said(stkAlone));
    const both = await accounts(env, ["login", "--silicon", "si:x-y-z", "--email", carbon.email, "--json"], { home: freshDir() });
    results.check("--silicon with --email: exit 2, the JSON error names the conflict", both.code === 2 && cliError(both).code === "invalid_arguments" && /cannot be used with/.test(str(cliError(both).message)), said(both));
    const carbonAsSilicon = await accounts(env, ["login", "--silicon", carbon.id, "--stk", "stk-0123456789ab", "--json"], { home: freshDir() });
    results.check("--silicon with a c:id: exit 2, a Carbon signs in with a code", carbonAsSilicon.code === 2 && /not a Silicon id/.test(str(cliError(carbonAsSilicon).message)), said(carbonAsSilicon));

    // 6. The Carbon's history (as the account site shows it).
    const entries = async (kind: string) => (obj((await asCarbon<Json>(env, carbon, "GET", `/v1/me/history?kind=${kind}&limit=100`)).body).items ?? []) as Json[];
    const security = await entries("security");
    const created = security.filter(item => item.title === "New CLI sign-in");
    results.check("each headless sign-in that got through is a 'New CLI sign-in' (its label · with an email code): three of them", created.length === 3 && created.every(item => / · with an email code$/.test(str(item.detail))), short(created.map(item => item.detail)));
    const lock = security.find(item => str(item.title).startsWith("Too many wrong codes"));
    results.check("the ten wrong codes: 'Too many wrong codes for <masked address>', paused until when", !!lock && /^Too many wrong codes for s\*+@example\.test$/.test(str(lock.title)) && /^After 10 wrong codes in a row, tries were paused until \d{4}-\d\d-\d\dT/.test(str(lock.detail)), short(lock));
    const failed = (await entries("signin")).filter(item => obj(item.meta).outcome === "failed");
    results.check("…recorded as a failed sign-in from the silicon-accounts CLI", failed.length >= 1 && failed.every(item => item.title === "Failed sign-in to Silicon Accounts with an email code" && /· silicon-accounts CLI \d+\.\d+\.\d+$/.test(str(item.detail))), short(failed.map(item => [item.title, item.detail])));

    // 7. The same by phone (`silicon-accounts login --phone`): another Carbon, whose phone was added and verified with the CLI.
    const phoned = await signUpCarbon(env, "headless-phone");
    const homeP = freshDir();
    await loginCarbon(env, homeP, phoned);
    const phone = await freshPhone(env);
    let seq = await lastSeq(env);
    const add = await accounts(env, ["phone", "add", phone, "--json"], { home: homeP });
    const addCode = await codeFor(env, phone, seq).catch(() => "");
    const verified = await accounts(env, ["phone", "verify", str(add.json?.challenge_id), addCode, "--json"], { home: homeP });
    results.check("setup: another Carbon adds and verifies a phone with the CLI (`silicon-accounts phone add` + `silicon-accounts phone verify`)", add.code === 0 && verified.code === 0, `${said(add)} | ${said(verified)}`);
    const homeQ = freshDir();
    seq = await lastSeq(env);
    const startP = await accounts(env, ["login", "--phone", phone, "--json"], { home: homeQ });
    results.check("`silicon-accounts login --phone <+E.164> --json`: exit 0, code_sent, the number masked, how to finish", startP.code === 0 && startP.json?.status === "code_sent" && startP.json?.authenticated === false && !str(startP.json?.destination).includes(phone) && str(startP.json?.next).includes("--code"), said(startP));
    const sms = await codeFor(env, phone, seq).catch(() => "");
    const finishP = await accounts(env, ["login", "--phone", phone, "--code", sms, "--json"], { home: homeQ });
    results.check("…the code from the text message (`--code`) signs the Carbon in", !!sms && finishP.code === 0 && finishP.json?.authenticated === true && finishP.json?.id === phoned.id && finishP.json?.kind === "carbon", said(finishP));
    const local = `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
    const homeR = freshDir();
    seq = await lastSeq(env);
    const startL = await accounts(env, ["login", "--phone", local, "--country", "US", "--json"], { home: homeR });
    const localCode = await codeFor(env, phone, seq).catch(() => "");
    const finishL = await accounts(env, ["login", "--phone", local, "--country", "US", "--code", localCode, "--json"], { home: homeR });
    results.check(`the same number written locally ("${local}" with --country US) reaches the same account`, startL.code === 0 && !!localCode && finishL.code === 0 && finishL.json?.id === phoned.id, `${said(startL)} | ${said(finishL)}`);
    const nobodyPhone = await accounts(env, ["login", "--phone", await freshPhone(env), "--json"], { home: freshDir() });
    results.check("a number no Carbon has: exit 4, account_not_found", nobodyPhone.code === 4 && cliError(nobodyPhone).code === "account_not_found", said(nobodyPhone));
    const emailAndPhone = await accounts(env, ["login", "--email", phoned.email, "--phone", phone, "--json"], { home: freshDir() });
    results.check("--email with --phone: exit 2, the JSON error names the conflict", emailAndPhone.code === 2 && /cannot be used with/.test(str(cliError(emailAndPhone).message)), said(emailAndPhone));
  },
};
