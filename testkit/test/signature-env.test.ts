import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { accountsEnvForMocks, toDotenv, toShellExports } from '../lib/env.ts';
import { codeChallengeS256, createPkcePair, pkceMatches } from '../lib/pkce.ts';
import { computeWebhookSignature, parseSignatureHeader, signWebhookDelivery, verifyWebhookSignature, webhookSignatureHeader } from '../lib/signature.ts';

describe('webhook signatures', () => {
  const secret = 'whsec_xp1TbBVqPjD74gtqOKEkhRvHYvz8rtBjWjoUxEdLmn0';
  const body = '{"event_id":"0192f0aa-0000-7000-8000-000000000001","type":"ping","data":{}}';

  test('v1 = hex HMAC-SHA256(secret, "{timestamp}.{raw body}")', () => {
    const expected = createHmac('sha256', secret).update(`1791230400.${body}`).digest('hex');
    assert.equal(computeWebhookSignature(secret, 1791230400, body), expected);
    assert.equal(webhookSignatureHeader(secret, '1791230400', Buffer.from(body)), `v1=${expected}`);
  });

  test('verification accepts a fresh delivery and refuses tampering, wrong secrets and stale timestamps', () => {
    const now = 1_791_230_400;
    const header = webhookSignatureHeader(secret, now, body);
    assert.equal(verifyWebhookSignature({ secrets: secret, timestamp: String(now), signature: header, rawBody: body, nowSeconds: now + 10 }).ok, true);
    const cases: Array<[string, Parameters<typeof verifyWebhookSignature>[0]]> = [
      ['signature_mismatch', { secrets: secret, timestamp: String(now), signature: header, rawBody: body.replace('ping', 'pong'), nowSeconds: now }],
      ['signature_mismatch', { secrets: 'whsec_other', timestamp: String(now), signature: header, rawBody: body, nowSeconds: now }],
      ['timestamp_out_of_tolerance', { secrets: secret, timestamp: String(now), signature: header, rawBody: body, nowSeconds: now + 301 }],
      ['missing_signature', { secrets: secret, timestamp: String(now), signature: undefined, rawBody: body, nowSeconds: now }],
      ['missing_timestamp', { secrets: secret, timestamp: null, signature: header, rawBody: body, nowSeconds: now }],
      ['invalid_timestamp', { secrets: secret, timestamp: '2026-10-06', signature: header, rawBody: body, nowSeconds: now }],
      ['no_v1_signature', { secrets: secret, timestamp: String(now), signature: 'v0=abc', rawBody: body, nowSeconds: now }],
      ['no_secret', { secrets: [null, ''], timestamp: String(now), signature: header, rawBody: body, nowSeconds: now }],
    ];
    for (const [reason, options] of cases) {
      const result = verifyWebhookSignature(options);
      assert.equal(result.ok, false, reason);
      if (!result.ok) assert.equal(result.reason, reason);
    }
  });

  test('several v1 values and a previous secret (rotation) are supported', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = `v1=${'0'.repeat(64)}, ${webhookSignatureHeader('whsec_old', now, body)}`;
    assert.deepEqual(parseSignatureHeader(header).length, 2);
    assert.equal(verifyWebhookSignature({ secrets: ['whsec_new', 'whsec_old'], timestamp: String(now), signature: header, rawBody: body }).ok, true);
  });

  test('signWebhookDelivery builds every header Accounts sends', () => {
    const delivery = signWebhookDelivery(secret, { event_id: 'e1', type: 'ping', data: {} }, { timestamp: 1_791_230_400, deliveryId: 'd1' });
    assert.equal(delivery.headers['X-Accounts-Event-Id'], 'e1');
    assert.equal(delivery.headers['X-Accounts-Event-Type'], 'ping');
    assert.equal(delivery.headers['X-Accounts-Delivery-Id'], 'd1');
    assert.equal(delivery.headers['User-Agent'], 'SiliconAccounts-Webhooks/1');
    assert.equal(delivery.headers['X-Accounts-Signature'], webhookSignatureHeader(secret, 1_791_230_400, delivery.body));
  });
});

describe('PKCE', () => {
  test('S256 challenge matches RFC 7636 appendix B', () => {
    assert.equal(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  test('pairs verify; plain is supported', () => {
    const pair = createPkcePair();
    assert.equal(pair.code_verifier.length, 43);
    assert.ok(pkceMatches(pair.code_verifier, pair.code_challenge));
    const plain = createPkcePair('plain');
    assert.equal(plain.code_challenge, plain.code_verifier);
  });
});

describe('Accounts env for the mocks', () => {
  const env = accountsEnvForMocks({ oidcUrl: 'http://127.0.0.1:18591', messagingUrl: 'http://127.0.0.1:18592/' });

  test('points every provider URL at the mocks', () => {
    assert.equal(env.ACCOUNTS_GOOGLE_AUTH_URL, 'http://127.0.0.1:18591/google/authorize');
    assert.equal(env.ACCOUNTS_GOOGLE_TOKEN_URL, 'http://127.0.0.1:18591/google/token');
    assert.equal(env.ACCOUNTS_GOOGLE_JWKS_URL, 'http://127.0.0.1:18591/google/jwks');
    assert.equal(env.ACCOUNTS_GOOGLE_ISSUERS, 'http://127.0.0.1:18591/google');
    assert.equal(env.ACCOUNTS_APPLE_ISSUER, 'http://127.0.0.1:18591/apple');
    assert.equal(env.ACCOUNTS_POSTMARK_API_URL, 'http://127.0.0.1:18592/postmark');
    assert.equal(env.ACCOUNTS_TWILIO_API_URL, 'http://127.0.0.1:18592/twilio');
    assert.equal(env.ACCOUNTS_DELIVERY, 'providers');
  });

  test('the .env rendering round-trips through Node --env-file, and the shell rendering through bash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'testkit-env-'));
    try {
      const withDollar = { ...env, TESTKIT_DOLLAR: 'a$b"c\\d' };
      writeFileSync(join(dir, '.env'), toDotenv(env));
      const fromNode = execFileSync(process.execPath, [`--env-file=${join(dir, '.env')}`, '-e', 'process.stdout.write(process.env.ACCOUNTS_APPLE_PRIVATE_KEY)']).toString();
      assert.equal(fromNode, env.ACCOUNTS_APPLE_PRIVATE_KEY);
      writeFileSync(join(dir, 'env.sh'), toShellExports(withDollar));
      const fromBash = execFileSync('bash', ['-c', `. ${join(dir, 'env.sh')}; printf '%s' "$ACCOUNTS_APPLE_PRIVATE_KEY"; printf '|%s' "$TESTKIT_DOLLAR"`]).toString();
      assert.equal(fromBash, `${env.ACCOUNTS_APPLE_PRIVATE_KEY}|a$b"c\\d`);
      assert.match(toDotenv({ X: 'a$b' }), /X="a\\\$b"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
