// App mode of the CLI, with the app's credentials and as the app's owner: app details and sign-in
// setup (patch, conflicts, validation, history), code exchange, users, introspect/verify/userinfo,
// refresh, OBO/ATA proofs, webhooks (test, deliveries, replay, rotate, set), imports, revoke.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  check,
  cliLoginEmail,
  codeFrom,
  codeStep,
  done,
  driveFlow,
  FakeAppsClient,
  fakeApp,
  fakeAppsUrl,
  importFixturePath,
  messaging,
  newBrowser,
  newHome,
  randomEmail,
  rid,
  run,
  section,
  startAppSignIn,
} from './_common.ts';

const fake = new FakeAppsClient(fakeAppsUrl);
const home = newHome('app');
await run('app use briefcase --secret-stdin', home, ['app', 'use', 'briefcase', '--secret-stdin'], (r) => r.code === 0, { stdin: fakeApp('briefcase').secret });

section('app details and sign-in setup');
await run('app show', home, ['app', 'show'], (r) => r.json?.app_id === 'briefcase' && typeof r.json?.config_version === 'number' && r.json?.stats?.users >= 0);
const cfg = await run('app config get', home, ['app', 'config', 'get'], (r) => Array.isArray(r.json?.signin_config?.redirect_uris));
const patch = join(home, 'patch.json');
writeFileSync(patch, JSON.stringify({ copy: { title: `Briefcase ${rid()}` } }));
await run('app config set <file>', home, ['app', 'config', 'set', patch]);
await run('app config set - with a stale --expected-version → exit 5 config_version_conflict', home, ['app', 'config', 'set', '-', '--expected-version', String(cfg.json?.config_version ?? 0)], (r) => r.code === 5 && r.json?.error?.code === 'config_version_conflict', { stdin: '{"copy":{"subtitle":"x"}}' });
await run('app config set with an invalid radius → exit 2 validation_failed', home, ['app', 'config', 'set', '-'], (r) => r.code === 2 && r.json?.error?.code === 'validation_failed' && !!r.json?.error?.details?.fields, { stdin: '{"branding":{"radius":99}}' });
await run('app config history', home, ['app', 'config', 'history'], (r) => (r.json?.items ?? []).length >= 1);

section('a Carbon signs in through the hosted flow; the CLI exchanges the code');
const browser = await newBrowser();
const s = await startAppSignIn('briefcase', browser);
let flow = await codeStep(browser, s.flow, { email: randomEmail('app') });
flow = await driveFlow(browser, flow, { messaging });
const code = codeFrom(flow);
const ex = await run('app token exchange (code + PKCE verifier)', home, ['app', 'token', 'exchange', '--code', code, '--redirect-uri', s.az.redirect_uri, '--code-verifier', s.az.code_verifier ?? ''], (r) => typeof r.json?.access_token === 'string' && String(r.json?.account?.membership_id).startsWith('briefcase:'));
const uuid = String(ex.json?.account?.uuid);
await run('app users --q <uuid>', home, ['app', 'users', '--q', uuid], (r) => JSON.stringify(r.json).includes(uuid));
await run('app users --status active --kind carbon --limit 5', home, ['app', 'users', '--status', 'active', '--kind', 'carbon', '--limit', '5']);
await run('app user <uuid>', home, ['app', 'user', uuid], (r) => r.json?.uuid === uuid && Array.isArray(r.json?.history));
await run('app token introspect', home, ['app', 'token', 'introspect', ex.json?.access_token], (r) => r.json?.active === true && r.json?.sub === uuid && r.json?.client_id === 'briefcase');
await run('app token verify (local JWKS)', home, ['app', 'token', 'verify', ex.json?.access_token], (r) => r.code === 0);
await run('app userinfo', home, ['app', 'userinfo', ex.json?.access_token], (r) => r.json?.sub === uuid && typeof r.json?.email === 'string');
const rt = await run('app token refresh', home, ['app', 'token', 'refresh', ex.json?.refresh_token], (r) => typeof r.json?.refresh_token === 'string' && r.json.refresh_token !== ex.json?.refresh_token);
await run('app lookup <uuid>', home, ['app', 'lookup', uuid], (r) => r.json?.uuid === uuid);

section('proofs');
const dmEnv = { ACCOUNTS_APP_ID: 'dm', ACCOUNTS_APP_SECRET: fakeApp('dm').secret };
const dmHome = newHome('app-dm');
const obo = await run('app proof obo --to dm', home, ['app', 'proof', 'obo', '--subject-token', rt.json?.access_token, '--to', 'dm', '--scope', 'files.read', '--ttl', '600'], (r) => /^sap_/.test(r.json?.proof_token ?? '') && r.json?.user?.uuid === uuid);
await run('app proof verify as dm (the audience) → exit 0', dmHome, ['app', 'proof', 'verify', obo.json?.proof_token], (r) => r.code === 0 && r.json?.valid === true, { env: dmEnv });
await run('app proof verify as briefcase (not the audience) → exit 2 {valid:false, expires_at:null}', home, ['app', 'proof', 'verify', obo.json?.proof_token], (r) => r.code === 2 && r.json?.valid === false && r.json?.expires_at === null);
const pr = await run('app proof refresh', home, ['app', 'proof', 'refresh', obo.json?.proof_refresh_token], (r) => /^sap_/.test(r.json?.proof_token ?? ''));
await run('app proof list --kind obo', home, ['app', 'proof', 'list', '--kind', 'obo'], (r) => (r.json?.items ?? []).some((p: any) => p.proof_id === obo.json?.proof_id && p.status === 'active'));
await run('app proof revoke <id>', home, ['app', 'proof', 'revoke', obo.json?.proof_id]);
await run('verify after revoke → exit 2', dmHome, ['app', 'proof', 'verify', pr.json?.proof_token], (r) => r.code === 2, { env: dmEnv });
const ata = await run('app proof ata --to remind,waveform', home, ['app', 'proof', 'ata', '--to', 'remind,waveform'], (r) => /^sap_/.test(r.json?.proof_token ?? ''));
await run('app proof revoke --token', home, ['app', 'proof', 'revoke', '--token', ata.json?.proof_token]);

section('webhooks');
await run('app webhook test', home, ['app', 'webhook', 'test'], (r) => typeof r.json?.event_id === 'string');
const dels = await run('app webhook deliveries', home, ['app', 'webhook', 'deliveries', '--limit', '5'], (r) => (r.json?.items ?? []).length > 0);
const did = String((dels.json?.items ?? [])[0]?.id);
await run('app webhook delivery <id>', home, ['app', 'webhook', 'delivery', did], (r) => r.json?.delivery?.id === did);
await run('app webhook replay <id>', home, ['app', 'webhook', 'replay', did]);
const rot = await run('app webhook rotate', home, ['app', 'webhook', 'rotate'], (r) => /^whsec_/.test(r.json?.secret ?? ''));
await fake.setWebhookSecret('briefcase', rot.json?.secret ?? null, true);
const set = await run('app webhook set <url>', home, ['app', 'webhook', 'set', `${fakeAppsUrl}/briefcase/webhooks`], (r) => /^whsec_/.test(r.json?.secret ?? '') && r.json?.url === `${fakeAppsUrl}/briefcase/webhooks`);
await fake.setWebhookSecret('briefcase', set.json?.secret ?? null, true);
const ping = await run('app webhook test after re-set', home, ['app', 'webhook', 'test'], (r) => typeof r.json?.event_id === 'string');
check(((await fake.waitForEvent('briefcase', { type: 'ping', timeoutMs: 15_000 }).catch((e) => ({ error: String(e) }))) as any).event_id !== undefined, `the ping ${ping.json?.event_id} reached briefcase with the new secret`);

section('code reuse revokes what the code issued; revoke');
await run('the same code again → invalid_grant', home, ['app', 'token', 'exchange', '--code', code, '--redirect-uri', s.az.redirect_uri, '--code-verifier', s.az.code_verifier ?? ''], (r) => r.code !== 0 && JSON.stringify(r.json).includes('invalid_grant'));
await run('…and the tokens from it are dead (introspect → exit 2)', home, ['app', 'token', 'introspect', rt.json?.access_token], (r) => r.code === 2 && r.json?.active === false);

section('imports (legacy-crm credentials)');
{
  const env = { ACCOUNTS_APP_ID: 'legacy-crm', ACCOUNTS_APP_SECRET: fakeApp('legacy-crm').secret };
  const h2 = newHome('app-lc');
  const dry = await run('app import dirty.json --dry-run --wait', h2, ['app', 'import', importFixturePath('dirty.json'), '--dry-run', '--wait'], (r) => r.json?.status === 'completed' && r.json?.dry_run === true, { env });
  const job = String(dry.json?.id);
  await run('app import list', h2, ['app', 'import', 'list'], (r) => JSON.stringify(r.json).includes(job), { env });
  await run('app import status <job>', h2, ['app', 'import', 'status', job], (r) => r.json?.id === job, { env });
  await run('app import rows <job> --outcome error', h2, ['app', 'import', 'rows', job, '--outcome', 'error'], (r) => (r.json?.items ?? []).length > 0 && (r.json?.items ?? []).every((x: any) => x.outcome === 'error'), { env });
  await run('unknown columns → exit 2 unknown_columns', h2, ['app', 'import', importFixturePath('unknown-columns.csv')], (r) => r.code === 2 && r.json?.error?.code === 'unknown_columns', { env });
}

section("owner mode: c:saket manages briefcase with a session, not the secret");
{
  const ho = newHome('app-owner');
  await cliLoginEmail(ho, 'saketdev12@example.test');
  await run('app list (owned apps)', ho, ['app', 'list'], (r) => JSON.stringify(r.json).includes('"briefcase"'));
  await run('app show --app-id briefcase', ho, ['app', 'show', '--app-id', 'briefcase'], (r) => r.json?.app_id === 'briefcase' && r.json?.acting_as !== undefined);
  await run('app users --app-id briefcase', ho, ['app', 'users', '--app-id', 'briefcase', '--limit', '3']);
  await run('app webhook deliveries --app-id briefcase', ho, ['app', 'webhook', 'deliveries', '--app-id', 'briefcase', '--limit', '2']);
  await run('app proof ata as owner (the ATA page)', ho, ['app', 'proof', 'ata', '--app-id', 'briefcase', '--to', 'dm'], (r) => /^sap_/.test(r.json?.proof_token ?? ''));
  await run("someone else's app → exit 3 not_app_owner", ho, ['app', 'show', '--app-id', 'acme-notes'], (r) => r.code === 3 && r.json?.error?.code === 'not_app_owner');
}

done();
