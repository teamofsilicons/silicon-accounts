// The Rust client (through the CLI's --json, which prints the client's typed values) against the
// raw API: for each call, every non-empty field the server sends must survive the client, and the
// client must not print fields the server never sent. Catches drift between crates/client and the
// server crates (a renamed field silently decoding to a default, a new field the client drops).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accounts,
  check,
  cli,
  cliLoginEmail,
  codeFrom,
  codeStep,
  done,
  driveFlow,
  FakeAppsClient,
  fakeApp,
  fakeAppsUrl,
  HttpClient,
  messaging,
  newBrowser,
  newHome,
  randomEmail,
  randomPhone,
  rid,
  section,
  signUpCarbon,
  sleep,
  startAppSignIn,
} from './_common.ts';

type Leaves = Map<string, 'value' | 'empty'>;
function leaves(v: unknown, prefix = '', out: Leaves = new Map()): Leaves {
  if (Array.isArray(v)) {
    if (v.length === 0 && !out.has(`${prefix}[]`)) out.set(`${prefix}[]`, 'empty');
    for (const x of v) leaves(x, `${prefix}[]`, out);
  } else if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0 && !out.has(prefix)) out.set(prefix, 'empty');
    for (const k of keys) leaves((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, out);
  } else if (v === null || v === undefined || v === false || v === '') {
    if (!out.has(prefix)) out.set(prefix, 'empty');
  } else {
    out.set(prefix, 'value');
  }
  return out;
}

/** Compares a raw API value with the CLI's printed value; `extra` lists CLI-only presentation keys. */
function compare(name: string, raw: unknown, printed: unknown, extra: string[] = []): void {
  const r = leaves(raw);
  const c = leaves(printed);
  const dropped = [...r.entries()].filter(([k, kind]) => kind === 'value' && !c.has(k)).map(([k]) => k);
  const invented = [...c.keys()].filter((k) => !r.has(k) && !extra.some((e) => k === e || k.startsWith(`${e}.`) || k.startsWith(`${e}[]`)));
  check(dropped.length === 0 && invented.length === 0, name, { dropped_by_client: dropped, printed_but_never_sent: invented });
}

const fake = new FakeAppsClient(fakeAppsUrl);
const cliJson = async (home: string, args: string[], env: Record<string, string> = {}) => (await cli(home, [...args, '--json'], { env })).json;

// A Carbon with a Silicon (pending transfer), app memberships, a phone and an OBO proof about it.
const carbon = await signUpCarbon({ accounts, messaging });
const other = await signUpCarbon({ accounts, messaging });
const home = newHome('contract');
await cliLoginEmail(home, carbon.email!);
const session = JSON.parse(readFileSync(join(home, '.accounts', 'session.json'), 'utf8')) as { access_token: string };
const api = new HttpClient({ baseUrl: accounts.url, headers: { ...accounts.headers, Authorization: `Bearer ${session.access_token}` } });
const raw = async (path: string, query?: Record<string, string | number>) => (await api.get(path, query ? { query } : {})).body;

const siId = `si:contract-${rid()}`;
const created = await cliJson(home, ['silicon', 'create', '--id', siId, '--display-name', 'Contract', '--webhook', fake.hookUrl(`contract-${rid()}`)]);
const sUuid = String(created?.silicon?.uuid);
await cliJson(home, ['silicon', 'transfer', siId, '--to', other.me.id]);
await fake.sltLogin('briefcase', (await cliJson(home, ['login', '--app', 'briefcase']))?.slt);
{
  const p = randomPhone();
  const seq = await messaging.lastSeq();
  const add = await cliJson(home, ['phone', 'add', p]);
  await cliJson(home, ['phone', 'verify', add?.challenge_id, await messaging.waitForCode({ to: p, after: seq })]);
  await fake.sltLogin('dm', (await cliJson(home, ['login', '--app', 'dm']))?.slt);
  await fake.saveToBriefcase({ uuid: carbon.me.uuid, filename: 'contract.txt' });
}

section('a Carbon\'s own views');
compare('whoami ↔ GET /v1/me', await raw('/v1/me'), await cliJson(home, ['whoami']));
compare('email list ↔ GET /v1/me/emails (items)', ((await raw('/v1/me/emails')) as any).items, (await cliJson(home, ['email', 'list']))?.emails);
compare('phone list ↔ GET /v1/me/phones (items)', ((await raw('/v1/me/phones')) as any).items, (await cliJson(home, ['phone', 'list']))?.phones);
compare('identities list ↔ GET /v1/me/identities (items)', ((await raw('/v1/me/identities')) as any).items, (await cliJson(home, ['identities', 'list']))?.identities);
compare('apps list ↔ GET /v1/me/apps', await raw('/v1/me/apps'), await cliJson(home, ['apps', 'list']));
compare('sessions list ↔ GET /v1/me/sessions', await raw('/v1/me/sessions'), await cliJson(home, ['sessions', 'list']));
compare('history ↔ GET /v1/me/history', await raw('/v1/me/history', { limit: 50 }), await cliJson(home, ['history']));
compare('proofs list ↔ GET /v1/me/proofs', await raw('/v1/me/proofs'), await cliJson(home, ['proofs', 'list']));
compare('silicon list ↔ GET /v1/me/silicons', await raw('/v1/me/silicons'), await cliJson(home, ['silicon', 'list']));
compare('silicon show ↔ GET /v1/me/silicons/{uuid}', await raw(`/v1/me/silicons/${sUuid}`), await cliJson(home, ['silicon', 'show', sUuid]));
compare('lookup ↔ GET /v1/accounts/{uuid}', await raw(`/v1/accounts/${sUuid}`), await cliJson(home, ['lookup', sUuid]));
compare('id available ↔ GET /v1/ids/available', await raw('/v1/ids/available', { id: 'c:saket' }), await cliJson(home, ['id', 'available', 'c:saket']));
compare('app list ↔ GET /v1/me/owned-apps', await raw('/v1/me/owned-apps'), await cliJson(home, ['app', 'list']));
{
  const homeO = newHome('contract-other');
  await cliLoginEmail(homeO, other.email!);
  const so = JSON.parse(readFileSync(join(homeO, '.accounts', 'session.json'), 'utf8')) as { access_token: string };
  const rawO = (await new HttpClient({ baseUrl: accounts.url, headers: { ...accounts.headers, Authorization: `Bearer ${so.access_token}` } }).get('/v1/me/custodian-requests')).body;
  compare('custodian requests ↔ GET /v1/me/custodian-requests', rawO, await cliJson(homeO, ['custodian', 'requests']));
}
{
  const d: any = (await accounts.http.post('/v1/device/authorize', { json: { client_label: 'contract' } })).body;
  compare('device show ↔ GET /v1/device/{code}', await raw(`/v1/device/${d.user_code}`), await cliJson(home, ['device', 'show', d.user_code]));
}
{
  const homeS = newHome('contract-self');
  const self = await cliJson(homeS, ['silicon', 'create', '--id', `si:contract-self-${rid()}`, '--custodian', carbon.me.id]);
  const rawCreate = (await accounts.siliconSelfCreate({ id: `si:contract-raw-${rid()}`, display_name: 'Raw', custodian: carbon.me.id })).body;
  compare('silicon create (self) ↔ POST /v1/silicons', rawCreate, self, ['request_file']);
  compare('silicon request status ↔ GET /v1/silicons/requests/{id}', (await accounts.siliconRequestStatus(self.request.id, self.request_token)).body, await cliJson(homeS, ['silicon', 'request', 'status', self.request.id]));
}

section('app mode');
const env = { ACCOUNTS_APP_ID: 'briefcase', ACCOUNTS_APP_SECRET: fakeApp('briefcase').secret };
const app = accounts.app('briefcase');
const appRaw = async (path: string, query?: Record<string, string | number>) => (await app.request('GET', path, query ? { query } : {})).body;
const homeA = newHome('contract-app');
compare('app show ↔ GET /v1/apps/{id}', await appRaw('/v1/apps/briefcase'), await cliJson(homeA, ['app', 'show'], env), ['acting_as']);
compare('app config get ↔ GET /v1/apps/{id} signin_config', ((await appRaw('/v1/apps/briefcase')) as any).signin_config, (await cliJson(homeA, ['app', 'config', 'get'], env))?.signin_config);
compare('app config history ↔ GET …/signin-config/history', await appRaw('/v1/apps/briefcase/signin-config/history'), await cliJson(homeA, ['app', 'config', 'history'], env));
compare('app users ↔ GET …/users', await appRaw('/v1/apps/briefcase/users', { q: carbon.me.uuid }), await cliJson(homeA, ['app', 'users', '--q', carbon.me.uuid], env));
compare('app user ↔ GET …/users/{uuid}', await appRaw(`/v1/apps/briefcase/users/${carbon.me.uuid}`), await cliJson(homeA, ['app', 'user', carbon.me.uuid], env));
const dmEnv = { ACCOUNTS_APP_ID: 'dm', ACCOUNTS_APP_SECRET: fakeApp('dm').secret };
compare('app proof list ↔ GET …/proofs', (await accounts.app('dm').request('GET', '/v1/apps/dm/proofs')).body, await cliJson(homeA, ['app', 'proof', 'list'], dmEnv));
{
  // Compare settled deliveries: the worker sends the ping right away, and a delivery read while
  // pending (next_attempt_at, no attempts) and again once delivered would differ by timing alone.
  const ping: any = (await app.request('POST', '/v1/apps/briefcase/webhook/test')).body;
  for (let i = 0; i < 100; i++) {
    const d: any = await appRaw(`/v1/apps/briefcase/webhook/deliveries/${ping.delivery_id}`);
    if (d?.status && d.status !== 'pending') break;
    await sleep(100);
  }
}
compare('app webhook deliveries ↔ GET …/webhook/deliveries', await appRaw('/v1/apps/briefcase/webhook/deliveries', { limit: 3 }), await cliJson(homeA, ['app', 'webhook', 'deliveries', '--limit', '3'], env));
{
  const one: any = await appRaw('/v1/apps/briefcase/webhook/deliveries', { limit: 1 });
  const detail: any = await appRaw(`/v1/apps/briefcase/webhook/deliveries/${one.items[0].id}`);
  const printed = await cliJson(homeA, ['app', 'webhook', 'delivery', one.items[0].id], env);
  const { attempts, payload, attempt_count, ...flat } = detail;
  compare('app webhook delivery ↔ GET …/deliveries/{id} (delivery)', { ...flat, attempts: attempt_count }, printed?.delivery);
  compare('app webhook delivery ↔ GET …/deliveries/{id} (attempts)', attempts, printed?.attempt_log);
  compare('app webhook delivery ↔ GET …/deliveries/{id} (payload)', payload, printed?.payload);
}
{
  const lc = { ACCOUNTS_APP_ID: 'legacy-crm', ACCOUNTS_APP_SECRET: fakeApp('legacy-crm').secret };
  const lcApp = accounts.app('legacy-crm');
  const homeL = newHome('contract-lc');
  const job = (await lcApp.startImportJson([{ email: randomEmail('contract-import'), display_name: 'Contract Import' }], { dry_run: true })).body.job;
  await lcApp.waitForImport(job.id);
  compare('app import list ↔ GET …/imports', (await lcApp.request('GET', '/v1/apps/legacy-crm/imports')).body, await cliJson(homeL, ['app', 'import', 'list'], lc));
  compare('app import status ↔ GET …/imports/{job} (job)', ((await lcApp.request('GET', `/v1/apps/legacy-crm/imports/${job.id}`)).body as any).job, await cliJson(homeL, ['app', 'import', 'status', job.id], lc));
  compare('app import rows ↔ GET …/imports/{job}/rows', (await lcApp.request('GET', `/v1/apps/legacy-crm/imports/${job.id}/rows`)).body, await cliJson(homeL, ['app', 'import', 'rows', job.id], lc));
}
{
  const browser = await newBrowser();
  const s = await startAppSignIn('briefcase', browser, { scope: 'openid email' });
  let flow = await codeStep(browser, s.flow, { email: randomEmail('contract-token') });
  flow = await driveFlow(browser, flow, { messaging });
  const exchanged = await cliJson(homeA, ['app', 'token', 'exchange', '--code', codeFrom(flow), '--redirect-uri', s.az.redirect_uri, '--code-verifier', s.az.code_verifier ?? ''], env);
  const rawRefresh = await app.refresh(exchanged.refresh_token);
  const printed = await cliJson(homeA, ['app', 'token', 'refresh', rawRefresh.refresh_token], env);
  compare('app token refresh ↔ POST /v1/oauth/token', rawRefresh, printed);
  const token = String(printed?.access_token);
  compare('app token introspect ↔ POST /v1/oauth/introspect', await app.introspect(token), await cliJson(homeA, ['app', 'token', 'introspect', token], env));
  compare('app userinfo ↔ GET /v1/userinfo', (await app.userinfo(token)).body, await cliJson(homeA, ['app', 'userinfo', token], env));
}

done();
