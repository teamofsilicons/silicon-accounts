// `accounts report` → mock Postmark receives one email per recipient, to exactly the three
// addresses UNDERSTANDING.md names. (POST /v1/reports allows 5 per hour per network.)
import { check, cli, done, messaging, newHome, rid, section, show, sleep } from './_common.ts';

const RECIPIENTS = ['bugs@teamofsilicons.com', 'saketdev12@gmail.com', 'shubhastro2@gmail.com'];
const home = newHome('report');
const tag = `journey-report-${rid()}`;

section('accounts report "…" --pr <link>');
const after = await messaging.lastSeq();
const r = await cli(home, ['report', `The ${tag} button does nothing`, '--pr', 'https://github.com/teamofsilicons/silicon-accounts/pull/1', '--json']);
check(r.code === 0 && r.json?.recipients === 3 && r.json?.status === 'queued', 'the report is queued for 3 recipients', show(r));
const got = new Map<string, any>();
for (let i = 0; i < 50 && got.size < 3; i++) {
  for (const m of await messaging.messages({ channel: 'email', after, contains: tag })) got.set(m.to, m);
  if (got.size < 3) await sleep(200);
}
check(JSON.stringify([...got.keys()].sort()) === JSON.stringify(RECIPIENTS), `mock Postmark got exactly ${[...got.keys()].sort().join(', ')}`);
const one = got.get('bugs@teamofsilicons.com');
check(String(one?.text ?? '').includes('pull/1') && String(one?.from ?? '').includes('accounts@teamofsilicons.com'), `from ${one?.from}, carries the PR link`, one);

section('without --pr the CLI points at the repository');
const r2 = await cli(home, ['report', `second ${tag}`]);
check(r2.code === 0 && /github\.com\/teamofsilicons\/silicon-accounts/.test(r2.stdout + r2.stderr), 'mentions the GitHub repo', show(r2));

done();
