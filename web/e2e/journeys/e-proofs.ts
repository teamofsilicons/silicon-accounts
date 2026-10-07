import type { Journey } from "../context";
import { newContext, postJson, shot, sleep } from "../lib";

interface SaveAnswer {
  ok?: boolean;
  timings?: { issue_ms?: number; verify_ms?: number | null; call_ms?: number; total_ms?: number };
}

interface NotifyAnswer {
  ok?: boolean;
  timings?: { issue_ms?: number; total_ms?: number; verify_ms?: Record<string, number | null> };
}

const spread = (values: number[]) => {
  if (!values.length) return "n/a";
  const sorted = [...values].sort((a, b) => a - b);
  return `${sorted[0]!.toFixed(1)}–${sorted[sorted.length - 1]!.toFixed(1)} ms (median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)})`;
};

export const journey: Journey = {
  name: "e-proofs",
  title: "OBO dm → briefcase and ATA commit → remind + waveform through the fake apps (timings); the Carbon sees and revokes an OBO proof on /proofs",
  needs: ["brook"],
  async run({ env, results, browser, shared }) {
    const brook = shared.brook!;
    const timings: Record<string, number[]> = {};
    const add = (name: string, value: number | null | undefined) => {
      if (typeof value === "number") (timings[name] ??= []).push(value);
    };
    for (let i = 0; i < 5; i++) {
      const answer = await postJson<SaveAnswer>(`${env.apps}/dm/actions/save-to-briefcase`, { uuid: brook.uuid, filename: `walk-${i}.txt` });
      if (i === 0) results.check("OBO: dm saves a file to briefcase on the Carbon's behalf (briefcase verified the proof)", answer.status === 200 && answer.body.ok === true, JSON.stringify(answer.body).slice(0, 200));
      add("obo issue", answer.body.timings?.issue_ms);
      add("obo verify", answer.body.timings?.verify_ms);
      add("obo call", answer.body.timings?.call_ms);
      add("obo total", answer.body.timings?.total_ms);
    }
    for (let i = 0; i < 5; i++) {
      const answer = await postJson<NotifyAnswer>(`${env.apps}/commit/actions/notify`, { audiences: ["remind", "waveform"], message: `walk ${i}` });
      if (i === 0) results.check("ATA: commit's one proof is verified by remind and waveform", answer.status === 200 && answer.body.ok === true, JSON.stringify(answer.body).slice(0, 200));
      add("ata issue", answer.body.timings?.issue_ms);
      add("ata total", answer.body.timings?.total_ms);
      for (const [audience, value] of Object.entries(answer.body.timings?.verify_ms ?? {})) add(`ata verify ${audience}`, value);
    }
    results.check("timings (5 runs each)", true, Object.entries(timings).map(([name, values]) => `${name} ${spread(values)}`).join("; "));
    for (const [name, values] of Object.entries(timings)) {
      const sorted = [...values].sort((a, b) => a - b);
      results.metric(`${name} median`, sorted[Math.floor(sorted.length / 2)]!);
      results.metric(`${name} max`, sorted[sorted.length - 1]!);
    }

    // The Carbon's /proofs page lists the proofs; revoking one there makes briefcase's verify answer "not valid".
    const issued = await postJson<{ body?: { proof_token?: string; proof_id?: string } }>(`${env.apps}/dm/actions/issue-obo`, { uuid: brook.uuid, receiving_app: "briefcase", scopes: ["files.write"] });
    const token = issued.body.body?.proof_token ?? "";
    const proofId = issued.body.body?.proof_id ?? "";
    const before = await postJson<{ verification?: { valid?: boolean } }>(`${env.apps}/briefcase/api/verify-proof`, { proof_token: token });
    results.check("briefcase verifies a fresh OBO proof as valid", before.body.verification?.valid === true);
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
