import type { Journey } from "../context";
import { api, cli, cliHome, fakeApp, issueAppVerification, newContext, postJson, shot, sleep, verifyProof } from "../lib";

interface SaveAnswer {
  ok?: boolean;
  timings?: { issue_ms?: number; verify_ms?: number | null; call_ms?: number; total_ms?: number };
}

/** commit's notify demo: one App verification proof per receiving app (UNDERSTANDING.md), each pinged with its own proof. */
interface NotifyAnswer {
  ok?: boolean;
  proofs?: Record<string, { proof_id?: string; receiving_app?: unknown }>;
  results?: Record<string, { ok?: boolean; verification?: { valid?: boolean; receiving_app?: { app_id?: string } } }>;
  timings?: { issue_ms?: Record<string, number | null>; verify_ms?: Record<string, number | null>; total_ms?: number };
}

const spread = (values: number[]) => {
  if (!values.length) return "n/a";
  const sorted = [...values].sort((a, b) => a - b);
  return `${sorted[0]!.toFixed(1)}–${sorted[sorted.length - 1]!.toFixed(1)} ms (median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)})`;
};

const appIdOf = (value: unknown) => (typeof value === "string" ? value : value && typeof value === "object" ? (value as { app_id?: string }).app_id : undefined);

export const journey: Journey = {
  name: "e-proofs",
  title: "User verification dm → briefcase and App verification commit → remind and waveform (one proof per app) through the fake apps, with timings; an app verification proof is for exactly one app; the Carbon sees and revokes a user verification proof on /proofs",
  needs: ["brook"],
  async run(ctx) {
    const { env, results, browser, shared } = ctx;
    const brook = shared.brook!;
    const timings: Record<string, number[]> = {};
    const add = (name: string, value: number | null | undefined) => {
      if (typeof value === "number") (timings[name] ??= []).push(value);
    };

    // User verification: dm acts at briefcase on brook's behalf; briefcase verifies the proof with Silicon Accounts.
    for (let i = 0; i < 5; i++) {
      const answer = await postJson<SaveAnswer>(`${env.apps}/dm/actions/save-to-briefcase`, { uuid: brook.uuid, filename: `walk-${i}.txt` });
      if (i === 0) results.check("User verification: dm saves a file to briefcase on the Carbon's behalf (briefcase verified the proof)", answer.status === 200 && answer.body.ok === true, JSON.stringify(answer.body).slice(0, 200));
      add("user_verification issue", answer.body.timings?.issue_ms);
      add("user_verification verify", answer.body.timings?.verify_ms);
      add("user_verification call", answer.body.timings?.call_ms);
      add("user_verification total", answer.body.timings?.total_ms);
    }

    // App verification: commit talks to remind and waveform, so it gets two proofs, one for each, and each app verifies its own.
    for (let i = 0; i < 5; i++) {
      const answer = await postJson<NotifyAnswer>(`${env.apps}/commit/actions/notify`, { audiences: ["remind", "waveform"], message: `walk ${i}` });
      if (i === 0) {
        const proofs = answer.body.proofs ?? {};
        const ids = Object.values(proofs).map(proof => proof.proof_id);
        results.check("App verification: commit's notify gets one proof for remind and another for waveform", answer.status === 200 && answer.body.ok === true && ids.length === 2 && new Set(ids).size === 2 && appIdOf(proofs.remind?.receiving_app) === "remind" && appIdOf(proofs.waveform?.receiving_app) === "waveform", JSON.stringify(proofs).slice(0, 300));
        results.check("…and remind and waveform each verified the proof made for it", answer.body.results?.remind?.verification?.valid === true && answer.body.results?.waveform?.verification?.valid === true, JSON.stringify(answer.body.results).slice(0, 300));
      }
      for (const [audience, value] of Object.entries(answer.body.timings?.issue_ms ?? {})) add(`app_verification issue for ${audience}`, value);
      for (const [audience, value] of Object.entries(answer.body.timings?.verify_ms ?? {})) add(`app_verification verify by ${audience}`, value);
      add("app_verification total (two proofs in parallel)", answer.body.timings?.total_ms);
    }

    // The single-app rule, with commit's own credentials against the API.
    const issued = await issueAppVerification(ctx, "commit", "remind", { scopes: ["notifications.send"] });
    results.check("POST /v1/proofs/app-verification {receiving_app: remind} issues a proof for remind alone", (issued.status === 201 || issued.status === 200) && issued.body.kind === "app_verification" && appIdOf(issued.body.receiving_app) === "remind" && typeof issued.body.proof_token === "string", `${issued.status} ${JSON.stringify(issued.body).slice(0, 200)}`);
    add("app_verification issue (commit, through the site)", issued.ms);
    const byRemind = await verifyProof(ctx, "remind", issued.body.proof_token ?? "");
    results.check("remind verifies it: valid, issued by commit, for remind, with an expiry", byRemind.body.valid === true && appIdOf(byRemind.body.issuing_app) === "commit" && appIdOf(byRemind.body.receiving_app) === "remind" && typeof byRemind.body.expires_at === "string", JSON.stringify(byRemind.body).slice(0, 240));
    add("app_verification verify (remind, through the site)", byRemind.ms);
    const byWaveform = await verifyProof(ctx, "waveform", issued.body.proof_token ?? "");
    results.check("waveform (not its receiving app) is told exactly {valid:false, expires_at:null}", byWaveform.status === 200 && byWaveform.body.valid === false && byWaveform.body.expires_at === null && Object.keys(byWaveform.body).length === 2, JSON.stringify(byWaveform.body));
    const several = await api<{ error?: { code?: string; message?: string; hint?: string } }>(ctx, "/v1/proofs/app-verification", {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`commit:${fakeApp("commit").secret}`).toString("base64")}`, "idempotency-key": `e2e-several-${Date.now()}` },
      json: { audiences: ["remind", "waveform"] },
    });
    results.check("a proof for two apps at once is refused: 422 app_verification_single_app, naming the one-proof-per-app way", several.status === 422 && several.body.error?.code === "app_verification_single_app" && /receiving_app/.test(several.body.error?.hint ?? ""), `${several.status} ${JSON.stringify(several.body).slice(0, 300)}`);

    // The CLI the same way: `accounts app proof app-verification --to <app>` names exactly one app.
    const home = cliHome();
    const secret = `${fakeApp("commit").secret}\n`;
    const viaCli = await cli(env, home, ["app", "proof", "app-verification", "--to", "waveform", "--scope", "notifications.send", "--app-id", "commit", "--app-secret-stdin", "--json"], { stdin: secret });
    const cliToken = typeof viaCli.json?.proof_token === "string" ? viaCli.json.proof_token : "";
    results.check("`accounts app proof app-verification --to waveform` issues commit's proof for waveform", viaCli.code === 0 && viaCli.json?.receiving_app === "waveform" && viaCli.json.kind === "app_verification" && cliToken.startsWith("sap_"), `exit ${viaCli.code} in ${viaCli.ms} ms: ${JSON.stringify(viaCli.json).slice(0, 160)}`);
    results.check("…which waveform verifies", (await verifyProof(ctx, "waveform", cliToken)).body.valid === true);
    const twice = await cli(env, home, ["app", "proof", "app-verification", "--to", "remind", "--to", "waveform", "--app-id", "commit", "--app-secret-stdin", "--json"], { stdin: secret });
    const twiceError = (twice.json?.error ?? {}) as { message?: string };
    results.check("…and `--to` twice is refused, saying it takes one app", twice.code === 2 && /--to/.test(twiceError.message ?? ""), `exit ${twice.code}: ${JSON.stringify(twice.json).slice(0, 200)}`);

    results.check("timings (5 runs each, plus the single-app calls)", true, Object.entries(timings).map(([name, values]) => `${name} ${spread(values)}`).join("; "));
    for (const [name, values] of Object.entries(timings)) {
      const sorted = [...values].sort((a, b) => a - b);
      results.metric(`${name} median`, sorted[Math.floor(sorted.length / 2)]!);
      results.metric(`${name} max`, sorted[sorted.length - 1]!);
    }

    // The Carbon's /proofs page lists the proofs; revoking one there makes briefcase's verify answer "not valid".
    const user_verification = await postJson<{ body?: { proof_token?: string; proof_id?: string } }>(`${env.apps}/dm/actions/issue-user_verification`, { uuid: brook.uuid, receiving_app: "briefcase", scopes: ["files.write"] });
    const token = user_verification.body.body?.proof_token ?? "";
    const proofId = user_verification.body.body?.proof_id ?? "";
    const before = await postJson<{ verification?: { valid?: boolean } }>(`${env.apps}/briefcase/api/verify-proof`, { proof_token: token });
    results.check("briefcase verifies a fresh User verification proof as valid", before.body.verification?.valid === true);
    const context = await newContext(browser, { cookies: brook.cookies });
    const page = await context.newPage();
    results.watch(page, "e");
    await page.goto(`${env.site}/proofs`);
    await page.waitForLoadState("networkidle");
    await sleep(1200);
    await shot(env, page, "e-01-proofs", true);
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("/proofs lists dm → briefcase", /DM/.test(text) && /Briefcase/.test(text));
    // Cards are newest first: the first Revoke is the proof issued last.
    await page.getByRole("button", { name: /^Revoke/ }).first().click();
    // The card asks in place ("Revoke DM's proof?"); its own Revoke confirms.
    await page.getByRole("group", { name: /^Revoke .*\?$/ }).getByRole("button", { name: "Revoke", exact: true }).click({ timeout: 10_000 });
    await sleep(1500);
    const proofs = (await (await page.request.get(`${env.site}/v1/me/proofs?limit=200`)).json()) as { items: Array<{ proof_id: string; status: string }> };
    const mine = proofs.items.find(item => item.proof_id === proofId);
    results.check("the revoke on /proofs reached the proof", mine?.status === "revoked", String(mine?.status));
    const after = await postJson<{ verification?: unknown }>(`${env.apps}/briefcase/api/verify-proof`, { proof_token: token });
    results.check("briefcase's verify then answers exactly {valid:false, expires_at:null}", JSON.stringify(after.body.verification) === JSON.stringify({ expires_at: null, valid: false }) || JSON.stringify(after.body.verification) === JSON.stringify({ valid: false, expires_at: null }), JSON.stringify(after.body.verification));
    await context.close();
  },
};
