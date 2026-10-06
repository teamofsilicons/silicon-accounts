/**
 * Reads an import file in the browser before anything is sent: the header (CSV) or the keys (JSON), which columns
 * Silicon Accounts keeps, which it does not (unknown columns), duplicates (`name` is `display_name`), whether any
 * identifier column exists, how many rows there are, and the first rows for a preview. The rules mirror the server's
 * (crates/apps imports/input.rs), so a file that passes here is not refused for its shape; rows are judged by the job.
 */
import { IMPORT_COLUMNS } from "../../../api";

export const MAX_IMPORT_ROWS = 100_000;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_COLUMNS = 200;
export const IDENTIFIER_COLUMNS = ["email", "emails", "phone", "phones"] as const;

/** What each import column holds, for the column check and the template. */
export const COLUMN_HELP: Record<(typeof IMPORT_COLUMNS)[number], string> = {
  external_id: "Your own id for the user; must be unique in this app",
  email: "The primary email; matches an account that already has it",
  emails: "More emails, as a list or separated by ;",
  phone: "The primary phone; local numbers use the default country",
  phones: "More phone numbers, as a list or separated by ;",
  display_name: "The name shown everywhere",
  name: "Same as display_name",
  username: "The id they want, without c: (a free one is picked if taken)",
  dob: "Date of birth: YYYY-MM-DD, DD/MM/YYYY or MM/DD/YYYY",
  timezone: "An IANA timezone such as Europe/London",
  pfp_url: "An https profile photo",
  email_verified: "Informational only; never trusted",
};

export type ColumnStatus = "ok" | "alias" | "unknown" | "duplicate" | "unnamed";

export interface ColumnCheck {
  /** As written in the file. */
  name: string;
  /** The import column it stands for, or null. */
  canonical: string | null;
  status: ColumnStatus;
}

export interface ParsedImport {
  format: "csv" | "json";
  /** File name, or "Pasted CSV" / "Pasted JSON". */
  source: string;
  bytes: number;
  rows: number;
  columns: ColumnCheck[];
  unknown: string[];
  duplicates: string[];
  hasIdentifier: boolean;
  /** Problems that stop the import before it starts, each a full sentence with what to do. */
  problems: string[];
  /** Up to 5 rows (import columns only) for the preview. */
  sample: Array<Record<string, string>>;
  /** What is sent: the CSV text (or file) as is, or the JSON rows. */
  csv?: Blob | string;
  jsonRows?: Record<string, unknown>[];
}

const ALLOWED = new Set<string>(IMPORT_COLUMNS);

export function normalizeColumn(name: string): string {
  return name.replace(/^﻿/, "").trim().toLowerCase();
}

export function canonicalColumn(normalized: string): string | null {
  if (normalized === "name") return "display_name";
  return ALLOWED.has(normalized) ? normalized : null;
}

const quote = (value: string) => `'${value.length > 80 ? `${value.slice(0, 80)}…` : value}'`;

/** Splits CSV text into records (RFC 4180: quotes, doubled quotes, CRLF), calling `onRecord` for each. */
function scanCsv(text: string, onRecord: (cells: string[], index: number) => boolean | void): void {
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let index = 0;
  let started = false;
  const end = () => {
    cells.push(cell);
    const blank = cells.length === 1 && cells[0] === "" && !started;
    if (!blank) {
      if (onRecord(cells, index) === false) return false;
      index++;
    }
    cells = [];
    cell = "";
    started = false;
    return true;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      started = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
      started = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      if (end() === false) return;
    } else {
      cell += char;
      started = true;
    }
  }
  if (cell !== "" || cells.length || started) end();
}

function checkColumns(names: string[]): { columns: ColumnCheck[]; unknown: string[]; duplicates: string[]; hasIdentifier: boolean } {
  const seen = new Set<string>();
  const columns: ColumnCheck[] = [];
  const unknown: string[] = [];
  const duplicates: string[] = [];
  let hasIdentifier = false;
  names.forEach((written, index) => {
    const trimmed = written.replace(/^﻿/, "").trim();
    const normalized = normalizeColumn(written);
    if (!normalized) {
      columns.push({ name: `(unnamed column ${index + 1})`, canonical: null, status: "unnamed" });
      return;
    }
    if ((IDENTIFIER_COLUMNS as readonly string[]).includes(normalized)) hasIdentifier = true;
    const canonical = canonicalColumn(normalized);
    const key = canonical ?? normalized;
    if (seen.has(key)) {
      duplicates.push(trimmed);
      columns.push({ name: trimmed, canonical, status: "duplicate" });
      return;
    }
    seen.add(key);
    if (!canonical) {
      unknown.push(trimmed);
      columns.push({ name: trimmed, canonical: null, status: "unknown" });
    } else columns.push({ name: trimmed, canonical, status: normalized === "name" ? "alias" : "ok" });
  });
  return { columns, unknown, duplicates, hasIdentifier };
}

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(cellText).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

/** Parses CSV text. `original` is what gets uploaded (the file itself, or the pasted text). */
export function parseCsv(text: string, source: string, original: Blob | string): ParsedImport {
  const body = text.replace(/^﻿/, "");
  const problems: string[] = [];
  const bytes = typeof original === "string" ? new Blob([original]).size : original.size;
  // Closures write here; a plain object keeps TypeScript's narrowing out of the way.
  const state: { header: string[] | null; checked: ReturnType<typeof checkColumns> | null; rows: number } = { header: null, checked: null, rows: 0 };
  const sample: Array<Record<string, string>> = [];
  if (!body.trim()) problems.push("The CSV is empty. Export your users with a header row, such as email,display_name,username.");
  else {
    scanCsv(body, (cells, index) => {
      if (index === 0) {
        state.header = cells;
        state.checked = checkColumns(cells);
        return;
      }
      state.rows++;
      const checked = state.checked;
      if (sample.length < 5 && checked) {
        const row: Record<string, string> = {};
        checked.columns.forEach((column, position) => {
          if (column.canonical && (column.status === "ok" || column.status === "alias")) row[column.canonical] = cells[position] ?? "";
        });
        sample.push(row);
      }
      return state.rows <= MAX_IMPORT_ROWS;
    });
  }
  const rows = state.rows;
  const header = state.header;
  const result = state.checked ?? { columns: [], unknown: [], duplicates: [], hasIdentifier: false };
  if (header && header.length > MAX_IMPORT_COLUMNS) problems.push(`The header has ${header.length} columns; an import can have at most ${MAX_IMPORT_COLUMNS}.`);
  if (header && !rows) problems.push("The CSV has a header but no rows under it.");
  if (rows > MAX_IMPORT_ROWS) problems.push(`The file has more than ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows; split it into several imports of at most ${MAX_IMPORT_ROWS.toLocaleString("en-US")}.`);
  if (header && !result.hasIdentifier) problems.push(`No column holds an email or phone number (the columns are ${result.columns.map(column => quote(column.name)).join(", ")}). Every imported user needs an email, emails, phone or phones column to be matched or created.`);
  if (result.duplicates.length) problems.push(`The header names the same column twice: ${result.duplicates.map(quote).join(", ")} (names are case-insensitive, and name is the same column as display_name). Keep one column per field.`);
  if (bytes > MAX_IMPORT_BYTES) problems.push(`The file is ${(bytes / 1024 / 1024).toFixed(1)} MB; an import can be at most 50 MB. Split it into several files.`);
  return { format: "csv", source, bytes, rows, ...result, problems, sample, csv: original };
}

/** Parses a JSON import: an array of row objects, or `{"rows": [...]}`. */
export function parseJson(text: string, source: string): ParsedImport {
  const bytes = new Blob([text]).size;
  const base: ParsedImport = { format: "json", source, bytes, rows: 0, columns: [], unknown: [], duplicates: [], hasIdentifier: false, problems: [], sample: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ...base, problems: [`The JSON can't be parsed: ${error instanceof Error ? error.message : String(error)}. Check for a missing comma or quote.`] };
  }
  const rows = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { rows?: unknown }).rows) ? (value as { rows: unknown[] }).rows : null;
  if (!rows) return { ...base, problems: ["The JSON must be an array of users, or an object with a rows array: [{\"email\": \"ada@example.com\"}]."] };
  const problems: string[] = [];
  const names: string[] = [];
  const seenNames = new Set<string>();
  const objects: Record<string, unknown>[] = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      if (problems.length < 3) problems.push(`Row ${index + 1} is ${Array.isArray(row) ? "an array" : row === null ? "null" : `a ${typeof row}`}; every row must be an object such as {"email": "ada@example.com"}.`);
      return;
    }
    const keys = Object.keys(row);
    const normalized = keys.map(normalizeColumn);
    if (normalized.includes("name") && normalized.includes("display_name") && problems.length < 3) problems.push(`Row ${index + 1} has both name and display_name, which are the same column. Keep one.`);
    for (const key of keys) {
      const norm = normalizeColumn(key);
      if (!seenNames.has(norm)) {
        seenNames.add(norm);
        names.push(key);
      }
    }
    objects.push(row as Record<string, unknown>);
  });
  // In JSON, `name` and `display_name` in different rows are fine; only a key's canonical twin in the same row clashes.
  const checked = checkColumns(names.filter((name, index) => {
    const norm = normalizeColumn(name);
    return !(norm === "name" && names.some((other, j) => j !== index && normalizeColumn(other) === "display_name"));
  }));
  if (!objects.length && !problems.length) problems.push("The JSON has no rows.");
  if (objects.length > MAX_IMPORT_ROWS) problems.push(`The file has ${objects.length.toLocaleString("en-US")} rows; an import can have at most ${MAX_IMPORT_ROWS.toLocaleString("en-US")}.`);
  if (objects.length && !checked.hasIdentifier) problems.push("No row has an email, emails, phone or phones key. Every imported user needs one to be matched or created.");
  if (bytes > MAX_IMPORT_BYTES) problems.push(`The file is ${(bytes / 1024 / 1024).toFixed(1)} MB; an import can be at most 50 MB. Split it into several files.`);
  const sample = objects.slice(0, 5).map(row => {
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(row)) {
      const canonical = canonicalColumn(normalizeColumn(key));
      if (canonical) out[canonical] = cellText(item);
    }
    return out;
  });
  return { ...base, rows: objects.length, columns: checked.columns, unknown: checked.unknown, duplicates: [], hasIdentifier: checked.hasIdentifier, problems, sample, jsonRows: objects };
}

/** Parses text whose format is guessed from its first character (pasted input). */
export function parseText(text: string): ParsedImport {
  const trimmed = text.trimStart();
  return trimmed.startsWith("[") || trimmed.startsWith("{") ? parseJson(text, "Pasted JSON") : parseCsv(text, "Pasted CSV", text);
}

/** Reads a chosen file (CSV or JSON by extension or type). */
export async function parseFile(file: File): Promise<ParsedImport> {
  if (file.size > MAX_IMPORT_BYTES) {
    return { format: file.name.toLowerCase().endsWith(".json") ? "json" : "csv", source: file.name, bytes: file.size, rows: 0, columns: [], unknown: [], duplicates: [], hasIdentifier: false, problems: [`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; an import can be at most 50 MB. Split it into several files.`], sample: [] };
  }
  const text = await file.text();
  const json = file.name.toLowerCase().endsWith(".json") || file.type === "application/json";
  return json ? parseJson(text, file.name) : parseCsv(text, file.name, file);
}

/** The CSV template: every column, one example row. */
export function templateCsv(): string {
  return [
    "external_id,email,emails,phone,phones,display_name,username,dob,timezone,pfp_url",
    "crm-1001,ada@example.com,ada.okafor@work.example,+442071838750,,Ada Okafor,ada,1990-04-05,Europe/London,https://example.com/ada.png",
  ].join("\n");
}
