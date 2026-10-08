import type { Journey } from "../../context";
import { forgetRateLimits, tag } from "../../lib";
import { accounts, asCarbon, cliError, freshDir, loginCarbon, obj, pool, said, selfCreate, short, signUpCarbon, siliconLogin, str, type Json } from "./_helpers";

/** `n` hex digits, mixed so no two lengths share a prefix pattern. */
const hex = (n: number, seed: string) => Array.from({ length: n }, (_, i) => "0123456789abcdef"[(i * 7 + seed.charCodeAt(i % seed.length)) % 16]).join("");

const fieldProblem = (body: unknown) => str(obj(obj(obj(obj(body).error).details).fields).stk);

export const journey: Journey = {
  name: "silicons-cli-stk-lengths",
  title: "self-set STKs: 8 to 32 hex digits are accepted (each one then signs its Silicon in), 7 and 33 are refused with a precise message, by the API (custodian create, self-create, rotation), the CLI and sign-in; case and the stk- prefix are normalized",
  // No browser: the CLI and the API only, so the engine changes nothing (the browser journeys run in WebKit too).
  engines: ["chromium"],
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "lengths");
    const lengths = Array.from({ length: 25 }, (_, i) => i + 8);

    // 1. The custodian creates one Silicon per length, 8..32; each chosen STK then signs its Silicon in.
    const made = await pool(lengths, 5, async length => {
      const stk = `stk-${hex(length, t)}`;
      const answer = await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: `si:len${length}-${t}`, display_name: `Length ${length}`, stk });
      const login = answer.status === 201 ? await siliconLogin(ctx, `si:len${length}-${t}`, stk) : null;
      return { length, status: answer.status, echoed: obj(answer.body).stk, login: login?.status ?? 0 };
    });
    const accepted = made.filter(entry => entry.status === 201 && entry.echoed === null);
    const signedIn = made.filter(entry => entry.login === 200);
    results.check("every length from 8 to 32 hex digits is accepted (25 Silicons), and never echoed back", accepted.length === 25, short(made.filter(entry => entry.status !== 201 || entry.echoed !== null)));
    results.check("…and each chosen STK signs its Silicon in", signedIn.length === 25, short(made.filter(entry => entry.login !== 200).map(entry => [entry.length, entry.login])));
    for (const length of [7, 33]) {
      const answer = await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: `si:len${length}-${t}`, display_name: `Length ${length}`, stk: `stk-${hex(length, t)}` });
      results.check(`${length} hex digits are refused: 422 validation_failed, the stk field says it has ${length}`, answer.status === 422 && str(obj(obj(answer.body).error).code) === "validation_failed" && fieldProblem(answer.body).includes(`has ${length} hexadecimal characters`), `${answer.status} ${fieldProblem(answer.body)}`);
    }
    const notHex = await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: `si:lenx-${t}`, display_name: "Not hex", stk: "stk-0123456789xyz" });
    results.check("a non-hex character is refused and named", notHex.status === 422 && fieldProblem(notHex.body).includes("'x'"), fieldProblem(notHex.body));
    const listed = await asCarbon<Json>(env, carbon, "GET", "/v1/me/silicons?limit=100");
    results.check("no Silicon was created for a refused STK", !((obj(listed.body).items ?? []) as Json[]).some(item => /^si:len(7|33|x)-/.test(str(item.id))));

    // 2. Normalization: upper case and the bare hex both sign in.
    const eight = `stk-${hex(8, t)}`;
    const upper = await siliconLogin(ctx, `si:len8-${t}`, eight.toUpperCase());
    const bare = await siliconLogin(ctx, `si:len8-${t}`, eight.slice(4));
    results.check("sign-in normalizes the STK: STK-… in upper case and the bare hex both work", upper.status === 200 && bare.status === 200, `${upper.status}/${bare.status}`);
    const loginShort = await siliconLogin(ctx, `si:len8-${t}`, "stk-1234567");
    results.check("signing in with a 7-digit STK: 422 invalid_stk, nothing is checked", loginShort.status === 422 && str(obj(loginShort.body.error).code) === "invalid_stk", short(loginShort.body));

    // 3. A Silicon creating its own account: same rule.
    for (const length of [7, 33]) {
      const answer = await selfCreate(ctx, { id: `si:self${length}-${t}`, display_name: "Self", custodian: carbon.id, stk: hex(length, t) });
      results.check(`self-create with ${length} hex digits: 422, said precisely`, answer.status === 422 && fieldProblem(answer.body).includes(`has ${length} hexadecimal characters`), `${answer.status} ${fieldProblem(answer.body)}`);
    }
    for (const length of [8, 32]) {
      const stk = hex(length, `${t}self`);
      const answer = await selfCreate(ctx, { id: `si:self${length}-${t}`, display_name: "Self", custodian: carbon.id, stk });
      const right = await siliconLogin(ctx, `si:self${length}-${t}`, `stk-${stk}`);
      const wrong = await siliconLogin(ctx, `si:self${length}-${t}`, `stk-${"f".repeat(length)}`);
      results.check(`self-create with ${length} hex digits (bare): 201, the STK is not echoed; it verifies (403 custodian_pending, while a wrong one is 401)`, answer.status === 201 && answer.body.stk === null && right.status === 403 && str(obj(right.body.error).code) === "custodian_pending" && wrong.status === 401, `${answer.status} ${right.status} ${wrong.status}`);
    }

    // 4. Rotation: same rule.
    const target = `si:len12-${t}`;
    for (const length of [7, 33]) {
      const answer = await asCarbon<Json>(env, carbon, "POST", `/v1/me/silicons/${encodeURIComponent(target)}/stk`, { stk: `stk-${hex(length, "rot")}` });
      results.check(`rotating to ${length} hex digits: 422`, answer.status === 422 && fieldProblem(answer.body).includes(`has ${length} hexadecimal characters`), `${answer.status} ${fieldProblem(answer.body)}`);
    }
    for (const length of [8, 32]) {
      const stk = `stk-${hex(length, `rot${length}`)}`;
      const answer = await asCarbon<Json>(env, carbon, "POST", `/v1/me/silicons/${encodeURIComponent(target)}/stk`, { stk });
      const login = await siliconLogin(ctx, target, stk);
      results.check(`rotating to ${length} hex digits: done, and it signs in`, answer.status === 200 && obj(answer.body).stk === null && login.status === 200, `${answer.status} ${login.status}`);
    }

    // 5. The CLI checks the shape before sending anything.
    const home = freshDir();
    await loginCarbon(env, home, carbon);
    for (const length of [7, 33]) {
      const create = await accounts(env, ["silicon", "create", "--id", `si:cli${length}-${t}`, "--stk-stdin", "--json"], { home, stdin: `stk-${hex(length, t)}\n` });
      results.check(`\`silicon-accounts silicon create --stk-stdin\` with ${length} hex digits: exit 2, says it got ${length}`, create.code === 2 && cliError(create).code === "invalid_input" && str(cliError(create).message).includes(`got ${length} characters`), said(create));
      const rotate = await accounts(env, ["silicon", "rotate-stk", target, "--stk-stdin", "--json"], { home, stdin: `stk-${hex(length, t)}\n` });
      results.check(`\`silicon-accounts silicon rotate-stk --stk-stdin\` with ${length}: exit 2`, rotate.code === 2 && cliError(rotate).code === "invalid_input", said(rotate));
      const login = await accounts(env, ["login", "--silicon", target, "--stk-stdin", "--json"], { home: freshDir(), stdin: `stk-${hex(length, t)}\n` });
      results.check(`\`silicon-accounts login --silicon --stk-stdin\` with ${length}: exit 2 before any request`, login.code === 2 && cliError(login).code === "invalid_input", said(login));
    }
    for (const length of [8, 32]) {
      const stk = `stk-${hex(length, `cli${length}`)}`;
      const create = await accounts(env, ["silicon", "create", "--id", `si:cli${length}-${t}`, "--stk-stdin", "--json"], { home, stdin: `${stk.toUpperCase().replace("STK-", "")}\n` });
      const login = await accounts(env, ["login", "--silicon", `si:cli${length}-${t}`, "--stk-stdin", "--json"], { home: freshDir(), stdin: `${stk}\n` });
      results.check(`\`silicon-accounts silicon create --stk-stdin\` with ${length} hex digits (bare, upper case): created, not echoed, signs in`, create.code === 0 && !create.json?.stk && !create.stdout.toLowerCase().includes(stk.slice(4)) && login.code === 0, `${said(create)} | ${said(login)}`);
    }
    const metrics = made.map(entry => entry.length);
    results.metric("chosen-STK Silicons created and signed in", metrics.length, "count");
  },
};
