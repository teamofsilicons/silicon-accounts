/**
 * Double clicks and parallel requests on the hosted flow: every step that changes state is decided once (row locks),
 * the code limits hold exactly under a burst (an advisory lock per address), and two browsers that both proved the same
 * new address end with one account and a clean 409 for the slower one (never a 500, never a second account).
 */
import type { Journey } from "../../context";
import { lastSeq, randomIp, sql, tag } from "../../lib";
import { Browserish, brief, errorCode, errorDetails, nextCode, sendCode, startSignIn } from "./_helpers";

const races: Journey = {
  name: "auth-flows-double-submit",
  title: "double submits and bursts: two verifies, two sign-ups, two consents at once each happen once; 12 parallel sends to one address → exactly 10; 15 parallel wrong codes → exactly 10 counted; two browsers signing up one address → one account, a clean 409",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();

    // The same right code twice at once.
    const b = new Browserish(env, randomIp());
    const s = await startSignIn(b, "briefcase");
    const email = `double.${t}@example.test`;
    const sent = await sendCode(b, s.flow.id, { email });
    const verifies = await Promise.all([0, 1].map(() => b.act(s.flow.id, "verify", { code: sent.code ?? "" })));
    const codes = verifies.map(reply => `${reply.status}${reply.status === 200 ? "" : ` ${errorCode(reply)}`}`).sort();
    results.check("two verifies of the right code at once → one 200, one 409 (code_already_used / flow_changed)", verifies.filter(reply => reply.status === 200).length === 1 && verifies.some(reply => reply.status === 409), codes.join(", "));
    const sessions = await sql(env, `select count(*) from signup_sessions where verified_email = '${email}'`);
    results.check("…and only one sign-up session was opened", sessions[0]?.[0] === "1", JSON.stringify(sessions));

    // "Create account" twice at once.
    const signups = await Promise.all([0, 1].map(() => b.act(s.flow.id, "signup", {})));
    results.check("two sign-up submits at once → one 200, one 409", signups.filter(reply => reply.status === 200).length === 1 && signups.filter(reply => reply.status === 409).length === 1, signups.map(reply => `${reply.status} ${errorCode(reply) ?? ""}`).join(", "));
    const accounts = await sql(env, `select count(*) from account_emails where email = '${email}'`);
    results.check("…exactly one account has the address", accounts[0]?.[0] === "1", JSON.stringify(accounts));

    // "Share and continue" twice at once.
    const consents = await Promise.all([0, 1].map(() => b.act(s.flow.id, "consent", { approve: true, optional_scopes: [] })));
    results.check("two consents at once → one 200 (complete), one 409 flow_completed", consents.filter(reply => reply.status === 200).length === 1 && consents.some(reply => errorCode(reply) === "flow_completed"), consents.map(reply => `${reply.status} ${errorCode(reply) ?? ""}`).join(", "));
    const issued = await sql(env, `select count(*) from authorization_codes where flow_id = '${s.flow.id}'`);
    results.check("…and exactly one authorization code was issued for the flow", issued[0]?.[0] === "1", JSON.stringify(issued));

    // 12 sends to one address at the same moment (from 12 networks): the limit holds exactly.
    const burstAddress = `burst.${t}@example.test`;
    const senders = await Promise.all(Array.from({ length: 12 }, async () => {
      const sender = new Browserish(env, randomIp());
      const flow = await startSignIn(sender, "briefcase");
      return { sender, flow };
    }));
    const burst = await Promise.all(senders.map(({ sender, flow }) => sender.act(flow.flow.id, "email", { email: burstAddress })));
    const ok = burst.filter(reply => reply.status === 200).length;
    const limited = burst.filter(reply => reply.status === 429).length;
    results.check("12 sends to one address at once → exactly 10 sent, 2 refused with 429", ok === 10 && limited === 2, `${ok} sent, ${limited} limited, others: ${burst.filter(r => r.status !== 200 && r.status !== 429).map(r => brief(r)).join(" | ")}`);
    const stored = await sql(env, `select count(*) from otp_challenges where destination = '${burstAddress}'`);
    results.check("…and exactly 10 codes exist for it", stored[0]?.[0] === "10", JSON.stringify(stored));

    // 15 wrong codes at the same moment: counted one after another, the lock after exactly 10.
    const g = new Browserish(env, randomIp());
    const gs = await startSignIn(g, "briefcase");
    const guessAddress = `guess.${t}@example.test`;
    const guessSent = await sendCode(g, gs.flow.id, { email: guessAddress });
    const wrong = guessSent.code === "000000" ? "111111" : "000000";
    const guesses = await Promise.all(Array.from({ length: 15 }, () => g.act(gs.flow.id, "verify", { code: wrong })));
    const remaining = guesses.filter(reply => reply.status === 422).map(reply => Number(errorDetails(reply).remaining_attempts)).sort((a, b) => b - a);
    const locked = guesses.filter(reply => reply.status === 423).length;
    results.check("15 wrong codes at once → 10 counted (9…1 then 0) and 5 refused with 423", JSON.stringify(remaining) === JSON.stringify([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]) && locked === 5, `remaining ${JSON.stringify(remaining)}, ${locked} locked`);

    // Two browsers prove the same new address; both reach sign-up; the first creates the account.
    const shared = `both.${t}@example.test`;
    const first = new Browserish(env, randomIp());
    const second = new Browserish(env, randomIp());
    const f1 = await startSignIn(first, "briefcase");
    const f2 = await startSignIn(second, "commit");
    const c1 = await sendCode(first, f1.flow.id, { email: shared });
    const c2 = await sendCode(second, f2.flow.id, { email: shared });
    const v1 = await first.act(f1.flow.id, "verify", { code: c1.code ?? "" });
    const v2 = await second.act(f2.flow.id, "verify", { code: c2.code ?? "" });
    results.check("two browsers verify the same new address → both at signup", v1.body.flow?.step === "signup" && v2.body.flow?.step === "signup", `${brief(v1).slice(0, 60)} / ${brief(v2).slice(0, 60)}`);
    const made = await first.act(f1.flow.id, "signup", {});
    const late = await second.act(f2.flow.id, "signup", {});
    results.check("the first creates the account; the second's submit → 409 (id_taken or email_in_use), not 500", made.status === 200 && late.status === 409 && ["id_taken", "email_in_use"].includes(errorCode(late) ?? ""), `${made.status} / ${brief(late)}`);
    const fresh = await second.act(f2.flow.id, "signup", { id: `c:other-${t}` });
    results.check("…with a free id instead → 409 email_in_use (the address is the other account's now)", fresh.status === 409 && errorCode(fresh) === "email_in_use", brief(fresh));
    const count = await sql(env, `select count(distinct account_uuid) from account_emails where email = '${shared}'`);
    const orphan = await sql(env, `select count(*) from accounts where handle = 'c:other-${t}'`);
    results.check("…one account has the address and nothing half-made remains", count[0]?.[0] === "1" && orphan[0]?.[0] === "0", `${JSON.stringify(count)} ${JSON.stringify(orphan)}`);
    const switched = await second.act(f2.flow.id, "switch");
    const mark = await lastSeq(env);
    const resend = await second.act(f2.flow.id, "email", { email: shared });
    const again = await nextCode(env, shared, mark);
    const signedIn = await second.act(f2.flow.id, "verify", { code: again ?? "" });
    results.check("…the second browser then signs in to that account with a new code (consent for commit)", switched.status === 200 && resend.status === 200 && signedIn.status === 200 && signedIn.body.flow.step === "consent" && signedIn.body.flow.signed_in_as?.uuid === (await first.session())?.account.uuid, brief(signedIn));
  },
};

export const journeys: Journey[] = [races];
