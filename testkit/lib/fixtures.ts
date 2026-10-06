// Import fixtures (testkit/fixtures/imports) and the big.csv generator.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ImportRow } from './types.ts';

export const IMPORT_FIXTURES_DIR = fileURLToPath(new URL('../fixtures/imports/', import.meta.url));

export type ImportFixture = 'clean.csv' | 'dirty.csv' | 'dirty.json' | 'unknown-columns.csv' | 'unknown-columns.json' | 'big.csv';

export function importFixturePath(name: ImportFixture | string): string {
  return `${IMPORT_FIXTURES_DIR}${name}`;
}

/** Raw bytes (dirty.csv starts with a UTF-8 BOM and uses CRLF line endings on purpose). */
export function importFixtureBytes(name: ImportFixture | string): Buffer {
  try {
    return readFileSync(importFixturePath(name));
  } catch (error) {
    const hint = name === 'big.csv' ? ' Generate it with `pnpm -C testkit gen:big`.' : '';
    throw new Error(`Cannot read import fixture ${name}: ${(error as Error).message}.${hint}`);
  }
}

/** JSON fixtures: `{"rows":[ImportRow…]}`. */
export function importFixtureRows(name: 'dirty.json' | 'unknown-columns.json' | string): ImportRow[] {
  const parsed = JSON.parse(importFixtureBytes(name).toString('utf8')) as { rows?: ImportRow[] };
  if (!Array.isArray(parsed.rows)) throw new Error(`${name} has no "rows" array.`);
  return parsed.rows;
}

export interface ExpectedMessage {
  level: 'error' | 'warning' | 'info';
  /** Message code; codes the spec does not name are suggestions (see README). */
  code: string;
  field?: string;
  /** true when the spec names this code exactly. */
  spec_code?: boolean;
}

export interface ExpectedRow {
  row_number: number;
  case: string;
  outcome: 'created' | 'matched' | 'updated' | 'skipped' | 'error';
  /** For created rows: the id the import should assign (null = any valid id). */
  id?: string | null;
  /** false when `id` is only the likely suggestion; assert the exact id only when true. */
  id_exact?: boolean;
  /** For matched rows: the existing account's id. */
  matches?: string;
  messages: ExpectedMessage[];
  /** Extra expectations in words. */
  notes?: string;
  /** Preconditions the e2e suite must set up first (else the outcome differs, see notes). */
  precondition?: string;
}

export interface ExpectedFile {
  file: string;
  options: Record<string, unknown>;
  rows: ExpectedRow[];
  counts: { created: number; matched: number; updated: number; skipped: number; error: number };
}

/** Machine-readable expected outcomes per fixture row (fixtures/imports/expected.json). */
export function expectedImportOutcomes(file: 'clean.csv' | 'dirty.csv' | 'dirty.json' | 'unknown-columns.csv' | string): ExpectedFile {
  const all = JSON.parse(readFileSync(importFixturePath('expected.json'), 'utf8')) as { files: ExpectedFile[] };
  const found = all.files.find((f) => f.file === file);
  if (!found) throw new Error(`fixtures/imports/expected.json has no entry for ${file}.`);
  return found;
}

/** Replaces every `@example.test` style domain-local email with a run-unique variant (`local+tag@domain`). */
export function uniquifyEmails(text: string, tag: string): string {
  return text.replace(/([A-Za-z0-9._%-]+)@((?:[A-Za-z0-9-]+\.)*(?:test|example))\b/g, (_m, local: string, domain: string) => `${local}+${tag}@${domain}`);
}

// ------------------------------------------------------------------ big.csv

/** Small deterministic PRNG (mulberry32) so big.csv is reproducible for a seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FIRST = ['Ada', 'Grace', 'Alan', 'Katherine', 'Dorothy', 'Linus', 'Margaret', 'Edsger', 'Barbara', 'Donald', 'Radia', 'Ken', 'Frances', 'Tim', 'Hedy', 'Claude', 'Sophie', 'Niklaus', 'Joan', 'Dennis', 'Anita', 'John', 'Shafi', 'Leslie', 'Mary', 'Vint', 'Lynn', 'Bjarne', 'Ruth', 'Guido', 'Zoë', 'José', 'Søren', 'Aiko', 'Priya', 'Wei', 'Olu', 'Chiara', 'Mateo', 'Noor'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Johnson', 'Vaughan', 'Torvalds', 'Hamilton', 'Dijkstra', 'Liskov', 'Knuth', 'Perlman', 'Thompson', 'Allen', 'Berners-Lee', 'Lamarr', 'Shannon', 'Wilson', 'Wirth', 'Clarke', 'Ritchie', 'Borg', 'McCarthy', 'Goldwasser', 'Lamport', 'Keller', 'Cerf', 'Conway', 'Stroustrup', 'Teitelbaum', 'van Rossum', 'Müller', 'García', 'Kierkegaard', 'Tanaka', 'Sharma', 'Zhang', 'Adeyemi', 'Rossi', 'Fernández', 'Haddad'];
const ZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Kolkata', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney', 'America/Sao_Paulo', 'Africa/Lagos', 'Asia/Dubai'];
const BIG_AREAS = ['201', '202', '206', '212', '213', '303', '305', '312', '404', '415', '503', '512', '617', '646', '650', '702', '718', '805', '917', '949'];

export interface BigCsvOptions {
  rows?: number;
  seed?: number;
  /** Makes emails/usernames/external ids unique per run (default "bulk"). */
  tag?: string;
  /** Fraction of rows that also carry a phone (default 0.2). Phones are unique within the file. */
  phoneRatio?: number;
}

/** Streams big.csv lines (header first) so 100k rows never need one giant string. */
export function* bigCsvLines(options: BigCsvOptions = {}): Generator<string> {
  const rows = options.rows ?? 100_000;
  const random = prng(options.seed ?? 42);
  const tag = (options.tag ?? 'bulk').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const phoneRatio = options.phoneRatio ?? 0.2;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  yield 'external_id,email,phone,display_name,username,dob,timezone';
  let phoneCounter = 0;
  for (let i = 1; i <= rows; i++) {
    const n = String(i).padStart(6, '0');
    const first = pick(FIRST);
    const last = pick(LAST);
    const email = `carbon${n}.${tag}@bulk.example.test`;
    let phone = '';
    if (random() < phoneRatio) {
      // Unique per file: area cycles through BIG_AREAS, the line number counts up from 2000 so it
      // never meets the 555-01xx numbers used by clean.csv / dirty.csv (max 100k rows → line ≤ 6999).
      const area = BIG_AREAS[phoneCounter % BIG_AREAS.length]!;
      const line = String(2000 + Math.floor(phoneCounter / BIG_AREAS.length)).padStart(4, '0');
      phoneCounter += 1;
      phone = `+1${area}555${line}`;
    }
    const year = 1950 + Math.floor(random() * 55);
    const month = String(1 + Math.floor(random() * 12)).padStart(2, '0');
    const day = String(1 + Math.floor(random() * 28)).padStart(2, '0');
    const name = `${first} ${last}`;
    const quoted = /[",]/.test(name) ? `"${name.replaceAll('"', '""')}"` : name;
    yield `${tag}-${n},${email},${phone},${quoted},${tag}-${n},${year}-${month}-${day},${pick(ZONES)}`;
  }
}

export function generateBigCsv(options: BigCsvOptions = {}): string {
  return `${[...bigCsvLines(options)].join('\n')}\n`;
}
