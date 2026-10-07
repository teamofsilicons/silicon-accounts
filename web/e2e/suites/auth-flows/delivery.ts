/**
 * How a sign-in code travels (UNDERSTANDING.md "Email and phone verification"): email through Postmark, sent from
 * accounts@teamofsilicons.com; phone as an SMS through Twilio; 6 digits that live 10 minutes. The messages name the app
 * being signed into, carry nothing but the code to act on, and point at the account site, which UNDERSTANDING.md (as
 * edited on 2026-10-07) places at accounts.teamofsilicons.com.
 */
import type { Journey } from "../../context";
import { json, lastSeq, tag } from "../../lib";
import { Browserish, brief, randomPhone, sendCode, startSignIn } from "./_helpers";

interface Captured {
  channel: string;
  provider: string;
  to: string;
  from: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  code: string | null;
  codes: string[];
  links: string[];
  message_stream: string | null;
  messaging_service_sid: string | null;
}

async function lastMessageTo(env: Parameters<Journey["run"]>[0]["env"], to: string, after: number): Promise<Captured | null> {
  const reply = await json<{ items?: Captured[] }>(`${env.messaging}/_messages?to=${encodeURIComponent(to)}&after=${after}&limit=5`);
  return reply.body.items?.[0] ?? null;
}

const delivery: Journey = {
  name: "auth-flows-code-delivery",
  title: "sign-in codes: email through Postmark from accounts@teamofsilicons.com, SMS through Twilio; 6 digits, 10 minutes, the app's name, one code per message, and the account site named at accounts.teamofsilicons.com",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();

    // Email, signing in to briefcase.
    const b = new Browserish(env, ctx.ip);
    const email = `delivery.${t}@example.test`;
    const started = await startSignIn(b, "briefcase");
    const before = await lastSeq(env);
    const sent = await sendCode(b, started.flow.id, { email });
    results.check("the email code is sent", sent.reply.status === 200 && !!sent.code, sent.reply.status === 200 ? `200, code ${sent.code ? "received" : "missing"}` : brief(sent.reply));
    const mail = await lastMessageTo(env, email, before);
    results.check("…through Postmark (its outbound message stream)", mail?.channel === "email" && mail.provider === "postmark" && mail.message_stream === "outbound", `${mail?.channel} via ${mail?.provider}, stream ${mail?.message_stream}`);
    results.check("…sent from accounts@teamofsilicons.com", /(^|<)accounts@teamofsilicons\.com>?$/.test(mail?.from ?? ""), String(mail?.from));
    results.check("…with one 6-digit code (in the subject and the text)", /^\d{6}$/.test(mail?.code ?? "") && mail?.codes.length === 1 && (mail.subject ?? "").includes(mail.code ?? "-") && (mail.text ?? "").includes(mail.code ?? "-"), `${mail?.subject} | codes ${JSON.stringify(mail?.codes)}`);
    results.check("…naming the app (Briefcase) and the 10 minutes it lives", /Briefcase/.test(mail?.text ?? "") && /10 minutes/.test(mail?.text ?? ""), (mail?.text ?? "").replace(/\s+/g, " ").slice(0, 200));
    const siteLinks = [...(mail?.links ?? []), ...((mail?.text ?? "").match(/\baccounts?\.teamofsilicons\.com\b/g) ?? [])];
    results.check(
      "…and where it names the account site, it is accounts.teamofsilicons.com (UNDERSTANDING: \"the account site at accounts.teamofsilicons.com\")",
      siteLinks.every(link => /(^|\/\/|\b)accounts\.teamofsilicons\.com/.test(link)),
      JSON.stringify(siteLinks),
    );

    // SMS, signing in to dm.
    const p = new Browserish(env, ctx.ip);
    const phone = randomPhone();
    const dm = await startSignIn(p, "dm");
    const beforeSms = await lastSeq(env);
    const sentSms = await sendCode(p, dm.flow.id, { phone });
    results.check("the phone code is sent", sentSms.reply.status === 200 && !!sentSms.code, sentSms.reply.status === 200 ? `200, code ${sentSms.code ? "received" : "missing"}` : brief(sentSms.reply));
    const sms = await lastMessageTo(env, phone, beforeSms);
    results.check("…as an SMS through Twilio (a messaging service)", sms?.channel === "sms" && sms.provider === "twilio" && /^MG/.test(sms.messaging_service_sid ?? ""), `${sms?.channel} via ${sms?.provider}, ${sms?.messaging_service_sid}`);
    results.check("…with one 6-digit code, naming the app (DM) and the 10 minutes it lives", /^\d{6}$/.test(sms?.code ?? "") && sms?.codes.length === 1 && /\bDM\b/.test(sms.text ?? "") && /10 minutes/.test(sms.text ?? ""), String(sms?.text));
  },
};

export const journeys: Journey[] = [delivery];
