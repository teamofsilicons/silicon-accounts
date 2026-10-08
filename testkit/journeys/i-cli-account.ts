// Every account command of the CLI against the real service: whoami, ids, lookup, profile and
// photo, emails, phones, identities, apps, proofs, sessions, history, logout.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accounts,
  check,
  cliLoginEmail,
  done,
  FakeAppsClient,
  fakeAppsUrl,
  messaging,
  newHome,
  randomEmail,
  randomPhone,
  rid,
  run,
  section,
  signUpCarbon,
} from './_common.ts';

const fake = new FakeAppsClient(fakeAppsUrl);
const carbon = await signUpCarbon({ accounts, messaging });
const email1 = carbon.email!;
const home = newHome('account');
await cliLoginEmail(home, email1);

section('whoami, ids, lookup');
const who = await run('whoami', home, ['whoami'], (r) => r.code === 0 && r.json?.uuid === carbon.me.uuid && Array.isArray(r.json?.emails));
const oldId = String(who.json?.id);
await run('id available (free)', home, ['id', 'available', `c:free-${rid()}`], (r) => r.code === 0 && r.json?.available === true);
await run('id available (taken) → exit 5 with suggestions', home, ['id', 'available', 'c:saket'], (r) => r.code === 5 && r.json?.reason === 'taken' && Array.isArray(r.json?.suggestions) && r.json.suggestions.length > 0);
await run('id available (invalid) → exit 2', home, ['id', 'available', 'c:a!'], (r) => r.code === 2 && r.json?.reason === 'invalid');
await run('id available (reserved word)', home, ['id', 'available', 'c:admin'], (r) => r.code !== 0 && r.json?.reason === 'reserved_word');
const newId = `c:renamed-${rid()}`;
await run('id change', home, ['id', 'change', newId], (r) => r.code === 0 && r.json?.id === newId);
await run('the old id is reserved for its owner', home, ['id', 'available', oldId], (r) => r.json?.reclaimable === true);
await run('id change back (reclaim)', home, ['id', 'change', oldId], (r) => r.code === 0 && r.json?.id === oldId);
await run('lookup c:saket', home, ['lookup', 'c:saket'], (r) => r.code === 0 && r.json?.kind === 'carbon');
await run('lookup <uuid>', home, ['lookup', carbon.me.uuid], (r) => r.code === 0 && r.json?.uuid === carbon.me.uuid);
await run('lookup unknown → exit 4', home, ['lookup', 'c:nobody-here-zz'], (r) => r.code === 4);

section('profile and photo');
await run('profile set', home, ['profile', 'set', '--display-name', 'Journey Carbon', '--timezone', 'Asia/Kolkata', '--dob', '1990-01-02'], (r) => r.code === 0 && r.json?.display_name === 'Journey Carbon' && r.json?.dob === '1990-01-02');
const png = join(home, 'me.png');
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const photo = await run('profile set --photo', home, ['profile', 'set', '--photo', png], (r) => r.code === 0 && /\/v1\/photos\//.test(r.json?.pfp_url ?? ''));
const served = await fetch(`${accounts.url}${new URL(String(photo.json?.pfp_url ?? 'http://x/')).pathname}`);
check(served.status === 200 && served.headers.get('content-type') === 'image/png', `GET /v1/photos/{id} → ${served.status} ${served.headers.get('content-type')}`);
await run('profile set --reset-photo', home, ['profile', 'set', '--reset-photo'], (r) => r.code === 0 && /\/pfp\/carbon\?id=/.test(r.json?.pfp_url ?? ''));

section('emails');
const email2 = randomEmail('second');
let seq = await messaging.lastSeq();
const add = await run('email add', home, ['email', 'add', email2], (r) => r.code === 0 && typeof r.json?.challenge_id === 'string');
await run('email verify', home, ['email', 'verify', add.json?.challenge_id, await messaging.waitForCode({ to: email2, after: seq })]);
await run('email list', home, ['email', 'list'], (r) => r.code === 0 && JSON.stringify(r.json).includes(email2));
await run('email primary', home, ['email', 'primary', email2]);
await run('email remove (the old primary)', home, ['email', 'remove', email1], (r) => r.code === 0 && !JSON.stringify(r.json).includes(email1));
await run('email remove primary → exit 5 cannot_remove_primary', home, ['email', 'remove', email2], (r) => r.code === 5 && r.json?.error?.code === 'cannot_remove_primary');

section('phones');
const phone = randomPhone();
seq = await messaging.lastSeq();
const addp = await run('phone add', home, ['phone', 'add', phone], (r) => r.code === 0);
await run('phone verify', home, ['phone', 'verify', addp.json?.challenge_id, await messaging.waitForCode({ to: phone, after: seq })]);
const phone2 = randomPhone();
seq = await messaging.lastSeq();
const addp2 = await run('phone add (local format + --country US)', home, ['phone', 'add', phone2.slice(2), '--country', 'US'], (r) => r.code === 0);
await run('phone verify 2', home, ['phone', 'verify', addp2.json?.challenge_id, await messaging.waitForCode({ to: phone2, after: seq })]);
await run('phone primary', home, ['phone', 'primary', phone2]);
await run('phone remove', home, ['phone', 'remove', phone]);
await run('phone list', home, ['phone', 'list'], (r) => r.code === 0 && JSON.stringify(r.json).includes(phone2) && !JSON.stringify(r.json).includes(phone));

section('identities, apps, proofs, sessions, history');
await run('identities list', home, ['identities', 'list']);
const slt = await run('login --app briefcase (a Carbon\'s SLT)', home, ['login', '--app', 'briefcase'], (r) => /^slt_/.test(r.json?.slt ?? ''));
check(((await fake.sltLogin('briefcase', slt.json?.slt ?? '')) as any).account?.uuid === carbon.me.uuid, 'briefcase exchanged the SLT');
const slt2 = await run('login --app dm', home, ['login', '--app', 'dm'], (r) => /^slt_/.test(r.json?.slt ?? ''));
await fake.sltLogin('dm', slt2.json?.slt ?? '');
check((await fake.saveToBriefcase({ uuid: carbon.me.uuid, filename: 'cli.txt' })).status === 200, 'dm issued a user verification proof about the Carbon');
await run('apps list', home, ['apps', 'list'], (r) => r.code === 0 && JSON.stringify(r.json).includes('"briefcase"') && JSON.stringify(r.json).includes('"dm"'));
const proofs = await run('proofs list', home, ['proofs', 'list'], (r) => r.code === 0 && (r.json?.items ?? []).some((p: any) => p.issuing_app?.app_id === 'dm' && p.status === 'active'));
await run('proofs revoke', home, ['proofs', 'revoke', (proofs.json?.items ?? [])[0]?.proof_id ?? 'missing']);
await run('apps remove briefcase', home, ['apps', 'remove', 'briefcase']);
const sessions = await run('sessions list', home, ['sessions', 'list'], (r) => r.code === 0 && (r.json?.items ?? []).some((s: any) => s.current));
const browserSession = (sessions.json?.items ?? []).find((s: any) => !s.current);
await run('sessions revoke (the account-site session)', home, ['sessions', 'revoke', browserSession?.id ?? 'missing']);
check((await carbon.browser.session()) === null, 'the account-site browser session is signed out');
await run('history', home, ['history'], (r) => r.code === 0 && (r.json?.items ?? []).length > 0);
await run('history --kind id_change', home, ['history', '--kind', 'id_change'], (r) => r.code === 0 && JSON.stringify(r.json).includes(newId));

section('the CLI refreshes an expired access token (client_id=accounts) and rotates the refresh token');
{
  const file = join(home, '.accounts', 'session.json');
  const stored = JSON.parse(readFileSync(file, 'utf8')) as { refresh_token: string; expires_at: string };
  const before = stored.refresh_token;
  writeFileSync(file, JSON.stringify({ ...stored, expires_at: '2020-01-01T00:00:00Z' }));
  await run('whoami with an expired access token', home, ['whoami'], (r) => r.code === 0 && r.json?.uuid === carbon.me.uuid);
  const after = JSON.parse(readFileSync(file, 'utf8')) as { refresh_token: string; expires_at: string };
  check(after.refresh_token !== before && Date.parse(after.expires_at) > Date.now(), 'the session file holds the rotated refresh token and a fresh expiry');
}

section('logout');
await run('logout', home, ['logout'], (r) => r.code === 0 && r.json?.signed_out === true && r.json?.revoked === true);
await run('login status → exit 1, {"authenticated":false}', home, ['login', 'status'], (r) => r.code === 1 && JSON.stringify(r.json) === '{"authenticated":false}');

done();
