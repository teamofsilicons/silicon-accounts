import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { forgetRateLimits, json, sql, tag, type Env } from "../../lib";
import { ROOT, accounts, appSltLogin, asCarbon, cliError as cliErrorOf, freshDir, loginSilicon, obj, short, signUpCarbon, sinkUrl, str, type Carbon, type Json } from "./_helpers";

/** Every row of the stack's database, as pg_dump writes it (data only). */
function dump(env: Env): Promise<string> {
  return new Promise((done, fail) =>
    execFile(join(env.pgBin, "pg_dump"), ["--data-only", "--no-owner", "--no-privileges", env.db], { maxBuffer: 1024 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? fail(new Error(`pg_dump: ${stderr.trim() || error.message}`)) : done(stdout),
    ),
  );
}

/** The stack's logs (scripts/dev.sh: .dev/logs for 8590, .dev/logs/<base> for any other base). */
function stackLogs(env: Env): { files: string[]; text: string } {
  const dir = join(ROOT, ".dev", "logs", ...(env.base === 8590 ? [] : [String(env.base)]));
  const files = ["accounts-api.log", "web.log"].map(file => join(dir, file)).filter(path => existsSync(path));
  return { files, text: files.map(path => readFileSync(path, "utf8")).join("\n") };
}

/** A call as the Carbon (session cookie) with an Idempotency-Key, as the site's own pages make them. */
const withKey = (env: Env, carbon: Carbon, method: string, path: string, key: string, body: unknown) =>
  json<Json>(`${env.site}${path}`, {
    method,
    headers: { cookie: `sa_session=${carbon.session}`, origin: env.site, "content-type": "application/json", "idempotency-key": key, "x-forwarded-for": carbon.ip },
    body: JSON.stringify(body),
  });

export const journey: Journey = {
  name: "silicons-cli-secrets-at-rest",
  title: "only hashes are kept: a Silicon's STKs (generated and chosen, at creation and at rotation, answers kept for retries included), its request token, webhook secrets, SLTs and the tokens it and an app got are in no row of the database and no line of the API's or the site's logs",
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "secrets");
    const sid = `si:secret-${t}`;

    // 1. A Silicon creates its own account with the CLI (generated STK, request token, webhook secret), and the same
    //    command is retried with its idempotency key, so the service keeps the answer for the retry.
    const args = ["silicon", "create", "--id", sid, "--custodian", carbon.id, "--webhook", sinkUrl(env, `scli-secret-${t}`), "--idempotency-key", `scli-secret-${t}`, "--json"];
    const home = freshDir();
    const created = await accounts(env, args, { home });
    const retried = await accounts(env, args, { home: freshDir() });
    const generated = str(created.json?.stk);
    const requestToken = str(created.json?.request_token);
    const firstSecret = str(created.json?.webhook_secret);
    const uuid = str(obj(created.json?.silicon).uuid);
    const accepted = await asCarbon(env, carbon, "POST", `/v1/me/custodian-requests/${str(obj(created.json?.request).id)}/accept`, {});
    results.check(
      "setup: the Silicon creates its account (retried with its key: the same STK back), the Carbon accepts",
      created.code === 0 && retried.code === 0 && retried.json?.stk === generated && /^stk-[0-9a-f]{12}$/.test(generated) && requestToken.startsWith("sarq_") && firstSecret.startsWith("whsec_") && accepted.status === 204,
      `create exit ${created.code} ${short(cliErrorOf(created))} | retry ${retried.code} | accept ${accepted.status}`,
    );

    // 2. A custodian-made Silicon with a chosen STK of 32 hex digits, sent with an Idempotency-Key.
    const chosen = `stk-${randomBytes(16).toString("hex")}`;
    const own = await withKey(env, carbon, "POST", "/v1/me/silicons", `scli-secret-own-${t}`, { id: `si:secret-own-${t}`, display_name: "Secret own", stk: chosen });
    results.check("a custodian-made Silicon with a chosen STK (never echoed)", own.status === 201 && obj(own.body).stk === null, `${own.status}`);

    // 3. Sign-ins: the CLI's session, an SLT remind exchanges (remind's tokens), and an SLT nobody uses.
    const login = await loginSilicon(env, home, sid, generated);
    const session = JSON.parse(readFileSync(join(home, ".accounts", "session.json"), "utf8")) as Json;
    const slt = str((await accounts(env, ["login", "--app", "remind", "--json"], { home })).json?.slt);
    const remind = await appSltLogin(env, "remind", slt);
    const remindTokens = obj(remind.body.tokens);
    const unused = str((await accounts(env, ["login", "--app", "briefcase", "--json"], { home })).json?.slt);
    results.check("the Silicon signs in with the CLI, remind exchanges an SLT, another SLT stays unused", login.code === 0 && remind.body.ok === true && unused.startsWith("slt_") && !!remindTokens.refresh_token, `${login.code} ${short(remind.body.error)}`);

    // 4. A rotation sent with an Idempotency-Key (its answer, the new STK, kept for a retry), and a new webhook secret.
    const rotated = await withKey(env, carbon, "POST", `/v1/me/silicons/${uuid}/stk`, `scli-secret-rotate-${t}`, {});
    const rotatedAgain = await withKey(env, carbon, "POST", `/v1/me/silicons/${uuid}/stk`, `scli-secret-rotate-${t}`, {});
    const rotatedStk = str(obj(rotated.body).stk);
    const moved = await asCarbon<Json>(env, carbon, "PUT", `/v1/me/silicons/${uuid}/webhook`, { url: sinkUrl(env, `scli-secret-b-${t}`) });
    const secondSecret = str(moved.body.webhook_secret);
    results.check("the custodian rotates the STK (retried: the same new STK) and moves the webhook (a new secret)", rotated.status === 200 && str(obj(rotatedAgain.body).stk) === rotatedStk && /^stk-[0-9a-f]{12}$/.test(rotatedStk) && secondSecret.startsWith("whsec_"), `${rotated.status} ${rotatedAgain.status} ${moved.status}`);

    // 5. Where they are not.
    const secrets: Record<string, string> = {
      "the generated STK": generated,
      "the generated STK's hex": generated.slice(4),
      "the chosen STK's hex": chosen.slice(4),
      "the rotated STK's hex": rotatedStk.slice(4),
      "the request token": requestToken,
      "the first webhook secret": firstSecret,
      "the second webhook secret": secondSecret,
      "the used SLT": slt,
      "the unused SLT": unused,
      "the CLI's access token": str(session.access_token),
      "the CLI's refresh token": str(session.refresh_token),
      "remind's access token": str(remindTokens.access_token),
      "remind's refresh token": str(remindTokens.refresh_token),
    };
    const missing = Object.entries(secrets).filter(([, value]) => value.length < 8).map(([name]) => name);
    const data = await dump(env);
    const inDatabase = Object.entries(secrets).filter(([, value]) => value.length >= 8 && data.includes(value)).map(([name]) => name);
    results.check(
      `none of the ${Object.keys(secrets).length} secrets is in the database (a data dump of every table, the answers kept for retries included)`,
      missing.length === 0 && inDatabase.length === 0 && data.includes(uuid),
      `${Math.round(data.length / 1024)} KB dumped; found ${short(inDatabase)}; not collected ${short(missing)}`,
    );
    const logs = stackLogs(env);
    const inLogs = Object.entries(secrets).filter(([, value]) => value.length >= 8 && logs.text.includes(value)).map(([name]) => name);
    results.check("…nor in the API's or the site's logs", logs.files.some(path => path.endsWith("accounts-api.log")) && logs.text.length > 0 && inLogs.length === 0, `${logs.files.length} files, ${Math.round(logs.text.length / 1024)} KB; found ${short(inLogs)}`);
    const hashes = await sql(env, `select left(stk_hash, 10), webhook_secret_enc is not null from accounts where uuid = '${uuid}'`);
    results.check("what is kept is the STK's Argon2id hash and the webhook secret sealed", hashes[0]?.[0] === "$argon2id$" && hashes[0]?.[1] === "t", short(hashes));
  },
};
