import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { MockMessagingClient } from '../lib/mocks.ts';
import { extractCodes, start, type MockMessaging } from '../src/mock-messaging.ts';
import { basic, postJson } from './helpers.ts';

const POSTMARK_TOKEN = '3f1c2a7e-0000-4000-8000-postmarktest';
const TWILIO = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'twilio-auth-token', messagingServiceSids: [`MG${'b'.repeat(32)}`], fromNumbers: ['+15005550006'] };

function otpEmail(to: string, code: string): Record<string, unknown> {
  return {
    From: 'Silicon Accounts <accounts@teamofsilicons.com>',
    To: to,
    Subject: `${code} is your Silicon Accounts code`,
    TextBody: `Your code is ${code}. It expires in 10 minutes.\nhttps://account.teamofsilicons.com/`,
    HtmlBody: `<p>Your code is <strong>${code}</strong></p>`,
    MessageStream: 'outbound',
  };
}

async function sendSms(base: string, form: Record<string, string>, auth = basic(TWILIO.accountSid, TWILIO.authToken), sid = TWILIO.accountSid): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/twilio/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: auth },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('mock-messaging', () => {
  let mock: MockMessaging;
  let client: MockMessagingClient;
  before(async () => {
    mock = await start({ port: 0, postmark: { serverTokens: [POSTMARK_TOKEN] }, twilio: TWILIO });
    client = new MockMessagingClient(mock.url);
  });
  after(() => mock.stop());
  beforeEach(() => client.reset());

  describe('Postmark', () => {
    test('a missing or wrong X-Postmark-Server-Token is 401 with ErrorCode 10', async () => {
      const missing = await postJson(`${mock.postmarkApiUrl}/email`, otpEmail('a@example.test', '123456'));
      assert.equal(missing.status, 401);
      assert.equal(missing.body.ErrorCode, 10);
      const wrong = await postJson(`${mock.postmarkApiUrl}/email`, otpEmail('a@example.test', '123456'), { 'X-Postmark-Server-Token': 'not-the-token' });
      assert.equal(wrong.status, 401);
      assert.equal(wrong.body.ErrorCode, 10);
      assert.equal((await client.messages()).length, 0);
      const rejected = await client.requests({ provider: 'postmark', outcome: 'rejected' });
      assert.equal(rejected.length, 2);
    });

    test('a valid send answers like Postmark and is captured with the extracted code', async () => {
      const res = await postJson(`${mock.postmarkApiUrl}/email`, otpEmail('Ada@Example.test', '482913'), { 'X-Postmark-Server-Token': POSTMARK_TOKEN });
      assert.equal(res.status, 200);
      assert.equal(res.body.ErrorCode, 0);
      assert.equal(res.body.Message, 'OK');
      assert.equal(res.body.To, 'Ada@Example.test');
      assert.match(String(res.body.MessageID), /^[0-9a-f-]{36}$/);
      const [message] = await client.messages({ to: 'ada@example.test', channel: 'email' });
      assert.equal(message?.code, '482913');
      assert.equal(message?.provider, 'postmark');
      assert.equal(message?.to, 'ada@example.test');
      assert.deepEqual(message?.links, ['https://account.teamofsilicons.com/']);
    });

    test('an unconfirmed sender, a missing body and bad JSON are 422 with Postmark error codes', async () => {
      const headers = { 'X-Postmark-Server-Token': POSTMARK_TOKEN };
      const sender = await postJson(`${mock.postmarkApiUrl}/email`, { ...otpEmail('a@example.test', '111111'), From: 'someone@else.test' }, headers);
      assert.equal(sender.status, 422);
      assert.equal(sender.body.ErrorCode, 400);
      const noBody = await postJson(`${mock.postmarkApiUrl}/email`, { From: 'accounts@teamofsilicons.com', To: 'a@example.test', Subject: 'x' }, headers);
      assert.equal(noBody.status, 422);
      assert.equal(noBody.body.ErrorCode, 300);
      const res = await fetch(`${mock.postmarkApiUrl}/email`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{not json' });
      assert.equal(res.status, 422);
      assert.equal(((await res.json()) as Record<string, unknown>).ErrorCode, 402);
    });

    test('several recipients: each one can be filtered on; batch sends capture every message', async () => {
      const headers = { 'X-Postmark-Server-Token': POSTMARK_TOKEN };
      await postJson(`${mock.postmarkApiUrl}/email`, { ...otpEmail('one@example.test, Two <two@example.test>', '222222'), Subject: 'Report' }, headers);
      assert.equal((await client.messages({ to: 'two@example.test' })).length, 1);
      const batch = await fetch(`${mock.postmarkApiUrl}/email/batch`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify([otpEmail('b1@example.test', '333333'), otpEmail('b2@example.test', '444444')]),
      });
      assert.equal(batch.status, 200);
      assert.equal(((await batch.json()) as unknown[]).length, 2);
      assert.equal((await client.latest({ to: 'b2@example.test' }))?.code, '444444');
    });
  });

  describe('Twilio', () => {
    test('wrong Basic credentials are 401 code 20003; an unknown account SID is 404', async () => {
      const bad = await sendSms(mock.url, { To: '+14155550123', Body: 'x', MessagingServiceSid: TWILIO.messagingServiceSids[0]! }, basic(TWILIO.accountSid, 'wrong'));
      assert.equal(bad.status, 401);
      assert.equal(bad.body.code, 20003);
      const wrongSid = await sendSms(mock.url, { To: '+14155550123', Body: 'x', MessagingServiceSid: TWILIO.messagingServiceSids[0]! }, basic(TWILIO.accountSid, TWILIO.authToken), `AC${'c'.repeat(32)}`);
      assert.equal(wrongSid.status, 404);
      assert.equal(wrongSid.body.code, 20404);
    });

    test('validation errors use Twilio error codes', async () => {
      const service = TWILIO.messagingServiceSids[0]!;
      assert.equal((await sendSms(mock.url, { Body: 'x', MessagingServiceSid: service })).body.code, 21604);
      assert.equal((await sendSms(mock.url, { To: '12345', Body: 'x', MessagingServiceSid: service })).body.code, 21211);
      assert.equal((await sendSms(mock.url, { To: '+14155550123', MessagingServiceSid: service })).body.code, 21602);
      assert.equal((await sendSms(mock.url, { To: '+14155550123', Body: 'x' })).body.code, 21603);
      assert.equal((await sendSms(mock.url, { To: '+14155550123', Body: 'x', MessagingServiceSid: `MG${'f'.repeat(32)}` })).body.code, 21701);
      assert.equal((await sendSms(mock.url, { To: '+14155550123', Body: 'x', From: '+19999999999' })).body.code, 21606);
    });

    test('a valid send returns a Message resource and is captured with the code', async () => {
      const res = await sendSms(mock.url, { To: '+14155550123', Body: 'Your Silicon Accounts code is 905112.\n\n@account.teamofsilicons.com #905112', MessagingServiceSid: TWILIO.messagingServiceSids[0]! });
      assert.equal(res.status, 201);
      assert.match(String(res.body.sid), /^SM[0-9a-f]{32}$/);
      assert.equal(res.body.status, 'accepted');
      assert.equal(res.body.to, '+14155550123');
      const fetched = await fetch(`${mock.url}${String(res.body.uri).replace('/2010-04-01', '/twilio/2010-04-01')}`, { headers: { Authorization: basic(TWILIO.accountSid, TWILIO.authToken) } });
      assert.equal(fetched.status, 200);
      assert.equal(await client.waitForCode({ to: '+1 (415) 555-0123', channel: 'phone' }), '905112');
      const viaFrom = await sendSms(mock.url, { To: '+14155550124', Body: 'code 111222', From: '+15005550006' });
      assert.equal(viaFrom.status, 201);
      assert.equal(viaFrom.body.status, 'queued');
    });
  });

  describe('inspection and faults', () => {
    test('/_messages filters by channel and lists newest first; wait resolves on arrival and times out with 408', async () => {
      const headers = { 'X-Postmark-Server-Token': POSTMARK_TOKEN };
      await postJson(`${mock.postmarkApiUrl}/email`, otpEmail('order@example.test', '100001'), headers);
      await postJson(`${mock.postmarkApiUrl}/email`, otpEmail('order@example.test', '100002'), headers);
      const list = await client.messages({ to: 'order@example.test' });
      assert.deepEqual(
        list.map((m) => m.code),
        ['100002', '100001'],
      );
      assert.equal((await client.messages({ to: 'order@example.test', channel: 'sms' })).length, 0);

      const after = await client.lastSeq();
      const waiting = client.waitForCode({ to: 'later@example.test', after, timeoutMs: 5_000 });
      setTimeout(() => void postJson(`${mock.postmarkApiUrl}/email`, otpEmail('later@example.test', '777888'), headers), 100);
      assert.equal(await waiting, '777888');

      const timeout = await fetch(`${mock.url}/_messages/wait?to=nobody@example.test&timeout_ms=150`);
      assert.equal(timeout.status, 408);
      const body = (await timeout.json()) as { error: { code: string; hint: string } };
      assert.equal(body.error.code, 'timeout');
      assert.match(body.error.hint, /ACCOUNTS_DELIVERY=providers/);
    });

    test('faults make the next N sends fail with the given status, then sends succeed again', async () => {
      await client.fault({ count: 2, status: 500, channel: 'email' });
      const headers = { 'X-Postmark-Server-Token': POSTMARK_TOKEN };
      const first = await postJson(`${mock.postmarkApiUrl}/email`, otpEmail('retry@example.test', '123123'), headers);
      const second = await postJson(`${mock.postmarkApiUrl}/email`, otpEmail('retry@example.test', '123123'), headers);
      const sms = await sendSms(mock.url, { To: '+14155550125', Body: 'code 999000', MessagingServiceSid: TWILIO.messagingServiceSids[0]! });
      const third = await postJson(`${mock.postmarkApiUrl}/email`, otpEmail('retry@example.test', '123123'), headers);
      assert.deepEqual([first.status, second.status, sms.status, third.status], [500, 500, 201, 200]);
      assert.equal((await client.messages({ to: 'retry@example.test' })).length, 1);
      assert.equal((await client.requests({ outcome: 'fault' })).length, 2);

      await client.fault({ count: 1, status: 429, channel: 'sms' });
      const limited = await sendSms(mock.url, { To: '+14155550126', Body: 'code 1', MessagingServiceSid: TWILIO.messagingServiceSids[0]! });
      assert.equal(limited.status, 429);
      assert.equal(limited.body.code, 20429);
    });

    test('a drop fault closes the connection without an answer', async () => {
      await client.fault({ count: 1, drop: true, channel: 'email' });
      await assert.rejects(fetch(`${mock.postmarkApiUrl}/email`, { method: 'POST', headers: { 'X-Postmark-Server-Token': POSTMARK_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(otpEmail('drop@example.test', '000111')) }));
    });

    test('DELETE /_messages clears captured messages (optionally by recipient)', async () => {
      const headers = { 'X-Postmark-Server-Token': POSTMARK_TOKEN };
      await postJson(`${mock.postmarkApiUrl}/email`, otpEmail('keep@example.test', '101010'), headers);
      await postJson(`${mock.postmarkApiUrl}/email`, otpEmail('drop@example.test', '202020'), headers);
      assert.equal(await client.clear({ to: 'drop@example.test' }), 1);
      assert.equal((await client.messages()).length, 1);
    });
  });

  test('extractCodes prefers plain 6-digit runs and ignores longer numbers', () => {
    assert.deepEqual(extractCodes('Call +14155550123 on 2026-10-06', 'code: 654321.'), ['654321']);
    assert.deepEqual(extractCodes('Your code is 123 456'), ['123456']);
    assert.deepEqual(extractCodes('no code here 12345 or 1234567'), []);
  });
});
