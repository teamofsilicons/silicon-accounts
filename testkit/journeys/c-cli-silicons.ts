// The real `accounts` CLI: device flow approved with the Carbon's browser session → whoami;
// `silicon create` as custodian (STK once) → `login --silicon` → `login --app remind` → the fake
// remind app exchanges the SLT; self-create with --custodian --wait while the Carbon accepts;
// transfer + accept; STK rotation (old STK refused, apps signed out); the Silicon's own webhook
// events land on a fake receiver (/hooks/<key>).
import {
  accounts,
  check,
  cli,
  cliLoginEmail,
  cliSpawn,
  done,
  FakeAppsClient,
  fakeAppsUrl,
  messaging,
  newHome,
  rid,
  section,
  show,
  signUpCarbon,
  sleep,
} from './_common.ts';

const fake = new FakeAppsClient(fakeAppsUrl);
const carbon = await signUpCarbon({ accounts, messaging });
const carbonId = carbon.me.id;
const homeC = newHome('carbon');

section('device flow: `accounts login` approved with /v1/device/{code}/approve');
{
  const proc = await cliSpawn(homeC, ['login', '--no-browser', '--json']);
  let userCode: string | null = null;
  for (let i = 0; i < 100 && !userCode; i++) {
    await sleep(100);
    userCode = /"user_code"\s*:\s*"([A-Z0-9-]+)"/.exec(proc.stderrSoFar() + proc.stdoutSoFar())?.[1] ?? null;
  }
  check(!!userCode, `the CLI printed a device code (${userCode})`, proc.stderrSoFar());
  const pending: any = await carbon.browser.http.get(`/v1/device/${userCode}`);
  check(pending.status === 200 && pending.body?.status === 'pending', 'GET /v1/device/{code} → pending', pending.body);
  const approve = await carbon.browser.http.post(`/v1/device/${userCode}/approve`);
  check(approve.status === 204, `approve → ${approve.status}`, approve.body);
  const r = await proc.done;
  check(r.code === 0 && r.json?.authenticated === true && r.json?.uuid === carbon.me.uuid, `the CLI is signed in as the Carbon (${r.ms} ms)`, show(r));
  const who = await cli(homeC, ['whoami', '--json']);
  check(who.code === 0 && who.json?.id === carbonId, `whoami → ${who.json?.id}`, show(who));
}

section('silicon create (custodian) → STK once → login --silicon → login --app remind → remind exchanges');
const hookKey = `si-${rid()}`;
const handle = `scout-${rid()}`;
const created = await cli(homeC, ['silicon', 'create', '--id', `si:${handle}`, '--display-name', 'Scout', '--webhook', fake.hookUrl(hookKey), '--json']);
const stk1 = String(created.json?.stk ?? '');
const siliconUuid = String(created.json?.silicon?.uuid ?? '');
check(created.code === 0 && /^stk-[0-9a-f]{12}$/.test(stk1), 'silicon create prints a generated STK once', show(created));
check(String(created.json?.webhook_secret ?? '').startsWith('whsec_'), 'and the webhook signing secret once');
await fake.setHookSecret(hookKey, created.json?.webhook_secret ?? null);
const createdEvent: any = await fake.waitForHookEvent(hookKey, { type: 'silicon.created', timeoutMs: 15_000 }).catch((e) => ({ error: String(e) }));
check(createdEvent?.type === 'silicon.created', 'silicon.created reached /hooks/<key> (signature verified)', createdEvent);
const homeS = newHome('silicon');
const login = await cli(homeS, ['login', '--silicon', `si:${handle}`, '--stk-stdin', '--json'], { stdin: stk1 });
check(login.code === 0 && login.json?.kind === 'silicon' && login.json?.uuid === siliconUuid, 'login --silicon', show(login));
const slt = await cli(homeS, ['login', '--app', 'remind', '--json']);
check(slt.code === 0 && /^slt_/.test(slt.json?.slt ?? ''), `login --app remind → an SLT (${slt.ms} ms)`, show(slt));
const ex: any = await fake.sltLogin('remind', slt.json?.slt ?? '');
check(ex?.account?.uuid === siliconUuid && ex?.account?.custodian?.uuid === carbon.me.uuid, 'the fake remind app exchanged the SLT (account + custodian)', ex);
const again = await fake.sltLogin('remind', slt.json?.slt ?? '');
check(JSON.stringify(again).includes('invalid_grant'), 'an SLT works once', again);
const quiet = await cli(homeS, ['login', '--app', 'remind', '-q']);
check(quiet.code === 0 && /^slt_\S+\n?$/.test(quiet.stdout), '`login --app remind -q` prints only the SLT', show(quiet));

section('self-create --custodian c:<carbon> --wait, accepted through the API while it waits');
{
  const selfHandle = `self-${rid()}`;
  const homeSelf = newHome('self');
  const proc = await cliSpawn(homeSelf, ['silicon', 'create', '--id', `si:${selfHandle}`, '--custodian', carbonId, '--wait', '--timeout', '120s', '--json']);
  let request: any = null;
  for (let i = 0; i < 100 && !request; i++) {
    await sleep(200);
    request = (await carbon.account.custodianRequests()).items.find((it: any) => it.silicon?.id === `si:${selfHandle}`);
  }
  check(request?.kind === 'initial', 'the request appears for the named custodian', request);
  const acc = await carbon.browser.http.post(`/v1/me/custodian-requests/${request?.id}/accept`);
  check(acc.status === 204, `accept → ${acc.status}`, acc.body);
  const r = await proc.done;
  check(r.code === 0 && r.json?.final_status === 'accepted' && r.json?.request?.status === 'accepted' && r.json?.silicon?.status === 'active', `--wait returned after the accept (${r.ms} ms) and reports it`, show(r));
  const st = await cli(homeSelf, ['login', 'status', '--json']);
  check(st.code === 0 && st.json?.id === `si:${selfHandle}`, 'and signed in as the new Silicon', show(st));
}

section('transfer to another Carbon + accept on its CLI');
const other = await signUpCarbon({ accounts, messaging });
const homeO = newHome('other');
await cliLoginEmail(homeO, other.email!);
{
  const tr = await cli(homeC, ['silicon', 'transfer', `si:${handle}`, '--to', other.me.id, '--json']);
  check(tr.code === 0, 'silicon transfer', show(tr));
  const reqs = await cli(homeO, ['custodian', 'requests', '--json']);
  const req = (reqs.json?.items ?? []).find((x: any) => x.silicon?.uuid === siliconUuid);
  check(req?.kind === 'transfer' && req?.from?.uuid === carbon.me.uuid, 'the receiver sees the transfer (from the current custodian)', reqs.json);
  const acc = await cli(homeO, ['custodian', 'accept', req?.id ?? 'missing', '--json']);
  check(acc.code === 0, 'custodian accept', show(acc));
  const showS = await cli(homeO, ['silicon', 'show', `si:${handle}`, '--json']);
  check(showS.code === 0 && showS.json?.custodian?.uuid === other.me.uuid, 'the new custodian manages it', show(showS));
  const ev: any = await fake.waitForHookEvent(hookKey, { type: 'silicon.custodian.changed', timeoutMs: 15_000 }).catch((e) => ({ error: String(e) }));
  check(ev?.type === 'silicon.custodian.changed', 'silicon.custodian.changed reached the Silicon webhook', ev);
  const appEv: any = await fake.waitForEvent('remind', { type: 'silicon.custodian_changed', uuid: siliconUuid, timeoutMs: 15_000 }).catch((e) => ({ error: String(e) }));
  check(appEv?.payload?.data?.to?.uuid === other.me.uuid, 'remind (a member app) got silicon.custodian_changed', appEv);
}

section('rotate STK: the old STK is refused, apps are signed out');
{
  const rot = await cli(homeO, ['silicon', 'rotate-stk', `si:${handle}`, '--json']);
  check(rot.code === 0 && /^stk-[0-9a-f]{12}$/.test(rot.json?.stk ?? ''), 'rotate-stk prints the new STK once', show(rot));
  const homeX = newHome('x');
  const old = await cli(homeX, ['login', '--silicon', `si:${handle}`, '--stk-stdin', '--json'], { stdin: stk1 });
  check(old.code === 3 && old.json?.error?.code === 'invalid_credentials', `the old STK → exit ${old.code} ${old.json?.error?.code}`, show(old));
  const neu = await cli(homeX, ['login', '--silicon', `si:${handle}`, '--stk-stdin', '--json'], { stdin: rot.json?.stk ?? '' });
  check(neu.code === 0, 'the new STK signs in', show(neu));
  const ev: any = await fake.waitForHookEvent(hookKey, { type: 'silicon.stk_rotated', timeoutMs: 15_000 }).catch((e) => ({ error: String(e) }));
  check(ev?.type === 'silicon.stk_rotated', 'silicon.stk_rotated reached the Silicon webhook', ev);
  const so: any = await fake.waitForEvent('remind', { type: 'membership.signed_out', uuid: siliconUuid, timeoutMs: 15_000 }).catch((e) => ({ error: String(e) }));
  check(so?.payload?.data?.reason === 'stk_rotated', 'remind got membership.signed_out (stk_rotated)', so);
  const st = await cli(homeS, ['login', 'status', '--json']);
  check(st.code === 1 && st.json?.authenticated === false, 'the CLI session from before the rotation has ended', show(st));
}

done();
