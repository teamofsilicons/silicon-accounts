// OBO dm → briefcase (POST /dm/actions/save-to-briefcase) and ATA commit → remind + waveform
// (POST /commit/actions/notify) through the fake app server, with timings; a non-audience app
// verifying gets exactly {valid:false, expires_at:null}; verify latency.
import { accounts, check, codeStep, done, driveFlow, FakeAppsClient, fakeAppsUrl, measure, messaging, newBrowser, randomEmail, randomPhone, section, startAppSignIn } from './_common.ts';

const fake = new FakeAppsClient(fakeAppsUrl);
const invalidShape = (v: any) => !!v && Object.keys(v).length === 2 && v.valid === false && v.expires_at === null;

section('a Carbon signs into dm (dm keeps its access token)');
const browser = await newBrowser();
const s = await startAppSignIn('dm', browser);
let flow = await codeStep(browser, s.flow, { email: randomEmail('obo') });
flow = await driveFlow(browser, flow, { messaging, requirements: { phone: randomPhone() } });
const cb: any = await s.fake.callback('dm', flow.redirect_to!);
const uuid = cb.account?.uuid as string;
check(!!uuid, `dm holds the sign-in of ${uuid}`, cb);

section('OBO dm → briefcase');
const obo = await fake.saveToBriefcase({ uuid, filename: 'notes.txt' });
const ob: any = obo.body;
console.log(`  timings ${JSON.stringify(ob.timings)}`);
check(obo.status === 200 && ob.ok === true, 'the OBO demo succeeded', ob);
check(ob.verification?.valid === true && ob.verification?.kind === 'obo' && ob.verification?.issuing_app?.app_id === 'dm' && ob.verification?.receiving_app?.app_id === 'briefcase' && ob.verification?.user?.uuid === uuid, 'briefcase verified a valid OBO proof for that Carbon', ob.verification);

section('ATA commit → remind + waveform (one proof per app)');
const ata = await fake.notify({ message: 'build green' });
const ab: any = ata.body;
console.log(`  timings ${JSON.stringify(ab.timings)}`);
check(ab.proofs?.remind?.receiving_app === 'remind' && ab.proofs?.waveform?.receiving_app === 'waveform' && ab.proofs.remind.proof_id !== ab.proofs.waveform.proof_id, 'commit made two proofs: one for remind, one for waveform', ab.proofs);
check(ata.status === 200 && ab.ok === true && ab.results?.remind?.verification?.valid === true && ab.results?.waveform?.verification?.valid === true, 'remind and waveform each verified their own proof', ab);
const multi: any = await accounts.app('commit').request('POST', '/v1/proofs/ata', { json: { audiences: ['remind', 'waveform'] } });
check(multi.status === 422 && multi.body?.error?.code === 'ata_single_app', 'a proof for several apps at once is refused (ata_single_app)', multi.body);

section('non-audience verification → exactly {valid:false, expires_at:null}');
const issued: any = await fake.issueObo('dm', { uuid, receiving_app: 'briefcase' });
const token = String(issued?.body?.proof_token ?? '');
check(token.startsWith('sap_'), 'dm issued an OBO proof', issued);
check(invalidShape((await fake.verifyProof('remind', token)).verification), 'remind (not the audience) → {valid:false, expires_at:null}');
check((await fake.verifyProof('briefcase', token)).verification?.valid === true, 'briefcase (the audience) → valid');
const ataIssued: any = (await accounts.app('commit').issueAta({ receiving_app: 'remind' })).body;
check(invalidShape(await accounts.app('briefcase').verifyProof(ataIssued.proof_token)), 'briefcase verifying a commit → remind ATA proof → invalid');
check((await accounts.app('remind').verifyProof(ataIssued.proof_token)).valid === true, 'remind (its one app) → valid');
check(invalidShape(await accounts.app('briefcase').verifyProof('sap_unknown')), 'an unknown token → invalid');

section('verify latency (HTTP round trip from the testkit)');
const seq = await measure(300, 1, () => accounts.app('briefcase').verifyProof(token));
const conc = await measure(500, 25, () => accounts.app('briefcase').verifyProof(token));
console.log(`  sequential: p50 ${seq.p50_ms} ms, p95 ${seq.p95_ms} ms, p99 ${seq.p99_ms} ms`);
console.log(`  25 concurrent: p50 ${conc.p50_ms} ms, p95 ${conc.p95_ms} ms, p99 ${conc.p99_ms} ms, ${conc.throughput_per_s}/s`);
check(seq.errors === 0 && conc.errors === 0, 'no errors under load');

done();
