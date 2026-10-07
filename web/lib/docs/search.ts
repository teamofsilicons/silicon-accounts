/**
 * Docs search, client side. The server builds one record per page and per h2/h3 section (lib/docs/search-index.ts,
 * served at /docs/search-index.json); the browser loads it once and ranks records here, with no service behind it.
 *
 * Every word of the query must appear in the record (its page title, its heading or its text). Matches in titles and
 * headings rank above matches in text, whole words above parts of words, the exact phrase above scattered words, and
 * a page's own record above its sections when they tie. Words keep their punctuation, so `si:id`, `/v1/oauth/token`
 * and `invalid_grant` match as typed.
 */

/** One searchable record, with short keys to keep the index small. */
export interface SearchRecord {
  /** The page's title. */
  t: string;
  /** The section's heading (absent on the page's own record). */
  h?: string;
  /** Where it lives: /docs/start/tokens#refresh. */
  u: string;
  /** The page's navigation group: Start, Learn, Reference, Overview. */
  g: string;
  /** The prose: the page's description and intro, or the section's paragraphs, lists and tables. */
  x: string;
  /** The start of the section's code blocks (searched, never shown). */
  c?: string;
  /** Reading order of the page, for ties. */
  o: number;
}

export interface PreparedRecord extends SearchRecord {
  title: string;
  heading: string;
  text: string;
  code: string;
}

export interface SnippetPart {
  text: string;
  mark: boolean;
}

export interface SearchHit {
  record: SearchRecord;
  score: number;
  snippet: SnippetPart[];
}

export function prepareIndex(records: SearchRecord[]): PreparedRecord[] {
  return records.map(record => ({ ...record, title: record.t.toLowerCase(), heading: (record.h ?? "").toLowerCase(), text: record.x.toLowerCase(), code: (record.c ?? "").toLowerCase() }));
}

/** Splits a query into lowercase words; surrounding punctuation goes, inner punctuation (si:id, /v1/me) stays. */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).map(term => term.replace(/^[^\p{L}\p{N}/._:-]+|[^\p{L}\p{N}_/]+$/gu, "")).filter(Boolean))];
}

const wordBoundary = (text: string, at: number, length: number) => {
  const before = at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]!);
  const after = at + length >= text.length || !/[\p{L}\p{N}]/u.test(text[at + length]!);
  return { start: before, whole: before && after };
};

function fieldScore(field: string, term: string, weights: { whole: number; start: number; part: number }): number {
  let at = field.indexOf(term);
  if (at < 0) return 0;
  let best = 0;
  let seen = 0;
  while (at >= 0 && seen < 8) {
    const boundary = wordBoundary(field, at, term.length);
    best = Math.max(best, boundary.whole ? weights.whole : boundary.start ? weights.start : weights.part);
    at = field.indexOf(term, at + term.length);
    seen++;
  }
  // A few more mentions count a little.
  return best + Math.min(seen - 1, 4) * weights.part * 0.25;
}

function snippet(record: PreparedRecord, terms: string[], width = 160): SnippetPart[] {
  // The prose, unless only the code mentions what was asked for.
  const fromCode = !terms.some(term => record.text.includes(term)) && terms.some(term => record.code.includes(term));
  const source = fromCode ? record.c ?? "" : record.x;
  const lower = fromCode ? record.code : record.text;
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  let start = 0;
  if (first > width / 3) {
    start = first - Math.floor(width / 3);
    const space = source.lastIndexOf(" ", start + 12);
    if (space > start - 20 && space > 0) start = space + 1;
  }
  let end = Math.min(source.length, start + width);
  if (end < source.length) {
    const space = source.indexOf(" ", end - 10);
    if (space > 0 && space < end + 20) end = space;
  }
  const window = source.slice(start, end);
  const lowerWindow = window.toLowerCase();
  // Mark every occurrence of every term inside the window.
  const marks: Array<[number, number]> = [];
  for (const term of terms) {
    let at = lowerWindow.indexOf(term);
    while (at >= 0) {
      marks.push([at, at + term.length]);
      at = lowerWindow.indexOf(term, at + term.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const parts: SnippetPart[] = [];
  let cursor = 0;
  for (const [from, to] of marks) {
    if (from < cursor) continue;
    if (from > cursor) parts.push({ text: window.slice(cursor, from), mark: false });
    parts.push({ text: window.slice(from, to), mark: true });
    cursor = to;
  }
  if (cursor < window.length) parts.push({ text: window.slice(cursor), mark: false });
  if (start > 0) parts.unshift({ text: "…", mark: false });
  if (end < source.length) parts.push({ text: "…", mark: false });
  return parts;
}

export function searchDocs(index: PreparedRecord[], query: string, limit = 24): SearchHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  const hits: SearchHit[] = [];
  for (const record of index) {
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      const title = fieldScore(record.title, term, { whole: 30, start: 22, part: 10 });
      const heading = fieldScore(record.heading, term, { whole: 24, start: 16, part: 8 });
      const text = fieldScore(record.text, term, { whole: 4, start: 3, part: 1 });
      const code = text ? 0 : fieldScore(record.code, term, { whole: 2, start: 1.5, part: .5 });
      const best = title + heading + text + code;
      if (!best) {
        matchedAll = false;
        break;
      }
      score += best;
    }
    if (!matchedAll) continue;
    if (terms.length > 1 && phrase.length > 2) {
      if (record.title.includes(phrase)) score += 40;
      else if (record.heading.includes(phrase)) score += 30;
      else if (record.text.includes(phrase)) score += 10;
    }
    if (record.title === phrase || record.heading === phrase) score += 25;
    if (!record.h) score += 3;
    hits.push({ record, score, snippet: [] });
  }
  hits.sort((a, b) => b.score - a.score || a.record.o - b.record.o || (a.record.h ? 1 : 0) - (b.record.h ? 1 : 0));
  // Keep the list varied: at most four sections of any one page.
  const perPage = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const page = hit.record.u.split("#")[0]!;
    const count = perPage.get(page) ?? 0;
    if (count >= 4) continue;
    perPage.set(page, count + 1);
    out.push({ ...hit, snippet: snippet(hit.record as PreparedRecord, terms) });
    if (out.length >= limit) break;
  }
  return out;
}
