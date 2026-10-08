// The custodian side of the CLI: a Silicon's life (create with a chosen STK, show, update, id,
// webhooks, rotate, transfer/cancel, delete), a self-created Silicon declined by email, device
// show/deny, config, and deleting accounts.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accounts,
  check,
  cliLoginEmail,
  cliSpawn,
  done,
  FakeAppsClient,
  fakeAppsUrl,
  messaging,
  newHome,
  pngBytes,
  rid,
  run,
  section,
  show,
  signUpCarbon,
  sleep,
} from './_common.ts';

const fake = new FakeAppsClient(fakeAppsUrl);
const a = await signUpCarbon({ accounts, messaging });
const b = await signUpCarbon({ accounts, messaging });
const homeA = newHome('custodian-a');
const homeB = newHome('custodian-b');
await cliLoginEmail(homeA, a.email!);
await cliLoginEmail(homeB, b.email!);

section("a Silicon's life on its custodian's CLI");
const h = `cj-${rid()}`;
const hookKey = `cj-${rid()}`;
const created = await run('silicon create with a chosen STK (stdin, bare hex)', homeA, ['silicon', 'create', '--id', h, '--display-name', 'Journey Si', '--timezone', 'Europe/Berlin', '--stk-stdin'], (r) => r.code === 0 && (r.json?.stk ?? null) === null && r.json?.silicon?.id === `si:${h}` && r.json?.silicon?.timezone === 'Europe/Berlin', { stdin: 'ABCDEF0123' });
const sUuid = String(created.json?.silicon?.uuid);
await run('silicon list', homeA, ['silicon', 'list'], (r) => JSON.stringify(r.json).includes(sUuid));
await run('silicon show by si:id', homeA, ['silicon', 'show', `si:${h}`], (r) => r.json?.uuid === sUuid);
await run('silicon update', homeA, ['silicon', 'update', `si:${h}`, '--display-name', 'Journey Si 2', '--timezone', 'Asia/Tokyo'], (r) => r.code === 0 && r.json?.display_name === 'Journey Si 2');
const h2 = `cj-${rid()}`;
await run('silicon id', homeA, ['silicon', 'id', `si:${h}`, `si:${h2}`], (r) => r.code === 0 && r.json?.id === `si:${h2}`);
await run('id available: the old si:id is reserved (for someone else)', homeA, ['id', 'available', `si:${h}`], (r) => r.code === 5 && r.json?.reason === 'reserved');
await run('id available --for <the Silicon>: reclaimable for it', homeA, ['id', 'available', `si:${h}`, '--for', `si:${h2}`], (r) => r.code === 0 && r.json?.available === true && r.json?.reclaimable === true);
await run('id available --for another Carbon\'s Silicon → exit 4', homeB, ['id', 'available', `si:${h}`, '--for', `si:${h2}`], (r) => r.code === 4 && r.json?.error?.code === 'silicon_not_found');
{
  const dir = mkdtempSync(join(tmpdir(), 'journey-photo-'));
  const png = join(dir, 'si.png');
  writeFileSync(png, pngBytes(80, 80));
  const up = await run('silicon update --photo uploads its photo', homeA, ['silicon', 'update', `si:${h2}`, '--photo', png], (r) => r.code === 0 && /\/v1\/photos\//.test(r.json?.pfp_url ?? ''));
  const served = await fetch(await accounts.toServerUrl(String(up.json?.pfp_url)));
  check(served.status === 200 && served.headers.get('content-type') === 'image/png', `the Silicon's photo is served (${served.status})`);
}
const wh = await run('silicon webhook set (custodian)', homeA, ['silicon', 'webhook', 'set', `si:${h2}`, fake.hookUrl(hookKey)], (r) => r.code === 0 && /^whsec_/.test(r.json?.webhook_secret ?? ''));
await fake.setHookSecret(hookKey, wh.json?.webhook_secret ?? null);
const homeS = newHome('custodian-s');
await run('the Silicon signs in with its chosen STK (normalized)', homeS, ['login', '--silicon', `si:${h2}`, '--stk-stdin'], (r) => r.code === 0, { stdin: 'stk-abcdef0123' });
await run('whoami as the Silicon', homeS, ['whoami'], (r) => r.json?.kind === 'silicon' && r.json?.custodian?.uuid === a.me.uuid);
await run('webhook test (own)', homeS, ['webhook', 'test'], (r) => r.code === 0 && typeof r.json?.event_id === 'string');
check(((await fake.waitForHookEvent(hookKey, { type: 'ping', timeoutMs: 15_000 }).catch((e) => ({ error: String(e) }))) as any).type === 'ping', 'the ping reached /hooks/<key>');
await run('webhook remove (own)', homeS, ['webhook', 'remove']);
const wh2 = await run('webhook set (own)', homeS, ['webhook', 'set', fake.hookUrl(hookKey)], (r) => /^whsec_/.test(r.json?.webhook_secret ?? ''));
await fake.setHookSecret(hookKey, wh2.json?.webhook_secret ?? null);
await run('profile set --timezone (Silicon)', homeS, ['profile', 'set', '--timezone', 'UTC'], (r) => r.json?.timezone === 'UTC');
await run('profile set --dob refused for a Silicon (exit 2)', homeS, ['profile', 'set', '--dob', '2000-01-01'], (r) => r.code === 2);
check(((await fake.waitForHookEvent(hookKey, { type: 'silicon.updated', timeoutMs: 15_000 }).catch((e) => ({ error: String(e) }))) as any).type === 'silicon.updated', 'silicon.updated reached the Silicon webhook');
await run('silicon rotate-stk', homeA, ['silicon', 'rotate-stk', `si:${h2}`], (r) => /^stk-[0-9a-f]{12}$/.test(r.json?.stk ?? ''));
await run('the Silicon\'s CLI session ended with the rotation (exit 3)', homeS, ['whoami'], (r) => r.code === 3);
await run('silicon transfer', homeA, ['silicon', 'transfer', `si:${h2}`, '--to', b.me.id], (r) => r.code === 0);
await run('a second transfer → exit 5 transfer_pending', homeA, ['silicon', 'transfer', `si:${h2}`, '--to', b.me.id], (r) => r.code === 5 && r.json?.error?.code === 'transfer_pending');
await run('silicon cancel-transfer', homeA, ['silicon', 'cancel-transfer', `si:${h2}`]);
await run('the receiver no longer sees it', homeB, ['custodian', 'requests'], (r) => r.code === 0 && !JSON.stringify(r.json).includes(sUuid));
await run('silicon delete without --confirm → exit 2', homeA, ['silicon', 'delete', `si:${h2}`], (r) => r.code === 2);
await run('silicon delete --confirm', homeA, ['silicon', 'delete', `si:${h2}`, '--confirm', `si:${h2}`]);
await run('silicon show after delete → exit 4', homeA, ['silicon', 'show', sUuid], (r) => r.code === 4);

section('a self-created Silicon names a custodian by email, who declines');
{
  const homeSelf = newHome('custodian-self');
  const sh = `cj-self-${rid()}`;
  const c = await run('silicon create --custodian <email> (no wait)', homeSelf, ['silicon', 'create', '--id', sh, '--custodian', b.email!], (r) => r.code === 0 && /^sarq_/.test(r.json?.request_token ?? '') && r.json?.request?.kind === 'initial');
  const reqId = String(c.json?.request?.id);
  await run('silicon request status → pending', homeSelf, ['silicon', 'request', 'status', reqId], (r) => r.code === 0 && r.json?.status === 'pending' && r.json?.kind === 'initial');
  const reqs = await run('custodian requests (b, named by a verified email)', homeB, ['custodian', 'requests'], (r) => JSON.stringify(r.json).includes(`si:${sh}`));
  await run('custodian decline', homeB, ['custodian', 'decline', (reqs.json?.items ?? []).find((x: any) => x.silicon?.id === `si:${sh}`)?.id ?? 'missing']);
  await run('silicon request status → declined', homeSelf, ['silicon', 'request', 'status', reqId], (r) => r.code === 0 && r.json?.status === 'declined');
  await run('the declined id is free at once', homeSelf, ['id', 'available', `si:${sh}`], (r) => r.json?.available === true);
  await run('the declined Silicon cannot sign in (exit 3)', newHome('custodian-x'), ['login', '--silicon', `si:${sh}`, '--stk-stdin'], (r) => r.code === 3, { stdin: c.json?.stk ?? 'stk-000000000000' });
}

section('device show / deny');
{
  const proc = await cliSpawn(newHome('custodian-dev'), ['login', '--no-browser', '--json']);
  let userCode: string | null = null;
  for (let i = 0; i < 100 && !userCode; i++) {
    await sleep(100);
    userCode = /"user_code"\s*:\s*"([A-Z0-9-]+)"/.exec(proc.stderrSoFar())?.[1] ?? null;
  }
  await run('device show (lower case, no dash)', homeA, ['device', 'show', (userCode ?? '').toLowerCase().replace('-', '')], (r) => r.json?.status === 'pending');
  await run('device deny', homeA, ['device', 'deny', userCode ?? 'missing']);
  const r = await proc.done;
  check(r.code === 3 && JSON.stringify(r.json).includes('access_denied'), `the waiting login ends with access_denied (exit ${r.code})`, show(r));
}

section('config');
{
  const homeCfg = newHome('custodian-cfg');
  await run('config get', homeCfg, ['config', 'get']);
  await run('config set url', homeCfg, ['config', 'set', 'url', accounts.url]);
  await run('config telemetry off', homeCfg, ['config', 'telemetry', 'off']);
  await run('config home <file> → "not a directory" (exit 2)', homeCfg, ['config', 'home', '/etc/hosts'], (r) => r.code === 2 && /not a directory/i.test(r.json?.error?.message ?? ''));
  await run('config unset url', homeCfg, ['config', 'unset', 'url']);
}

section('delete-account');
{
  const c = await signUpCarbon({ accounts, messaging });
  const homeDel = newHome('custodian-del');
  await cliLoginEmail(homeDel, c.email!);
  await run('delete-account without --confirm → exit 2', homeDel, ['delete-account'], (r) => r.code === 2);
  await run('delete-account --confirm', homeDel, ['delete-account', '--confirm', c.me.id]);
  await run('signed out afterwards', homeDel, ['login', 'status'], (r) => r.code === 0);
  await run('silicon create (so a is a custodian)', homeA, ['silicon', 'create', '--id', `cj-keep-${rid()}`]);
  await run('a custodian cannot delete their account → exit 5 custodian_of_silicons', homeA, ['delete-account', '--confirm', a.me.id], (r) => r.code === 5 && r.json?.error?.code === 'custodian_of_silicons');
}

done();
