// Generates testkit/fixtures/imports/{clean.csv, dirty.csv, dirty.json, unknown-columns.csv,
// unknown-columns.json, expected.json, README.md} from the tables below, so the files, the
// machine-readable expectations and the documentation can never disagree.
//   pnpm -C testkit gen:fixtures            # write
//   pnpm -C testkit gen:fixtures --check    # exit 1 if any committed file is stale

import { readFileSync, writeFileSync } from 'node:fs';
import type { ExpectedFile, ExpectedMessage, ExpectedRow } from '../lib/fixtures.ts';
import { IMPORT_FIXTURES_DIR } from '../lib/fixtures.ts';

type Outcome = ExpectedRow['outcome'];

interface RowSpec {
  /** Raw CSV record text (may contain a quoted newline) or a JSON row object. */
  line?: string;
  json?: Record<string, unknown>;
  case: string;
  outcome: Outcome;
  id?: string | null;
  /** false when the id is the importer's own suggestion (tests should accept any valid id). */
  id_exact?: boolean;
  matches?: string;
  messages?: ExpectedMessage[];
  notes?: string;
  precondition?: string;
}

const warn = (code: string, field?: string, spec = false): ExpectedMessage => ({ level: 'warning', code, ...(field ? { field } : {}), spec_code: spec });
const err = (code: string, field?: string, spec = true): ExpectedMessage => ({ level: 'error', code, ...(field ? { field } : {}), spec_code: spec });
const skip = (code: string): ExpectedMessage => ({ level: 'info', code, spec_code: true });

// ------------------------------------------------------------------ clean.csv

const CLEAN_HEADER = 'external_id,email,phone,display_name,username,dob,timezone';
const CLEAN_PEOPLE: Array<[string, string, string, string, string, string]> = [
  ['clean.ada@legacy-crm.test', '+13035550101', 'Ada King', 'clean_ada', '1985-12-10', 'Europe/London'],
  ['clean.grace@legacy-crm.test', '+13035550102', 'Grace Brewster', 'clean_grace', '1976-12-09', 'America/New_York'],
  ['clean.alan@legacy-crm.test', '', 'Alan Mathers', 'clean_alan', '1982-06-23', 'Europe/London'],
  ['clean.katherine@legacy-crm.test', '+13035550104', 'Katherine Goble', 'clean_katherine', '1968-08-26', 'America/New_York'],
  ['clean.dorothy@legacy-crm.test', '', 'Dorothy Mann', 'clean_dorothy', '1970-09-20', 'America/Chicago'],
  ['', '+13035550106', 'Linus Benedict', 'clean_linus', '1989-12-28', 'Europe/Helsinki'],
  ['clean.margaret@legacy-crm.test', '+13035550107', 'Margaret Heafield', 'clean_margaret', '1986-08-17', 'America/Los_Angeles'],
  ['clean.edsger@legacy-crm.test', '', 'Edsger Wybe', 'clean_edsger', '1980-05-11', 'Europe/Amsterdam'],
  ['clean.barbara@legacy-crm.test', '+13035550109', 'Barbara Jane', 'clean_barbara', '1979-11-07', 'America/Los_Angeles'],
  ['clean.donald@legacy-crm.test', '', 'Donald Ervin', 'clean_donald', '1988-01-10', 'America/Los_Angeles'],
  ['clean.radia@legacy-crm.test', '+13035550111', 'Radia Joy', 'clean_radia', '1991-12-18', 'America/New_York'],
  ['clean.ken@legacy-crm.test', '', 'Ken Lane', 'clean_ken', '1983-02-04', 'America/Los_Angeles'],
  ['clean.frances@legacy-crm.test', '+13035550113', 'Frances Elizabeth', 'clean_frances', '1972-08-04', 'America/New_York'],
  ['clean.tim@legacy-crm.test', '', 'Tim John', 'clean_tim', '1975-06-08', 'Europe/London'],
  ['clean.hedy@legacy-crm.test', '+13035550115', 'Hedy Kiesler', 'clean_hedy', '1974-11-09', 'Europe/Vienna'],
  ['clean.claude@legacy-crm.test', '', 'Claude Elwood', 'clean_claude', '1976-04-30', 'America/New_York'],
  ['clean.sophie@legacy-crm.test', '+13035550117', 'Sophie Mary', 'clean_sophie', '1987-06-28', 'Europe/London'],
  ['clean.niklaus@legacy-crm.test', '', 'Niklaus Emil', 'clean_niklaus', '1984-02-15', 'Europe/Zurich'],
  ['clean.joan@legacy-crm.test', '+13035550119', 'Joan Elisabeth', 'clean_joan', '1977-09-17', 'Europe/London'],
  ['clean.dennis@legacy-crm.test', '', 'Dennis MacAlistair', 'clean_dennis', '1981-09-09', 'America/New_York'],
  ['clean.anita@legacy-crm.test', '+13035550121', 'Anita Borg', 'clean_anita', '1979-01-17', 'America/Chicago'],
  ['clean.priya@legacy-crm.test', '+919876543210', 'Priya Raman', 'clean_priya', '1993-03-21', 'Asia/Kolkata'],
  ['clean.wei@legacy-crm.test', '', 'Wei Zhang', 'clean_wei', '1990-10-01', 'Asia/Shanghai'],
  ['clean.olu@legacy-crm.test', '+4915123456789', 'Olu Adeyemi', 'clean_olu', '1992-05-05', 'Europe/Berlin'],
  ['clean.aiko@legacy-crm.test', '', 'Aiko Tanaka', 'clean_aiko', '1995-07-07', 'Asia/Tokyo'],
];

const CLEAN: RowSpec[] = CLEAN_PEOPLE.map(([email, phone, name, username, dob, tz], i) => ({
  line: `clean-${String(i + 1).padStart(3, '0')},${email},${phone},${name},${username},${dob},${tz}`,
  case: email && phone ? 'email + phone' : email ? 'email only' : 'phone only',
  outcome: 'created',
  id: `c:${username}`,
  messages: [],
}));

// ------------------------------------------------------------------ dirty.csv

const DIRTY_HEADER = 'external_id,email,emails,phone,phones,display_name,username,dob,timezone,pfp_url,email_verified';
const PRECONDITION_PHONE = '+12025550142';

const DIRTY: RowSpec[] = [
  { line: 'crm-001,ada.byron@legacy-crm.test,,+14155550101,,Ada Byron,ada_byron,1990-04-12,Europe/London,https://images.legacy-crm.test/avatars/ada.png,true', case: 'clean baseline row (after the BOM-prefixed header)', outcome: 'created', id: 'c:ada_byron', messages: [] },
  { line: 'crm-002,Grace.Murray@Legacy-CRM.TEST,,,,Grace Murray,grace_murray,1985-12-09,America/New_York,,TRUE', case: 'mixed-case email', outcome: 'created', id: 'c:grace_murray', messages: [], notes: 'Email stored lower-cased: grace.murray@legacy-crm.test.' },
  { line: '  crm-003  ,   alan.mathison@legacy-crm.test   ,,  +1 415 555 0103  ,,   Alan Mathison   ,  alan_m  , 1991-06-23 ,  Asia/Kolkata  ,,', case: 'spaces around every value', outcome: 'created', id: 'c:alan_m', messages: [], notes: 'Everything trimmed: external_id crm-003, phone +14155550103, display name "Alan Mathison", timezone Asia/Kolkata.' },
  { line: 'crm-001,ada.byron@legacy-crm.test,,+14155550101,,Ada Byron,ada_byron,1990-04-12,Europe/London,https://images.legacy-crm.test/avatars/ada.png,true', case: 'exact duplicate of row 1', outcome: 'skipped', messages: [skip('duplicate_in_file')], notes: 'References row 1.' },
  { line: 'crm-005,not-an-email,,+14155550105,,Edsger Wybe,edsger,1970-05-11,Europe/Amsterdam,,', case: 'invalid email, valid phone', outcome: 'created', id: 'c:edsger', messages: [warn('invalid_email', 'email')], notes: 'Created with the phone only.' },
  { line: 'crm-006,foo@@bar.test,,,,Double At,,1980-01-01,UTC,,', case: 'invalid email (two @), no other identifier', outcome: 'error', messages: [warn('invalid_email', 'email'), err('missing_identifier')] },
  { line: 'crm-007,jane.doe@,,,,Jane Doe,,1979-03-30,UTC,,', case: 'email without a domain, no other identifier', outcome: 'error', messages: [warn('invalid_email', 'email'), err('missing_identifier')] },
  { line: 'crm-008,john smith@legacy-crm.test,,12345,,John Smith,,1975-08-19,UTC,,', case: 'email with a space and a 5-digit phone', outcome: 'error', messages: [warn('invalid_email', 'email'), warn('invalid_phone', 'phone', true), err('missing_identifier')] },
  { line: 'crm-009,barbara.liskov@legacy-crm.test,,+1 (555) abc,,Barbara Liskov,barbara,1939-11-07,America/Los_Angeles,,', case: 'phone with letters', outcome: 'created', id: 'c:barbara', messages: [warn('invalid_phone', 'phone', true)], notes: 'Phone dropped, row created with the email.' },
  { line: 'crm-010,margaret.h@legacy-crm.test,,+447700900123,,Margaret Hamilton,margaret_h,1936-08-17,America/New_York,,', case: 'well-formed but unassigned number (UK drama range)', outcome: 'created', id: 'c:margaret_h', messages: [warn('invalid_phone', 'phone', true)], notes: 'libphonenumber (and the Rust phonenumber crate) reject +44 7700 900xxx.' },
  { line: 'crm-011,,,(415) 555-0123,,Katherine Coleman,katherine_c,1918-08-26,America/New_York,,', case: 'local-format US phone, no email', outcome: 'created', id: 'c:katherine_c', messages: [], notes: 'Normalised with default_country US to +14155550123.' },
  { line: 'crm-012,,,415.555.0199,,Dorothy Johnson,dorothy_j,1910-09-20,America/Chicago,,', case: 'local-format phone with dots', outcome: 'created', id: 'c:dorothy_j', messages: [], notes: 'Normalised to +14155550199.' },
  { line: 'crm-013,,,020 7946 0018,,Lionel Gracie,,1966-02-14,Europe/London,,', case: 'UK local number read with default_country US', outcome: 'error', messages: [warn('invalid_phone', 'phone', true), err('missing_identifier')], notes: 'Valid in GB, invalid as a US number.' },
  { line: 'crm-014,,,,,Nobody At All,nobody,1990-01-01,UTC,,', case: 'no email and no phone', outcome: 'error', messages: [err('missing_identifier')] },
  { line: 'crm-015,zoe.saldana@legacy-crm.test,,,,Zoë Saldaña,,1978-06-19,America/New_York,,', case: 'unicode name (Latin diacritics), no username', outcome: 'created', id: 'c:zoe-saldana', id_exact: false, messages: [], notes: 'Display name kept exactly; id suggested from the email.' },
  { line: 'crm-016,bruce.lee@legacy-crm.test,,,,李小龙,,1940-11-27,Asia/Hong_Kong,,', case: 'unicode name (CJK)', outcome: 'created', id: 'c:bruce-lee', id_exact: false, messages: [], notes: 'Display name "李小龙".' },
  { line: 'crm-017,olaf.angstrom@legacy-crm.test,,,,Ølaf Ångström,olaf,1965-03-03,Europe/Stockholm,,', case: 'unicode name (Nordic letters)', outcome: 'created', id: 'c:olaf', messages: [] },
  { line: 'crm-018,mo.salah@legacy-crm.test,,,,محمد صلاح,,1992-06-15,Africa/Cairo,,', case: 'unicode name (right-to-left script)', outcome: 'created', id: 'c:mo-salah', id_exact: false, messages: [] },
  { line: 'crm-019,rocket.raccoon@legacy-crm.test,,,,Rocket 🚀 Raccoon,rocket,2000-02-29,UTC,,', case: 'emoji in the name; leap-day dob', outcome: 'created', id: 'c:rocket', messages: [], notes: 'dob 2000-02-29 is valid.' },
  { line: 'crm-020,future.kid@legacy-crm.test,,,,Future Kid,future_kid,2099-01-01,UTC,,', case: 'dob in the future', outcome: 'created', id: 'c:future_kid', messages: [warn('invalid_dob', 'dob')], notes: 'dob falls back to the default.' },
  { line: 'crm-021,old.timer@legacy-crm.test,,,,Old Timer,old_timer,1850-05-05,UTC,,', case: 'dob before 1900-01-01', outcome: 'created', id: 'c:old_timer', messages: [warn('invalid_dob', 'dob')] },
  { line: 'crm-022,feb.thirty@legacy-crm.test,,,,Feb Thirty,feb_thirty,31/02/2001,UTC,,', case: 'impossible date (31 February)', outcome: 'created', id: 'c:feb_thirty', messages: [warn('invalid_dob', 'dob')] },
  { line: 'crm-023,banana.date@legacy-crm.test,,,,Banana Date,banana_date,banana,UTC,,', case: 'dob that is not a date', outcome: 'created', id: 'c:banana_date', messages: [warn('invalid_dob', 'dob')] },
  { line: 'crm-024,ambiguous.date@legacy-crm.test,,,,Ambiguous Date,ambiguous_date,04/05/1990,UTC,,', case: 'ambiguous dd/mm vs mm/dd date', outcome: 'created', id: 'c:ambiguous_date', messages: [warn('invalid_dob', 'dob')], notes: '4 May or 5 April: the spec accepts DD/MM and MM/DD only when unambiguous, so the default dob is used (an `ambiguous_dob` code is fine too).' },
  { line: 'crm-025,iso.date@legacy-crm.test,,,,Iso Date,iso_date,1987-11-23,UTC,,', case: 'date format YYYY-MM-DD', outcome: 'created', id: 'c:iso_date', messages: [], notes: 'dob 1987-11-23.' },
  { line: 'crm-026,dmy.date@legacy-crm.test,,,,Dmy Date,dmy_date,23/11/1987,UTC,,', case: 'date format DD/MM/YYYY (unambiguous)', outcome: 'created', id: 'c:dmy_date', messages: [], notes: 'dob 1987-11-23.' },
  { line: 'crm-027,mdy.date@legacy-crm.test,,,,Mdy Date,mdy_date,11/23/1987,UTC,,', case: 'date format MM/DD/YYYY (unambiguous)', outcome: 'created', id: 'c:mdy_date', messages: [], notes: 'dob 1987-11-23.' },
  { line: 'crm-028,ymd.date@legacy-crm.test,,,,Ymd Date,ymd_date,1987/11/23,UTC,,', case: 'date format YYYY/MM/DD', outcome: 'created', id: 'c:ymd_date', messages: [], notes: 'dob 1987-11-23.' },
  { line: 'crm-029,same.day@legacy-crm.test,,,,Same Day,same_day,07/07/1993,UTC,,', case: 'slash date where both readings agree', outcome: 'created', id: 'c:same_day', messages: [], notes: 'dob 1993-07-07.' },
  { line: 'crm-030,mars.colonist@legacy-crm.test,,,,Mars Colonist,mars,1995-07-04,Mars/Olympus_Mons,,', case: 'unknown timezone', outcome: 'created', id: 'c:mars', messages: [warn('invalid_timezone', 'timezone')], notes: 'timezone falls back to UTC.' },
  { line: 'crm-031,offset.zone@legacy-crm.test,,,,Offset Zone,offset_zone,1995-07-04,GMT+5:30,,', case: 'UTC offset instead of an IANA name', outcome: 'created', id: 'c:offset_zone', messages: [warn('invalid_timezone', 'timezone')], notes: 'timezone UTC.' },
  { line: 'crm-032,windows.zone@legacy-crm.test,,,,Windows Zone,windows_zone,1995-07-04,Pacific Standard Time,,', case: 'Windows timezone name', outcome: 'created', id: 'c:windows_zone', messages: [warn('invalid_timezone', 'timezone')], notes: 'timezone UTC.' },
  { line: 'crm-033,ragged.row@legacy-crm.test,,,,Ragged Row,ragged,1988-08-08,UTC,,,extra cell,another extra', case: 'extra columns: 13 cells under an 11-column header', outcome: 'created', id: 'c:ragged', messages: [warn('extra_fields')], notes: 'The two cells without a header are ignored (parse the CSV flexibly).' },
  { line: 'crm-034,short.row@legacy-crm.test,,,,Short Row', case: 'short row: trailing cells missing', outcome: 'created', id: 'c:short-row', id_exact: false, messages: [], notes: 'Missing trailing cells read as empty (default dob, timezone UTC). A warning about the short row is acceptable.' },
  { line: 'crm-035,j.smith.quoted@legacy-crm.test,,,,"Smith, John",,1962-10-10,UTC,,', case: 'quoted comma inside the name', outcome: 'created', id: 'c:j-smith-quoted', id_exact: false, messages: [], notes: 'Display name "Smith, John" (one cell, not two).' },
  { line: 'crm-036,lin.hopper@legacy-crm.test,,,,"Lin\nHopper",lin_hopper,1966-12-09,UTC,,', case: 'quoted newline inside the name', outcome: 'created', id: 'c:lin_hopper', messages: [], notes: 'This record spans two physical lines but is still one row. Display names may not contain control characters, so the newline becomes a single space: "Lin Hopper".' },
  { line: 'crm-037,bobby.tables@legacy-crm.test,,,,"Robert ""Bob"" Tables",bobby_tables,1999-09-09,UTC,,', case: 'escaped quotes inside a quoted cell', outcome: 'created', id: 'c:bobby_tables', messages: [], notes: 'Display name: Robert "Bob" Tables.' },
  { line: 'crm-038,SaketDev12@Example.TEST,,,,Saket From CRM,saket_crm,1995-01-01,Asia/Kolkata,,', case: "email (in another case) of an existing account (c:saket, seeded owner)", outcome: 'matched', matches: 'c:saket', messages: [], notes: 'Membership legacy-crm:{uuid of c:saket} with status imported; c:saket keeps its own name, id and dob (import never overwrites account data).' },
  { line: 'crm-039,dev@acme-notes.test,dev@orbit-games.test,,,Acme Orbit,,1990-01-01,UTC,,', case: 'identifiers match two different existing accounts (c:acme-dev and c:orbit-dev)', outcome: 'error', messages: [err('ambiguous_match')] },
  {
    line: `crm-040,dev@quill-docs.test,,${PRECONDITION_PHONE},,Quill Phone,,1990-01-01,UTC,,`,
    case: 'email of one account (c:quill-dev) and phone of another',
    outcome: 'error',
    messages: [err('ambiguous_match')],
    precondition: `Before importing, give another account the phone ${PRECONDITION_PHONE} (e.g. sign a fresh Carbon up with it).`,
    notes: `Without the precondition the phone belongs to nobody, so the row is matched to c:quill-dev instead.`,
  },
  { line: 'crm-041,saket.kumar@legacy-crm.test,,,,Saket Kumar,saket,1994-04-04,Asia/Kolkata,,', case: 'username collides with an existing c:id (c:saket)', outcome: 'created', id: 'c:saket-2', id_exact: false, messages: [warn('id_conflict', 'username', true)], notes: 'Message like "id_conflict: wanted c:saket, assigned c:saket-2".' },
  { line: 'crm-042,shubham.k@legacy-crm.test,,,,Shubham K,c:shubham,1996-06-06,Asia/Kolkata,,', case: 'c:-prefixed username that collides (c:shubham)', outcome: 'created', id: 'c:shubham-2', id_exact: false, messages: [warn('id_conflict', 'username', true)] },
  { line: 'crm-043,john.q@legacy-crm.test,,,,John Q Smith,John Smith!,1970-01-01,UTC,,', case: 'username that is not a valid handle ("John Smith!")', outcome: 'created', id: 'c:john-smith', id_exact: false, messages: [warn('invalid_username', 'username')], notes: 'Suggested from the username: lower-cased, invalid characters collapsed to "-", trimmed. `id_conflict` is an acceptable code.' },
  { line: 'crm-044,al.short@legacy-crm.test,,,,Al Short,ab,1970-01-01,UTC,,', case: 'username too short (2 characters)', outcome: 'created', id: null, id_exact: false, messages: [warn('invalid_username', 'username')], notes: 'Any valid suggested id; never c:ab.' },
  { line: 'crm-045,long.name@legacy-crm.test,,,,Long Name,this_username_is_much_too_long_for_accounts,1970-01-01,UTC,,', case: 'username longer than 30 characters', outcome: 'created', id: null, id_exact: false, messages: [warn('invalid_username', 'username')], notes: 'Any valid id of at most 30 characters.' },
  { line: 'crm-046,the.admin@legacy-crm.test,,,,The Admin,admin,1970-01-01,UTC,,', case: 'reserved word as username (admin)', outcome: 'created', id: null, id_exact: false, messages: [warn('reserved_username', 'username')], notes: 'Never c:admin. `id_conflict` is an acceptable code.' },
  { line: 'crm-047,help.desk@legacy-crm.test,,,,Help Desk,SUPPORT,1970-01-01,UTC,,', case: 'reserved word in upper case (SUPPORT)', outcome: 'created', id: null, id_exact: false, messages: [warn('reserved_username', 'username')], notes: 'Never c:support.' },
  { line: 'crm-048,ada.lower@legacy-crm.test,,,,Ada Lower,ADA_L,1970-01-01,UTC,,', case: 'valid username in upper case', outcome: 'created', id: 'c:ada_l', messages: [], notes: 'Handles are case-insensitive and stored lower-case.' },
  { line: 'crm-050,first.dup@legacy-crm.test,,,,First Dup,first_dup,1970-01-01,UTC,,', case: 'first use of external_id crm-050', outcome: 'created', id: 'c:first_dup', messages: [] },
  { line: 'crm-050,second.dup@legacy-crm.test,,,,Second Dup,second_dup,1970-01-01,UTC,,', case: 'duplicate external_id (crm-050) for a different person', outcome: 'error', messages: [err('external_id_conflict', 'external_id')] },
  { line: 'crm-051,ADA.BYRON@LEGACY-CRM.TEST,,,,Ada Again,,1990-04-12,UTC,,', case: 'same email as row 1 in another case', outcome: 'skipped', messages: [skip('duplicate_in_file')], notes: 'Emails are normalised before de-duplication; references row 1.' },
  { line: 'crm-052,katherine.again@legacy-crm.test,,+1 415-555-0123,,Katherine Again,,1918-08-26,UTC,,', case: 'same phone as row 11 in another format (new email)', outcome: 'skipped', messages: [skip('duplicate_in_file')], notes: 'Phones are normalised to E.164 before de-duplication; references row 11.' },
  { line: 'crm-053,multi.primary@legacy-crm.test,multi.second@legacy-crm.test;multi.third@legacy-crm.test,,,Multi Mail,multi_mail,1980-02-02,UTC,,', case: 'several emails (email + ;-separated emails)', outcome: 'created', id: 'c:multi_mail', messages: [], notes: 'Three unverified emails; multi.primary@legacy-crm.test is primary.' },
  { line: 'crm-054,multi.phone@legacy-crm.test,,+12125550154,+12125550155;(212) 555-0156,Multi Phone,multi_phone,1980-02-02,America/New_York,,', case: 'several phones (phone + ;-separated phones, mixed formats)', outcome: 'created', id: 'c:multi_phone', messages: [], notes: 'Phones +12125550154 (primary), +12125550155, +12125550156.' },
  { line: 'crm-055,http.avatar@legacy-crm.test,,,,Http Avatar,http_avatar,1980-02-02,UTC,http://images.legacy-crm.test/avatars/55.png,', case: 'pfp_url over plain http', outcome: 'created', id: 'c:http_avatar', messages: [warn('invalid_pfp_url', 'pfp_url')], notes: 'pfp falls back to the default Carbon photo (https only).' },
  { line: ',,,,,,,,,,', case: 'row of only commas', outcome: 'error', messages: [err('missing_identifier')] },
  { line: 'crm-057,same.twice@legacy-crm.test,Same.Twice@legacy-crm.test,,,Same Twice,same_twice,1980-02-02,UTC,,', case: 'the same email twice inside one row', outcome: 'created', id: 'c:same_twice', messages: [], notes: 'De-duplicated inside the row: one email.' },
  { line: 'crm-058,grace.h@legacy-crm.test,,,,Grace H,c:grace_h,1980-02-02,UTC,,', case: 'c:-prefixed username that is free', outcome: 'created', id: 'c:grace_h', messages: [] },
  { line: 'crm-059,ops+crm@legacy-crm.test,,,,Ops Inbox,ops_inbox,1980-02-02,  Europe/Berlin  ,,', case: 'plus-addressed email; padded timezone', outcome: 'created', id: 'c:ops_inbox', messages: [], notes: 'Email kept as ops+crm@legacy-crm.test; timezone Europe/Berlin.' },
];

// ---------------------------------------------------------------- dirty.json

const DIRTY_JSON: RowSpec[] = [
  { json: { external_id: 'json-001', email: 'Json.Mixed@Legacy-CRM.TEST', name: 'Json Mixed', username: 'json_mixed' }, case: '`name` alias for display_name; mixed-case email', outcome: 'created', id: 'c:json_mixed', messages: [] },
  { json: { external_id: 'json-002', emails: ['json.multi1@legacy-crm.test', 'json.multi2@legacy-crm.test'], display_name: 'Json Multi', username: 'json_multi' }, case: 'emails as a JSON array', outcome: 'created', id: 'c:json_multi', messages: [], notes: 'Two emails; json.multi1@legacy-crm.test primary.' },
  { json: { external_id: 'json-003', emails: 'json.semi1@legacy-crm.test;json.semi2@legacy-crm.test', display_name: 'Json Semi', username: 'json_semi' }, case: 'emails as a ;-separated string', outcome: 'created', id: 'c:json_semi', messages: [] },
  { json: { external_id: 'json-004', phones: ['(415) 555-0144', '+14155550145'], display_name: 'Json Phones', username: 'json_phones' }, case: 'phones array with a local-format number', outcome: 'created', id: 'c:json_phones', messages: [], notes: 'Phones +14155550144 (primary) and +14155550145.' },
  { json: { external_id: 'json-005', email: '  json.spaces@legacy-crm.test  ', display_name: '  Json Spaces  ', username: ' json_spaces ', timezone: ' Asia/Tokyo ' }, case: 'padded strings', outcome: 'created', id: 'c:json_spaces', messages: [], notes: 'All trimmed.' },
  { json: { external_id: 'json-006', email: null, phone: null, display_name: 'Json Nulls' }, case: 'null identifiers', outcome: 'error', messages: [err('missing_identifier')] },
  { json: { external_id: 'json-007', email: 'json.verified@legacy-crm.test', email_verified: true, display_name: 'Json Verified', username: 'json_verified' }, case: 'email_verified true (informational only)', outcome: 'created', id: 'c:json_verified', messages: [], notes: 'The email stays unverified until the Carbon proves it at sign-in.' },
  { json: { external_id: 'json-008', email: 'json.unicode@legacy-crm.test', display_name: 'Siobhán Ní Bhriain', username: 'c:siobhan' }, case: 'unicode name; c:-prefixed username', outcome: 'created', id: 'c:siobhan', messages: [] },
  { json: { external_id: 'json-009', email: 'json.mixed@legacy-crm.test', display_name: 'Json Mixed Again' }, case: 'same email as row 1 (different case)', outcome: 'skipped', messages: [skip('duplicate_in_file')], notes: 'References row 1.' },
  { json: { external_id: 'json-010', email: 'not an email', display_name: 'Json Invalid' }, case: 'invalid email, nothing else', outcome: 'error', messages: [warn('invalid_email', 'email'), err('missing_identifier')] },
  { json: { external_id: 'json-011', email: 'shubhastro2@example.test', display_name: 'Shubham In JSON' }, case: 'email of an existing account (c:shubham, seeded owner)', outcome: 'matched', matches: 'c:shubham', messages: [] },
  { json: { external_id: 'json-012', email: 'json.bad.fields@legacy-crm.test', display_name: 'Json Bad Fields', username: 'json_bad_fields', timezone: 'Moon/Tranquility', dob: '1990-13-45' }, case: 'invalid timezone and impossible dob', outcome: 'created', id: 'c:json_bad_fields', messages: [warn('invalid_timezone', 'timezone'), warn('invalid_dob', 'dob')] },
  { json: { external_id: 'json-013', email: 'json.pfp@legacy-crm.test', display_name: 'Json Pfp', username: 'json_pfp', pfp_url: 'https://images.legacy-crm.test/avatars/13.png' }, case: 'https pfp_url', outcome: 'created', id: 'c:json_pfp', messages: [], notes: 'pfp_url kept.' },
  { json: {}, case: 'empty object', outcome: 'error', messages: [err('missing_identifier')] },
  { json: { external_id: 'json-015', email: 'json.taken@legacy-crm.test', display_name: 'Json Taken', username: 'saket' }, case: 'username collides with c:saket', outcome: 'created', id: null, id_exact: false, messages: [warn('id_conflict', 'username', true)], notes: 'Any free id (c:saket-2, or c:saket-3 when dirty.csv was imported first).' },
  { json: { external_id: 'json-016', email: 'json.dup.external@legacy-crm.test', display_name: 'Json Dup External' }, case: 'external_id reuse is fine across different apps', outcome: 'created', id: 'c:json-dup-external', id_exact: false, messages: [], notes: 'Unique within this file.' },
];

// ------------------------------------------------------------ unknown columns

const UNKNOWN_HEADER = 'external_id,email,display_name,favorite_color,plan,last_login_at';
const UNKNOWN_PEOPLE: Array<[string, string, string, string, string]> = [
  ['unknown.one@legacy-crm.test', 'Unknown One', 'teal', 'pro', '2026-09-30T10:00:00Z'],
  ['unknown.two@legacy-crm.test', 'Unknown Two', 'amber', 'free', '2026-09-29T08:30:00Z'],
  ['unknown.three@legacy-crm.test', 'Unknown Three', 'violet', 'business', '2026-08-01T12:00:00Z'],
  ['unknown.four@legacy-crm.test', 'Unknown Four', 'pink', 'pro', '2026-07-15T09:45:00Z'],
  ['unknown.five@legacy-crm.test', 'Unknown Five', 'green', 'enterprise', '2026-06-01T00:00:00Z'],
];
const UNKNOWN: RowSpec[] = UNKNOWN_PEOPLE.map(([email, name, color, plan, at], i) => ({
  line: `unknown-${String(i + 1).padStart(3, '0')},${email},${name},${color},${plan},${at}`,
  json: { external_id: `unknown-${String(i + 1).padStart(3, '0')}`, email, display_name: name, favorite_color: color, plan, last_login_at: at },
  case: 'values in three unknown columns',
  outcome: 'created',
  id: null,
  id_exact: false,
  messages: [warn('unknown_columns')],
  notes: 'Only with ignore_unknown_columns=true; otherwise the whole import is refused.',
}));

// --------------------------------------------------------------------- render

function toExpected(file: string, rows: RowSpec[], options: Record<string, unknown>): ExpectedFile {
  const expectedRows: ExpectedRow[] = rows.map((row, i) => ({
    row_number: i + 1,
    case: row.case,
    outcome: row.outcome,
    ...(row.id !== undefined ? { id: row.id } : {}),
    ...(row.id !== undefined ? { id_exact: row.id_exact ?? row.id !== null } : {}),
    ...(row.matches ? { matches: row.matches } : {}),
    messages: row.messages ?? [],
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.precondition ? { precondition: row.precondition } : {}),
  })) as ExpectedRow[];
  const counts = { created: 0, matched: 0, updated: 0, skipped: 0, error: 0 };
  for (const row of expectedRows) counts[row.outcome] += 1;
  return { file, options, rows: expectedRows, counts };
}

const BOM = '\uFEFF';
const files: Record<string, string> = {};
files['clean.csv'] = `${[CLEAN_HEADER, ...CLEAN.map((r) => r.line)].join('\n')}\n`;
files['dirty.csv'] = `${BOM}${[DIRTY_HEADER, ...DIRTY.map((r) => r.line)].join('\r\n')}\r\n`;
files['dirty.json'] = `${JSON.stringify({ rows: DIRTY_JSON.map((r) => r.json) }, null, 2)}\n`;
files['unknown-columns.csv'] = `${[UNKNOWN_HEADER, ...UNKNOWN.map((r) => r.line)].join('\n')}\n`;
files['unknown-columns.json'] = `${JSON.stringify({ rows: UNKNOWN.map((r) => r.json) }, null, 2)}\n`;

const expected = {
  _comment: 'Expected per-row outcomes of the import fixtures (generated by scripts/build-import-fixtures.ts; see README.md). They assume a fresh database seeded from testkit/fake-apps.json and each fixture imported once into legacy-crm. `messages` is the minimum set expected; codes with spec_code=false are suggestions.',
  version: 1,
  files: [
    toExpected('clean.csv', CLEAN, { default_country: 'US' }),
    toExpected('dirty.csv', DIRTY, { default_country: 'US' }),
    toExpected('dirty.json', DIRTY_JSON, { default_country: 'US' }),
    toExpected('unknown-columns.csv', UNKNOWN, { default_country: 'US', ignore_unknown_columns: true }),
    toExpected('unknown-columns.json', UNKNOWN, { default_country: 'US', ignore_unknown_columns: true }),
  ],
};
files['expected.json'] = `${JSON.stringify(expected, null, 2)}\n`;

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function table(rows: RowSpec[]): string {
  const lines = ['| row | case | outcome | id | messages | notes |', '|---:|---|---|---|---|---|'];
  rows.forEach((row, i) => {
    const id = row.outcome === 'matched' ? `matches ${row.matches}` : row.id === undefined ? '' : row.id === null ? '(any valid id)' : row.id_exact === false ? `${row.id} (suggested)` : row.id;
    const messages = (row.messages ?? []).map((m) => `${m.level} \`${m.code}\`${m.field ? ` (${m.field})` : ''}${m.spec_code === false ? '*' : ''}`).join(', ') || '—';
    const notes = [row.precondition ? `**Precondition:** ${row.precondition}` : '', row.notes ?? ''].filter(Boolean).join(' ');
    lines.push(`| ${i + 1} | ${cell(row.case)} | **${row.outcome}** | ${cell(id)} | ${cell(messages)} | ${cell(notes)} |`);
  });
  return lines.join('\n');
}

function countsLine(rows: RowSpec[]): string {
  const c = toExpected('', rows, {}).counts;
  return `Expected counts: created ${c.created}, matched ${c.matched}, updated ${c.updated}, skipped ${c.skipped}, error ${c.error} (${rows.length} rows).`;
}

files['README.md'] = `# Import fixtures

Fixtures for the user import flow (\`POST /v1/apps/{app_id}/imports\`, CSV or JSON). They are
generated by \`scripts/build-import-fixtures.ts\` together with \`expected.json\` (the same
expectations, machine-readable) — edit the script, then run \`pnpm -C testkit gen:fixtures\`.

Expectations assume a **fresh database seeded from \`testkit/fake-apps.json\`** (so the app
owners exist: \`c:saket\` = saketdev12@example.test, \`c:shubham\` = shubhastro2@example.test,
\`c:acme-dev\` = dev@acme-notes.test, \`c:orbit-dev\` = dev@orbit-games.test, \`c:quill-dev\` =
dev@quill-docs.test, …), and each fixture imported **once** into \`legacy-crm\` with
\`default_country=US\`. Importing a fixture a second time turns its created rows into matched rows.

Reading the tables:
- \`row\` is the 1-based data row (the header is not counted; a quoted newline does not start a new row).
- \`messages\` is the minimum set a row should carry. Codes the spec names exactly
  (\`missing_identifier\`, \`ambiguous_match\`, \`duplicate_in_file\`, \`external_id_conflict\`,
  \`id_conflict\`, \`invalid_phone\`, \`unknown_columns\`) must match; codes marked \`*\` are
  suggestions — assert on the level and field, not the exact code.
- \`(suggested)\` ids come from the importer's id suggestion (from the username, email or name);
  assert the exact value only where no mark is shown.

| file | what it covers |
|---|---|
| \`clean.csv\` | 25 valid rows (email only, phone only, both; several countries). Every row is created with the given username as its c:id. |
| \`dirty.csv\` | Every messy case: UTF-8 BOM, CRLF line endings, mixed-case emails, padding, duplicate rows, invalid emails and phones, local-format phones, missing identifiers, unicode names, bad dobs, five date formats, invalid timezones, extra and missing cells, quoted commas/newlines/quotes, existing accounts, ambiguous matches, colliding/invalid/reserved usernames, duplicate external ids. |
| \`dirty.json\` | The JSON body form (\`{"rows":[…]}\`): \`name\` alias, \`emails\`/\`phones\` as arrays and as \`;\` strings, nulls, padding, \`email_verified\`, an empty object. |
| \`unknown-columns.csv\` / \`.json\` | Three columns that are not allowed (\`favorite_color\`, \`plan\`, \`last_login_at\`). |
| \`expected.json\` | The tables below as JSON (\`lib/fixtures.ts → expectedImportOutcomes(file)\`). |
| \`generate-big.ts\` | Writes \`big.csv\` (100,000 valid rows by default) for throughput runs: \`pnpm -C testkit gen:big [--rows N] [--seed N] [--tag run1] [--phone-ratio 0.2] [--out path]\`. |

## File-level expectations

- **dirty.csv** starts with a UTF-8 byte order mark and uses CRLF line endings. The BOM must be
  stripped before reading the header: if it is not, the first column reads as \`\\uFEFFexternal_id\`
  and the whole import fails with \`unknown_columns\` — that failure is the bug this guards against.
- **unknown-columns.csv / .json** without \`ignore_unknown_columns\`: \`422 unknown_columns\` for the
  whole request, \`details\` listing \`favorite_color\`, \`plan\`, \`last_login_at\` and the allowed
  columns; nothing is imported. With \`ignore_unknown_columns=true\`: all rows are created and each
  carries a warning about the ignored columns.
- **dry_run=true** with any fixture: the same per-row outcomes are reported, nothing is written
  (no accounts, no memberships), and a later real import still creates the rows.
- Re-submitting the same request with the same \`Idempotency-Key\` returns the same job.
- Creating accounts by import never sends email or SMS (mock-messaging stays empty).

## clean.csv

${countsLine(CLEAN)}

${table(CLEAN)}

## dirty.csv

${countsLine(DIRTY)} Row 40 needs its precondition; without it, expect matched ${toExpected('', DIRTY, {}).counts.matched + 1} and error ${toExpected('', DIRTY, {}).counts.error - 1}.

${table(DIRTY)}

## dirty.json

${countsLine(DIRTY_JSON)}

${table(DIRTY_JSON)}

## unknown-columns.csv / unknown-columns.json (with ignore_unknown_columns=true)

${countsLine(UNKNOWN)}

${table(UNKNOWN)}
`;

const check = process.argv.includes('--check');
let stale = 0;
for (const [name, content] of Object.entries(files)) {
  const path = `${IMPORT_FIXTURES_DIR}${name}`;
  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // missing → stale
    }
    if (current !== content) {
      process.stderr.write(`stale: fixtures/imports/${name}\n`);
      stale += 1;
    }
  } else {
    writeFileSync(path, content);
    process.stdout.write(`wrote fixtures/imports/${name}\n`);
  }
}
if (check && stale > 0) {
  process.stderr.write('error: import fixtures are out of date.\nhint: run `pnpm -C testkit gen:fixtures`.\n');
  process.exit(1);
}
if (check) process.stdout.write('import fixtures are up to date\n');
