// Imports fixtures/imports/dirty.csv into legacy-crm with `silicon-accounts app import … --wait` (app
// credentials), compares every row with expected.json, then an imported Carbon signs into
// legacy-crm with a code → signup prefilled (finishing_import) → membership active.
// expected.json assumes a database where dirty.csv was never imported (scripts/journeys.sh
// starts one); on a database that already has it, this journey says so and skips.
import {
  accounts,
  check,
  cli,
  codeStep,
  done,
  driveFlow,
  expectedImportOutcomes,
  fakeApp,
  importFixturePath,
  messaging,
  newBrowser,
  newHome,
  section,
  show,
  signUpCarbon,
  startAppSignIn,
} from './_common.ts';

const legacy = fakeApp('legacy-crm');
const appEnv = { ACCOUNTS_APP_ID: legacy.app_id, ACCOUNTS_APP_SECRET: legacy.secret };
const home = newHome('import');

if (!(await accounts.idAvailable('c:ada_byron')).available) {
  console.log('\nskip: dirty.csv was already imported into this database (c:ada_byron exists); expected.json needs a fresh one (scripts/journeys.sh).');
  process.exit(0);
}

section('precondition for row 40: another account owns +12025550142');
await signUpCarbon({ accounts, messaging, phone: '+12025550142' });

section('silicon-accounts app import dirty.csv --default-country US --wait');
const before = await messaging.lastSeq();
const imp = await cli(home, ['app', 'import', importFixturePath('dirty.csv'), '--default-country', 'US', '--wait', '--json'], { env: appEnv });
const job = imp.json?.job ?? imp.json;
check(imp.code === 0 && job?.status === 'completed', `the import completed (${imp.ms} ms)`, show(imp));
const expected = expectedImportOutcomes('dirty.csv');
for (const k of ['created', 'matched', 'updated', 'skipped', 'error'] as const) {
  check(job?.counts?.[k] === expected.counts[k], `${k}: ${job?.counts?.[k]} (expected ${expected.counts[k]})`);
}

section('every row matches expected.json');
const rows = await accounts.app('legacy-crm').allImportRows(job.id);
check(rows.length === expected.rows.length, `${rows.length} row results`);
let differing = 0;
for (const exp of expected.rows) {
  const got: any = rows.find((r) => r.row_number === exp.row_number);
  const problems: string[] = [];
  if (!got) problems.push('missing');
  else {
    if (got.outcome !== exp.outcome) problems.push(`outcome ${got.outcome} != ${exp.outcome}`);
    if (exp.outcome === 'created') {
      if (exp.id && exp.id_exact !== false && got.id !== exp.id) problems.push(`id ${got.id} != ${exp.id}`);
      if (!/^c:[a-z0-9_-]{3,30}$/.test(got.id ?? '')) problems.push(`invalid id ${got.id}`);
      if (/^c:(admin|support|ab)$/.test(got.id ?? '')) problems.push(`forbidden id ${got.id}`);
    }
    if (exp.matches && got.id !== exp.matches) problems.push(`matched ${got.id} != ${exp.matches}`);
    for (const m of exp.messages) {
      const hit = (got.messages ?? []).find((g: any) => (m.spec_code ? g.code === m.code : true) && g.level === m.level && (!m.field || g.field === m.field));
      if (!hit) problems.push(`no ${m.level} ${m.code}${m.field ? ` (${m.field})` : ''}`);
    }
  }
  if (problems.length) {
    differing++;
    console.log(`  row ${exp.row_number} [${exp.case}]: ${problems.join('; ')}`);
  }
}
check(differing === 0, `${expected.rows.length - differing}/${expected.rows.length} rows as expected`);
check((await messaging.lastSeq()) === before, 'the import sent no email or SMS');

section('an imported Carbon (row 1) signs in → finishing_import → membership active');
{
  const row1: any = rows.find((r) => r.row_number === 1);
  const email = 'ada.byron@legacy-crm.test';
  const app = accounts.app('legacy-crm');
  check((await app.users({ q: email })).items[0]?.status === 'imported', 'the membership starts as imported');
  const browser = await newBrowser();
  const s = await startAppSignIn('legacy-crm', browser);
  let flow = await codeStep(browser, s.flow, { email });
  check(flow.step === 'signup' && flow.signup?.finishing_import === true && flow.signup?.id === row1?.id && flow.signup?.display_name === 'Ada Byron', `signup prefilled from the import (${JSON.stringify(flow.signup)})`, flow);
  flow = await driveFlow(browser, flow, { messaging });
  check(flow.step === 'complete', `completes (got ${flow.step})`, flow);
  const cb: any = await s.fake.callback('legacy-crm', flow.redirect_to!);
  check(cb.account?.uuid === row1?.account_uuid, 'legacy-crm gets the uuid the import created', cb);
  check((await app.users({ q: email })).items[0]?.status === 'active', 'the membership is active');
  const me: any = await browser.account().me();
  check(me.status === 'active' && !!me.emails?.[0]?.verified_at, 'the account is active with a verified email', me);
}

done();
