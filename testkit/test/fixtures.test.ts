import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bigCsvLines, expectedImportOutcomes, generateBigCsv, importFixtureBytes, importFixtureRows, uniquifyEmails } from '../lib/fixtures.ts';

/** RFC 4180 record splitter (quotes, escaped quotes, quoted newlines), enough to count rows. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else cell += c;
  }
  if (cell || record.length) {
    record.push(cell);
    records.push(record);
  }
  return records;
}

const testkitRoot = fileURLToPath(new URL('..', import.meta.url));

describe('import fixtures', () => {
  test('are generated and up to date', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/build-import-fixtures.ts', '--check'], { cwd: testkitRoot }).toString();
    assert.match(out, /up to date/);
  });

  test('dirty.csv starts with a UTF-8 BOM, uses CRLF, and has one expectation per record', () => {
    const bytes = importFixtureBytes('dirty.csv');
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8').slice(1);
    assert.ok(text.includes('\r\n'));
    const [header, ...rows] = parseCsv(text);
    assert.equal(header?.join(','), 'external_id,email,emails,phone,phones,display_name,username,dob,timezone,pfp_url,email_verified');
    const expected = expectedImportOutcomes('dirty.csv');
    assert.equal(rows.length, expected.rows.length);
    // The quoted newline stays inside row 36; ragged rows keep their cell counts.
    assert.equal(rows[35]?.[5], 'Lin\nHopper');
    assert.equal(rows[32]?.length, 13);
    assert.equal(rows[33]?.length, 6);
    assert.equal(rows[34]?.[5], 'Smith, John');
    assert.equal(rows[36]?.[5], 'Robert "Bob" Tables');
  });

  test('every dirty case the spec lists is present', () => {
    const cases = expectedImportOutcomes('dirty.csv').rows.map((r) => r.case.toLowerCase());
    const has = (needle: string): boolean => cases.some((c) => c.includes(needle));
    for (const needle of ['mixed-case email', 'spaces', 'duplicate of row', 'invalid email', 'phone with letters', 'local-format', 'no email and no phone', 'unicode name', 'dob in the future', 'date format', 'unknown timezone', 'extra columns', 'quoted comma', 'quoted newline', 'existing account', 'two different existing accounts', 'collides with an existing c:id', 'not a valid handle', 'reserved word', 'duplicate external_id']) {
      assert.ok(has(needle), `missing case: ${needle}`);
    }
    const counts = expectedImportOutcomes('dirty.csv').counts;
    assert.ok(counts.created > 30 && counts.error >= 8 && counts.skipped === 3 && counts.matched === 1, JSON.stringify(counts));
  });

  test('clean.csv rows are all created; dirty.json and unknown-columns parse', () => {
    const clean = parseCsv(importFixtureBytes('clean.csv').toString('utf8'));
    assert.equal(clean.length - 1, 25);
    assert.ok(expectedImportOutcomes('clean.csv').rows.every((r) => r.outcome === 'created'));
    assert.equal(importFixtureRows('dirty.json').length, expectedImportOutcomes('dirty.json').rows.length);
    const unknownHeader = parseCsv(importFixtureBytes('unknown-columns.csv').toString('utf8'))[0];
    assert.deepEqual(unknownHeader?.slice(3), ['favorite_color', 'plan', 'last_login_at']);
    assert.equal(importFixtureRows('unknown-columns.json').length, 5);
  });

  test('big.csv generation is deterministic, unique and fast', () => {
    const started = performance.now();
    const lines = [...bigCsvLines({ rows: 20_000, seed: 7, tag: 'unit' })];
    assert.ok(performance.now() - started < 2_000);
    assert.equal(lines.length, 20_001);
    const emails = new Set<string>();
    const phones = new Set<string>();
    for (const line of lines.slice(1)) {
      const [, email, phone] = line.split(',');
      assert.ok(!emails.has(email ?? ''), `duplicate email ${email}`);
      emails.add(email ?? '');
      if (phone) {
        assert.match(phone, /^\+1\d{3}555\d{4}$/);
        assert.ok(!phones.has(phone), `duplicate phone ${phone}`);
        phones.add(phone);
      }
    }
    assert.equal(generateBigCsv({ rows: 50, seed: 7, tag: 'unit' }), `${lines.slice(0, 51).join('\n')}\n`);
  });

  test('big.csv phones never collide with the 555-01xx numbers of clean.csv / dirty.csv', () => {
    const fixturePhones = new Set(
      [importFixtureBytes('clean.csv').toString('utf8'), importFixtureBytes('dirty.csv').toString('utf8')].flatMap((text) => text.match(/\+1\d{3}555\d{4}/g) ?? []),
    );
    assert.ok(fixturePhones.size > 10);
    for (const line of bigCsvLines({ rows: 100_000, phoneRatio: 1 })) {
      const phone = line.split(',')[2];
      if (phone && phone !== 'phone') assert.ok(!fixturePhones.has(phone), phone);
    }
  });

  test('uniquifyEmails tags test-domain addresses only', () => {
    assert.equal(uniquifyEmails('a@legacy-crm.test,b@example.test,c@gmail.com', 'r1'), 'a+r1@legacy-crm.test,b+r1@example.test,c@gmail.com');
  });
});
