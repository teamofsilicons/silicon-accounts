// A new Carbon signs up through the hosted-flow API for briefcase (choosing a photo on the sign-up
// page) and the fake app exchanges the code; the same Carbon signs into dm (requirements step:
// phone); "continue" works on a third app without a code; a second briefcase sign-in completes
// right after continue (no consent); "Not you?" on the sign-up step ends that sign-up.
import { accounts, check, codeStep, done, driveFlow, messaging, newBrowser, pngBytes, randomEmail, randomPhone, section, startAppSignIn } from './_common.ts';

const email = randomEmail('journey-a');
const browser = await newBrowser();

section('briefcase: sign up with an email code');
const b = await startAppSignIn('briefcase', browser);
check(b.flow.step === 'choose_method', `flow starts at choose_method (got ${b.flow.step})`, b.flow);
check(b.flow.methods.includes('email'), `methods ${JSON.stringify(b.flow.methods)}`);
let flow = await codeStep(browser, b.flow, { email });
check(flow.step === 'signup' && flow.signup?.email === email && flow.signup?.finishing_import === false, `signup step prefilled (${flow.signup?.id}, ${flow.signup?.display_name})`, flow.signup);
// The sign-up page uploads the chosen photo before the account exists; it becomes the prefill.
const photo = await browser.signupPhoto(flow.id, pngBytes(96, 96));
check(/\/v1\/photos\/[0-9a-f-]{36}$/.test(photo.pfp_url) && photo.photo.width === 96, `sign-up photo uploaded: ${photo.pfp_url}`, photo);
flow = await browser.flow(flow.id);
check(flow.signup?.pfp_url === photo.pfp_url, 'the uploaded photo is the sign-up prefill', flow.signup);
const served = await fetch(await accounts.toServerUrl(photo.pfp_url));
check(served.status === 200 && served.headers.get('content-type') === 'image/png', `the photo is served (${served.status} ${served.headers.get('content-type')})`);
flow = await driveFlow(browser, flow, { messaging });
check(flow.step === 'complete' && !!flow.redirect_to, `flow completes (got ${flow.step})`, flow);
const cb: any = await b.fake.callback('briefcase', flow.redirect_to!);
check(cb.ok === true && cb.account?.email === email && String(cb.account?.membership_id).startsWith('briefcase:'), `briefcase exchanged the code: ${cb.account?.membership_id}`, cb);
const uuid = cb.account?.uuid as string;
check((await browser.session())?.account.uuid === uuid, 'the browser is signed in as the new Carbon');
check(cb.account?.pfp_url === photo.pfp_url, 'the new account keeps the photo chosen at sign-up', cb.account);

section('dm: continue as + requirements (phone) + consent');
const d = await startAppSignIn('dm', browser);
check(d.flow.step === 'choose_method' && d.flow.signed_in_as?.uuid === uuid, 'dm offers "continue as"', d.flow);
flow = await browser.continueAs(d.flow.id);
check(flow.step === 'requirements' && (flow.requirements?.missing ?? []).includes('phone'), `requirements asks for phone (${JSON.stringify(flow.requirements)})`, flow);
const phone = randomPhone();
flow = await driveFlow(browser, flow, { messaging, requirements: { phone } });
check(flow.step === 'complete', `dm completes (got ${flow.step})`, flow);
const dcb: any = await d.fake.callback('dm', flow.redirect_to!);
check(dcb.account?.phone === phone, `dm gets the phone ${phone}`, dcb);

section('commit: continue as, no code');
const before = await messaging.lastSeq();
const c = await startAppSignIn('commit', browser);
flow = await browser.continueAs(c.flow.id);
if (flow.step === 'consent') flow = await browser.consent(flow.id, true, []);
check(flow.step === 'complete', `commit completes (got ${flow.step})`, flow);
const ccb: any = await c.fake.callback('commit', flow.redirect_to!);
check(ccb.account?.uuid === uuid, 'commit signed in as the same Carbon', ccb);
check((await messaging.lastSeq()) === before, 'no code was sent for commit');

section('briefcase again: continue skips consent (everything already granted)');
const b2 = await startAppSignIn('briefcase', browser);
flow = await browser.continueAs(b2.flow.id);
check(flow.step === 'complete', `completes right after continue (got ${flow.step})`, flow);

section('"Not you?" on the sign-up step ends that sign-up');
{
  // In a browser where someone is signed in (the page can't clear the cookie itself there).
  const other = randomEmail('journey-a-notyou');
  const s = await startAppSignIn('briefcase', browser, { prompt: 'login' });
  let f = await codeStep(browser, s.flow, { email: other });
  check(f.step === 'signup', `a new address reaches sign-up (got ${f.step})`, f);
  f = await browser.switchAccount(f.id);
  check(f.step === 'choose_method', `switch → choose_method (got ${f.step})`, f);
  const again = await startAppSignIn('briefcase', browser, { prompt: 'login' });
  check(again.flow.step === 'choose_method', `a new flow does not resume the abandoned sign-up (got ${again.flow.step})`, again.flow);
  check((await browser.session())?.account.uuid === uuid, 'the signed-in Carbon stays signed in');
}

done();
