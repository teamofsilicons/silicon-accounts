// App webhooks reach the fake apps with valid signatures: id change, profile changes limited to
// each app's scopes, a new primary email (email scope only), sign-out (revoke) and access removal.
// (A Silicon's custodian change reaching a member app is covered by c-cli-silicons.)
import { accounts, check, done, FakeAppsClient, fakeAppsUrl, messaging, randomEmail, rid, section, signUpCarbon, sleep, startAppSignIn } from './_common.ts';

const fake = new FakeAppsClient(fakeAppsUrl);
const carbon = await signUpCarbon({ accounts, messaging });
const uuid = carbon.me.uuid;
const me = carbon.account;
const lastSeq = async (app: string) => (await fake.events(app)).last_seq;
const refused = async (app: string) => ((await fake.events(app, { includeRejected: true })).rejected ?? []).length;
const refusedBefore = { briefcase: await refused('briefcase'), browser: await refused('browser') };

section('sign into briefcase (email + optional timezone granted) and browser (profile only)');
const b = await startAppSignIn('briefcase', carbon.browser);
let flow = await carbon.browser.continueAs(b.flow.id);
check(flow.step === 'consent' && flow.consent?.required[0]?.scope === 'profile', 'consent lists profile first', flow.consent);
flow = await carbon.browser.consent(flow.id, true, ['timezone']);
const bcb: any = await b.fake.callback('briefcase', flow.redirect_to!);
check(!!bcb.account?.timezone && !!bcb.account?.email, 'briefcase sees email and timezone', bcb);
const w = await startAppSignIn('browser', carbon.browser);
flow = await carbon.browser.continueAs(w.flow.id);
if (flow.step === 'consent') flow = await carbon.browser.consent(flow.id, true, []);
const wcb: any = await w.fake.callback('browser', flow.redirect_to!);
check(wcb.ok === true && wcb.account?.timezone === undefined && wcb.account?.email === undefined, 'browser sees neither', wcb);

section('id change → account.id_changed at both');
{
  const [s1, s2] = [await lastSeq('briefcase'), await lastSeq('browser')];
  const newId = `c:renamed-${rid()}`;
  await me.changeId(newId);
  const eb = await fake.waitForEvent('briefcase', { type: 'account.id_changed', uuid, after: s1 });
  const ew = await fake.waitForEvent('browser', { type: 'account.id_changed', uuid, after: s2 });
  check(eb.payload.data.old_id === carbon.me.id && eb.payload.data.new_id === newId && eb.payload.data.membership_id === `briefcase:${uuid}`, `briefcase: ${eb.payload.data.old_id} → ${eb.payload.data.new_id}`, eb.payload);
  check(ew.payload.app_id === 'browser' && ew.payload.data.new_id === newId, 'browser too', ew.payload);
}

section('timezone change → only briefcase (timezone granted)');
{
  const [s1, s2] = [await lastSeq('briefcase'), await lastSeq('browser')];
  await me.updateMe({ timezone: 'America/New_York' });
  const eb = await fake.waitForEvent('briefcase', { type: 'account.updated', uuid, after: s1 });
  check((eb.payload.data.changed as string[]).includes('timezone') && (eb.payload.data.account as any)?.timezone === 'America/New_York', `briefcase: changed ${JSON.stringify(eb.payload.data.changed)}`, eb.payload.data);
  await sleep(1500);
  check((await fake.events('browser', { type: 'account.updated', uuid, after: s2 })).items.length === 0, 'browser got nothing');
}

section('display name change → both, each limited to its scopes');
{
  const [s1, s2] = [await lastSeq('briefcase'), await lastSeq('browser')];
  await me.updateMe({ display_name: 'Renamed Carbon' });
  const eb = await fake.waitForEvent('briefcase', { type: 'account.updated', uuid, after: s1 });
  const ew = await fake.waitForEvent('browser', { type: 'account.updated', uuid, after: s2 });
  check(!!(eb.payload.data.account as any)?.email, 'briefcase gets the account with its email');
  check((ew.payload.data.account as any)?.display_name === 'Renamed Carbon' && (ew.payload.data.account as any)?.email === undefined, 'browser gets the name and no email', ew.payload.data);
}

section('new primary email → only briefcase (email scope)');
{
  const [s1, s2] = [await lastSeq('briefcase'), await lastSeq('browser')];
  const email2 = randomEmail('second');
  const after = await messaging.lastSeq();
  const add = await me.addEmail(email2);
  await me.verifyEmail(add.challenge_id, await messaging.waitForCode({ to: email2, after }));
  const prim = await carbon.browser.http.post(`/v1/me/emails/${encodeURIComponent(email2)}/primary`);
  check(prim.status === 200, `make primary → ${prim.status}`, prim.body);
  const eb = await fake.waitForEvent('briefcase', { type: 'account.updated', uuid, after: s1 });
  check((eb.payload.data.changed as string[]).includes('email') && (eb.payload.data.account as any)?.email === email2, `briefcase: email → ${(eb.payload.data.account as any)?.email}`, eb.payload.data);
  await sleep(1500);
  check((await fake.events('browser', { type: 'account.updated', uuid, after: s2 })).items.length === 0, 'browser got nothing');
}

section('sign out: briefcase revokes its refresh token → membership.signed_out (app_revoked)');
{
  const s1 = await lastSeq('briefcase');
  const st: any = await fake.state('briefcase', true);
  const held = (st.accounts as any[]).find((a) => (a.uuid ?? a.account?.uuid) === uuid);
  const refresh = held?.tokens?.refresh_token ?? held?.refresh_token;
  check(typeof refresh === 'string', 'briefcase holds a refresh token');
  const rv = await accounts.app('briefcase').revoke(refresh);
  check(rv.status === 200, `POST /v1/oauth/revoke → ${rv.status}`, rv.body);
  const eb = await fake.waitForEvent('briefcase', { type: 'membership.signed_out', uuid, after: s1 });
  check(eb.payload.data.reason === 'app_revoked', `reason ${eb.payload.data.reason}`, eb.payload.data);
  const again: any = await accounts.app('briefcase').tokenRaw({ grant_type: 'refresh_token', refresh_token: refresh });
  check(again.status === 400 && again.body?.error === 'invalid_grant', 'the refresh token is dead', again.body);
}

section('access removal on the account site → membership.access_removed; the app\'s refresh fails');
{
  const s2 = await lastSeq('browser');
  const st: any = await fake.state('browser', true);
  const held = (st.accounts as any[]).find((a) => (a.uuid ?? a.account?.uuid) === uuid);
  const refresh = held?.tokens?.refresh_token ?? held?.refresh_token;
  const del = await carbon.browser.http.delete('/v1/me/apps/browser');
  check(del.status === 204, `DELETE /v1/me/apps/browser → ${del.status}`, del.body);
  const ew = await fake.waitForEvent('browser', { type: 'membership.access_removed', uuid, after: s2 });
  check(ew.payload.data.membership_id === `browser:${uuid}`, 'browser got membership.access_removed', ew.payload);
  const r: any = await accounts.app('browser').tokenRaw({ grant_type: 'refresh_token', refresh_token: refresh });
  check(r.status === 400 && r.body?.error === 'invalid_grant', `the app's refresh fails: ${r.body?.error_description}`, r.body);
}

section('every delivery verified (none refused by the fake apps)');
for (const app of ['briefcase', 'browser'] as const) {
  const accepted = (await fake.events(app, { uuid })).items.length;
  const newlyRefused = (await refused(app)) - refusedBefore[app];
  check(newlyRefused === 0, `${app}: ${accepted} events accepted for this Carbon, ${newlyRefused} deliveries refused`);
}

done();
