/**
 * The docs' Markdown parser: CommonMark blocks and inlines plus the GitHub extensions the docs use (tables,
 * strikethrough, autolink literals, task list items and alerts such as `> [!WARNING]`), into a small AST that
 * components/docs renders as React elements. It has no dependencies and never produces HTML: raw HTML in the source
 * renders as text, and HTML comments (`<!-- … -->`) are dropped, so a page can never inject markup.
 *
 *   const doc = parseMarkdown(source);   // { blocks, headings }
 *
 * Headings get GitHub's ids (`## Refresh tokens` → `refresh-tokens`, repeats get `-1`, `-2`), so `page.md#anchor` links
 * written for GitHub land on the same heading here.
 */

export type Inline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "del"; children: Inline[] }
  | { type: "link"; href: string; title: string | null; children: Inline[] }
  | { type: "image"; src: string; alt: string; title: string | null }
  | { type: "break" };

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";
export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  /** Task list items: true or false; null for a plain item. */
  checked: boolean | null;
  children: Block[];
}

export type Block =
  | { type: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; id: string; text: string; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; meta: string; value: string }
  | { type: "blockquote"; children: Block[] }
  | { type: "callout"; kind: CalloutKind; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: "hr" };

export interface Heading {
  depth: number;
  id: string;
  text: string;
  children: Inline[];
}

export interface MarkdownDocument {
  blocks: Block[];
  /** Every heading in document order (any depth), with its id. */
  headings: Heading[];
}

interface LinkReference {
  href: string;
  title: string | null;
}

type References = Map<string, LinkReference>;

/* ------------------------------------------------------------------------------------------------------------------
 * Block structure
 * ------------------------------------------------------------------------------------------------------------------ */

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BLOCKQUOTE = /^ {0,3}> ?(.*)$/;
const LIST_MARKER = /^( {0,3})([-+*]|\d{1,9}[.)])(?=[ \t]|$)/;
const SETEXT_1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_2 = /^ {0,3}-+[ \t]*$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const COMMENT_START = /^ {0,3}<!--/;
const REFERENCE_DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^<>\n]*>|\S+)(?:[ \t]+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*$/;
const ALERT = /^[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i;

const isBlank = (line: string) => /^[ \t]*$/.test(line);
const indentOf = (line: string) => line.length - line.trimStart().length;

/** Tabs become spaces up to the next multiple of four, so indentation can be measured in columns. */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const char of line) {
    if (char === "\t") out += " ".repeat(4 - (out.length % 4));
    else out += char;
  }
  return out;
}

interface Marker {
  ordered: boolean;
  /** The bullet character, or the ordered delimiter ("." or ")"). */
  symbol: string;
  start: number;
  /** Columns from the line start to the item's content. */
  contentIndent: number;
  /** The first line's content (after the marker and its spaces). */
  first: string;
  empty: boolean;
}

function readMarker(line: string): Marker | null {
  const match = LIST_MARKER.exec(line);
  if (!match) return null;
  const indent = match[1]!.length;
  const marker = match[2]!;
  const rest = line.slice(match[0].length);
  const ordered = /\d/.test(marker[0]!);
  const symbol = ordered ? marker.slice(-1) : marker;
  const start = ordered ? Number.parseInt(marker, 10) : 1;
  if (isBlank(rest)) return { ordered, symbol, start, contentIndent: indent + marker.length + 1, first: "", empty: true };
  const spaces = indentOf(rest);
  // Five or more spaces after the marker: the content starts one column in, and the rest is indented code.
  if (spaces >= 5) return { ordered, symbol, start, contentIndent: indent + marker.length + 1, first: rest.slice(1), empty: false };
  return { ordered, symbol, start, contentIndent: indent + marker.length + spaces, first: rest.slice(spaces), empty: false };
}

function fenceOpen(line: string): { indent: number; char: string; length: number; info: string } | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const fence = match[2]!;
  const info = match[3]!.trim();
  // A backtick fence's info string may not contain backticks (it would be inline code).
  if (fence[0] === "`" && info.includes("`")) return null;
  return { indent: match[1]!.length, char: fence[0]!, length: fence.length, info };
}

function isFenceClose(line: string, char: string, length: number): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!match && match[1]![0] === char && match[1]!.length >= length;
}

/** Whether a line starts a block that ends (interrupts) a paragraph. */
function interruptsParagraph(line: string): boolean {
  if (ATX_HEADING.test(line) || THEMATIC_BREAK.test(line) || BLOCKQUOTE.test(line) || COMMENT_START.test(line)) return true;
  if (fenceOpen(line)) return true;
  const marker = readMarker(line);
  // An empty item never interrupts a paragraph, and an ordered list only when it starts at 1.
  if (marker && !marker.empty && (!marker.ordered || marker.start === 1)) return true;
  return false;
}

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < row.length; index++) {
    const char = row[index]!;
    if (char === "\\" && row[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlign(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

/** A table starts at `header` when the next line is a delimiter row with the same number of cells. */
function tableStart(header: string, delimiter: string | undefined): Align[] | null {
  if (delimiter === undefined || !header.includes("|") || !delimiter.includes("|") && !delimiter.includes(":")) return null;
  if (!TABLE_DELIMITER.test(delimiter) || indentOf(header) >= 4) return null;
  const heads = splitTableRow(header);
  const aligns = splitTableRow(delimiter).map(tableAlign);
  return heads.length === aligns.length ? aligns : null;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

class BlockParser {
  private refs: References;

  constructor(refs: References) {
    this.refs = refs;
  }

  /**
   * Parses lines into blocks. `loose` reports a blank line between two of the top-level blocks (what makes a list item,
   * and so its list, loose).
   */
  parse(lines: string[]): { blocks: Block[]; loose: boolean } {
    const blocks: Block[] = [];
    let loose = false;
    let blankBefore = false;
    let index = 0;
    const push = (block: Block) => {
      if (blankBefore && blocks.length) loose = true;
      blankBefore = false;
      blocks.push(block);
    };

    while (index < lines.length) {
      const line = lines[index]!;
      if (isBlank(line)) {
        blankBefore = true;
        index++;
        continue;
      }

      // Indented code (never inside a paragraph: that case is a continuation, handled by the paragraph below).
      if (indentOf(line) >= 4) {
        const body: string[] = [];
        while (index < lines.length && (isBlank(lines[index]!) || indentOf(lines[index]!) >= 4)) {
          body.push(lines[index]!.slice(Math.min(4, indentOf(lines[index]!))));
          index++;
        }
        while (body.length && isBlank(body[body.length - 1]!)) body.pop();
        push({ type: "code", lang: "", meta: "", value: body.join("\n") });
        continue;
      }

      const fence = fenceOpen(line);
      if (fence) {
        const body: string[] = [];
        index++;
        while (index < lines.length && !isFenceClose(lines[index]!, fence.char, fence.length)) {
          const content = lines[index]!;
          body.push(content.slice(Math.min(fence.indent, indentOf(content))));
          index++;
        }
        index++; // the closing fence (or past the end)
        const [lang = "", ...meta] = fence.info.split(/\s+/);
        push({ type: "code", lang: unescapeMarkdown(lang).toLowerCase(), meta: meta.join(" "), value: body.join("\n") });
        continue;
      }

      if (COMMENT_START.test(line)) {
        // An HTML comment: hidden notes for authors. Everything up to the line with `-->` is dropped.
        while (index < lines.length && !lines[index]!.includes("-->")) index++;
        index++;
        continue;
      }

      const atx = ATX_HEADING.exec(line);
      if (atx) {
        const depth = atx[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
        let content = (atx[2] ?? "").trim();
        content = /^#+$/.test(content) ? "" : content.replace(/[ \t]+#+[ \t]*$/, "");
        push({ type: "heading", depth, id: "", text: "", children: parseInlines(content, this.refs) });
        index++;
        continue;
      }

      if (THEMATIC_BREAK.test(line)) {
        push({ type: "hr" });
        index++;
        continue;
      }

      if (BLOCKQUOTE.test(line)) {
        const inner: string[] = [];
        let paragraphOpen = false;
        while (index < lines.length) {
          const current = lines[index]!;
          const quoted = BLOCKQUOTE.exec(current);
          if (quoted) {
            inner.push(quoted[1]!);
            paragraphOpen = !isBlank(quoted[1]!) && !fenceOpen(quoted[1]!) && !ATX_HEADING.test(quoted[1]!);
            index++;
          } else if (!isBlank(current) && paragraphOpen && !interruptsParagraph(current)) {
            inner.push(current); // a lazy continuation line of the quoted paragraph
            index++;
          } else {
            break;
          }
        }
        const alert = inner.length ? ALERT.exec(inner[0]!) : null;
        if (alert) {
          const rest = alert[2]!.trim();
          const content = rest ? [rest, ...inner.slice(1)] : inner.slice(1);
          push({ type: "callout", kind: alert[1]!.toLowerCase() as CalloutKind, children: this.parse(content).blocks });
        } else {
          push({ type: "blockquote", children: this.parse(inner).blocks });
        }
        continue;
      }

      const marker = readMarker(line);
      if (marker) {
        const result = this.parseList(lines, index, marker);
        push(result.block);
        index = result.next;
        continue;
      }

      const aligns = tableStart(line, lines[index + 1]);
      if (aligns) {
        const result = this.parseTable(lines, index, aligns);
        push(result.block);
        index = result.next;
        continue;
      }

      // A paragraph: lines up to a blank line or a line that starts another block. A setext underline turns it into a
      // heading; a table header row with its delimiter row below ends it.
      const text: string[] = [];
      let setext: 1 | 2 | 0 = 0;
      while (index < lines.length) {
        const current = lines[index]!;
        if (isBlank(current)) break;
        if (text.length && SETEXT_1.test(current)) {
          setext = 1;
          index++;
          break;
        }
        if (text.length && SETEXT_2.test(current)) {
          setext = 2;
          index++;
          break;
        }
        if (text.length && (interruptsParagraph(current) || tableStart(current, lines[index + 1]))) break;
        text.push(current);
        index++;
      }

      // Link reference definitions at the start of a paragraph define links and render nothing.
      while (!setext && text.length) {
        const definition = REFERENCE_DEFINITION.exec(text[0]!);
        if (!definition) break;
        const label = normalizeLabel(definition[1]!);
        const rawHref = definition[2]!;
        const href = rawHref.startsWith("<") ? rawHref.slice(1, -1) : rawHref;
        const title = definition[3] ? unescapeMarkdown(definition[3].slice(1, -1)) : null;
        if (!this.refs.has(label)) this.refs.set(label, { href: unescapeMarkdown(href), title });
        text.shift();
      }
      if (!text.length) continue;

      const content = text.map(entry => entry.trimStart()).join("\n").replace(/[ \t]+$/, "");
      if (setext) push({ type: "heading", depth: setext, id: "", text: "", children: parseInlines(content, this.refs) });
      else push({ type: "paragraph", children: parseInlines(content, this.refs) });
    }
    return { blocks, loose };
  }

  private parseList(lines: string[], from: number, first: Marker): { block: Block; next: number } {
    const items: ListItem[] = [];
    let loose = false;
    let index = from;
    let marker: Marker | null = first;

    while (marker) {
      const body: string[] = [marker.first];
      index++;
      let fence: { char: string; length: number } | null = null;
      const opened = fenceOpen(marker.first);
      if (opened) fence = { char: opened.char, length: opened.length };
      let paragraphOpen = !marker.empty && !fence && !ATX_HEADING.test(marker.first) && !THEMATIC_BREAK.test(marker.first);

      while (index < lines.length) {
        const line = lines[index]!;
        if (isBlank(line)) {
          // An item that starts with a blank line ends at the next blank line.
          if (marker.empty && body.length === 1 && isBlank(body[0]!)) break;
          body.push("");
          paragraphOpen = false;
          index++;
          continue;
        }
        if (indentOf(line) >= marker.contentIndent) {
          const content = line.slice(marker.contentIndent);
          body.push(content);
          if (fence) {
            if (isFenceClose(content, fence.char, fence.length)) fence = null;
            paragraphOpen = false;
          } else {
            const opening = fenceOpen(content);
            if (opening) {
              fence = { char: opening.char, length: opening.length };
              paragraphOpen = false;
            } else {
              paragraphOpen = !ATX_HEADING.test(content) && !THEMATIC_BREAK.test(content) && indentOf(content) < 4;
            }
          }
          index++;
          continue;
        }
        // Less indented: a lazy continuation of the item's open paragraph, or the end of the item.
        if (paragraphOpen && !fence && !interruptsParagraph(line) && !readMarker(line)) {
          body.push(line.trimStart());
          index++;
          continue;
        }
        break;
      }

      // Blank lines at the end of the item separate it from the next one (a loose list) only if another item follows.
      let trailingBlank = false;
      while (body.length > 1 && isBlank(body[body.length - 1]!)) {
        body.pop();
        trailingBlank = true;
      }

      let checked: boolean | null = null;
      const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(body[0] ?? "");
      if (task) {
        checked = task[1] !== " ";
        body[0] = body[0]!.slice(task[0].length);
      }

      const parsed = this.parse(body);
      if (parsed.loose) loose = true;
      items.push({ checked, children: parsed.blocks });

      // The next item: the same kind of marker, at a smaller indent than this item's content.
      const next = index < lines.length ? readMarker(lines[index]!) : null;
      if (next && next.ordered === first.ordered && next.symbol === first.symbol && !THEMATIC_BREAK.test(lines[index]!)) {
        if (trailingBlank) loose = true;
        marker = next;
      } else {
        marker = null;
      }
    }

    return { block: { type: "list", ordered: first.ordered, start: first.start, tight: !loose, items }, next: index };
  }

  private parseTable(lines: string[], from: number, align: Align[]): { block: Block; next: number } {
    const width = align.length;
    const fit = (cells: string[]) => Array.from({ length: width }, (_, column) => parseInlines(cells[column] ?? "", this.refs));
    const head = fit(splitTableRow(lines[from]!));
    const rows: Inline[][][] = [];
    let index = from + 2;
    while (index < lines.length) {
      const line = lines[index]!;
      if (isBlank(line) || ATX_HEADING.test(line) || BLOCKQUOTE.test(line) || fenceOpen(line) || THEMATIC_BREAK.test(line)) break;
      rows.push(fit(splitTableRow(line)));
      index++;
    }
    return { block: { type: "table", align, head, rows }, next: index };
  }
}

/* ------------------------------------------------------------------------------------------------------------------
 * Inlines
 * ------------------------------------------------------------------------------------------------------------------ */

const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;
const ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "\u2014", ndash: "\u2013", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·",
  bull: "•", times: "×", divide: "÷", plusmn: "±", deg: "°", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  check: "✓", minus: "−", le: "≤", ge: "≥", ne: "≠", infin: "∞", sect: "§", para: "¶", dagger: "†", shy: "­",
  zwj: "‍", zwnj: "‌", thinsp: " ", ensp: " ", emsp: " ", euro: "€", pound: "£", yen: "¥",
};

interface DelimiterToken {
  kind: "delimiter";
  char: "*" | "_" | "~";
  count: number;
  original: number;
  canOpen: boolean;
  canClose: boolean;
}

interface BracketToken {
  kind: "bracket";
  image: boolean;
  active: boolean;
}

type Token = Inline | DelimiterToken | BracketToken;

const isDelimiter = (token: Token): token is DelimiterToken => (token as DelimiterToken).kind === "delimiter";
const isBracket = (token: Token): token is BracketToken => (token as BracketToken).kind === "bracket";

function charBefore(source: string, index: number): string {
  return index > 0 ? source[index - 1]! : "\n";
}

function charAfter(source: string, index: number): string {
  return index < source.length ? source[index]! : "\n";
}

/** Reads a link destination and optional title after `(`, returning the end position after `)`, or null. */
function readInlineLink(source: string, open: number): { href: string; title: string | null; end: number } | null {
  let position = open + 1;
  const skipSpace = () => {
    while (position < source.length && /[ \t\n]/.test(source[position]!)) position++;
  };
  skipSpace();
  let href = "";
  if (source[position] === "<") {
    const close = source.indexOf(">", position);
    if (close < 0 || source.slice(position + 1, close).includes("\n")) return null;
    href = source.slice(position + 1, close);
    position = close + 1;
  } else {
    let depth = 0;
    const start = position;
    while (position < source.length) {
      const char = source[position]!;
      if (char === "\\" && ASCII_PUNCTUATION.test(source[position + 1] ?? "")) {
        position += 2;
        continue;
      }
      if (/\s/.test(char)) break;
      if (char === "(") depth++;
      if (char === ")") {
        if (depth === 0) break;
        depth--;
      }
      position++;
    }
    if (depth !== 0) return null;
    href = source.slice(start, position);
  }
  const beforeTitle = position;
  skipSpace();
  let title: string | null = null;
  const quote = source[position];
  if (position > beforeTitle && (quote === "\"" || quote === "'" || quote === "(")) {
    const closer = quote === "(" ? ")" : quote;
    let end = position + 1;
    while (end < source.length && source[end] !== closer) end += source[end] === "\\" ? 2 : 1;
    if (end >= source.length) return null;
    title = unescapeMarkdown(source.slice(position + 1, end));
    position = end + 1;
    skipSpace();
  }
  if (source[position] !== ")") return null;
  return { href: decodeEntities(unescapeMarkdown(href)), title, end: position + 1 };
}

function decodeEntities(value: string): string {
  return value.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, name: string) => decodeEntity(name) ?? whole);
}

function decodeEntity(name: string): string | null {
  if (name.startsWith("#")) {
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return "�";
    return String.fromCodePoint(code);
  }
  return ENTITIES[name] ?? null;
}

/** The text of a run of inlines, for ids, link labels, image alt text and search. */
export function inlineText(inlines: Inline[]): string {
  let out = "";
  for (const node of inlines) {
    if (node.type === "text" || node.type === "code") out += node.value;
    else if (node.type === "break") out += " ";
    else if (node.type === "image") out += node.alt;
    else out += inlineText(node.children);
  }
  return out;
}

function parseInlines(source: string, refs: References): Inline[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ type: "text", value: text });
    text = "";
  };

  let position = 0;
  while (position < source.length) {
    const char = source[position]!;

    if (char === "\\") {
      const next = source[position + 1];
      if (next === "\n") {
        flush();
        tokens.push({ type: "break" });
        position += 2;
        while (source[position] === " ") position++;
      } else if (next !== undefined && ASCII_PUNCTUATION.test(next)) {
        text += next;
        position += 2;
      } else {
        text += "\\";
        position++;
      }
      continue;
    }

    if (char === "`") {
      let run = 1;
      while (source[position + run] === "`") run++;
      // The closing run must have exactly the same length.
      let search = position + run;
      let close = -1;
      while (search < source.length) {
        const at = source.indexOf("`", search);
        if (at < 0) break;
        let length = 1;
        while (source[at + length] === "`") length++;
        if (length === run) {
          close = at;
          break;
        }
        search = at + length;
      }
      if (close < 0) {
        text += "`".repeat(run);
        position += run;
        continue;
      }
      let code = source.slice(position + run, close).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      flush();
      tokens.push({ type: "code", value: code });
      position = close + run;
      continue;
    }

    if (char === "*" || char === "_" || (char === "~" && source[position + 1] === "~")) {
      let run = 1;
      while (source[position + run] === char) run++;
      if (char === "~" && run !== 2) {
        text += source.slice(position, position + run);
        position += run;
        continue;
      }
      const before = charBefore(source, position);
      const after = charAfter(source, position + run);
      const leftFlanking = !WHITESPACE.test(after) && (!PUNCTUATION.test(after) || WHITESPACE.test(before) || PUNCTUATION.test(before));
      const rightFlanking = !WHITESPACE.test(before) && (!PUNCTUATION.test(before) || WHITESPACE.test(after) || PUNCTUATION.test(after));
      let canOpen = leftFlanking;
      let canClose = rightFlanking;
      if (char === "_") {
        canOpen = leftFlanking && (!rightFlanking || PUNCTUATION.test(before));
        canClose = rightFlanking && (!leftFlanking || PUNCTUATION.test(after));
      }
      flush();
      tokens.push({ kind: "delimiter", char, count: run, original: run, canOpen, canClose });
      position += run;
      continue;
    }

    if (char === "!" && source[position + 1] === "[") {
      flush();
      tokens.push({ kind: "bracket", image: true, active: true });
      position += 2;
      continue;
    }

    if (char === "[") {
      flush();
      tokens.push({ kind: "bracket", image: false, active: true });
      position++;
      continue;
    }

    if (char === "]") {
      flush();
      const consumed = closeBracket(source, position, tokens, refs);
      if (consumed > 0) {
        position = consumed;
      } else {
        text += "]";
        position++;
      }
      continue;
    }

    if (char === "<") {
      const autolink = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(source.slice(position));
      const email = autolink ? null : /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(source.slice(position));
      if (autolink || email) {
        flush();
        const target = (autolink ?? email)![1]!;
        tokens.push({ type: "link", href: email ? `mailto:${target}` : target, title: null, children: [{ type: "text", value: target }] });
        position += (autolink ?? email)![0].length;
        continue;
      }
      text += "<";
      position++;
      continue;
    }

    if (char === "&") {
      const entity = /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(source.slice(position));
      const decoded = entity ? decodeEntity(entity[1]!) : null;
      if (entity && decoded !== null) {
        text += decoded;
        position += entity[0].length;
        continue;
      }
      text += "&";
      position++;
      continue;
    }

    if (char === "\n") {
      const hard = / {2,}$/.test(text);
      text = text.replace(/ +$/, "");
      if (hard) {
        flush();
        tokens.push({ type: "break" });
      } else {
        text += "\n";
      }
      position++;
      while (source[position] === " ") position++;
      continue;
    }

    text += char;
    position++;
  }
  flush();

  processEmphasis(tokens, 0);
  return autolinkLiterals(finish(tokens));
}

/** Handles `]`: a link or image when an opener matches and a destination follows. Returns the new position, or 0. */
function closeBracket(source: string, position: number, tokens: Token[], refs: References): number {
  let openerIndex = -1;
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (isBracket(tokens[index]!)) {
      openerIndex = index;
      break;
    }
  }
  if (openerIndex < 0) return 0;
  const opener = tokens[openerIndex] as BracketToken;
  if (!opener.active) {
    tokens[openerIndex] = { type: "text", value: opener.image ? "![" : "[" };
    return 0;
  }

  let target: { href: string; title: string | null; end: number } | null = null;
  if (source[position + 1] === "(") {
    target = readInlineLink(source, position + 1);
  }
  if (!target) {
    // Reference forms: [text][label], [text][] and [text].
    const inner = finish(tokens.slice(openerIndex + 1));
    let label = inlineText(inner);
    let end = position + 1;
    const full = /^\[((?:[^\]\\]|\\.)*)\]/.exec(source.slice(position + 1));
    if (full) {
      if (full[1]!.trim()) label = full[1]!;
      end = position + 1 + full[0].length;
    }
    const reference = refs.get(normalizeLabel(label));
    if (reference) target = { href: reference.href, title: reference.title, end };
  }
  if (!target) {
    tokens[openerIndex] = { type: "text", value: opener.image ? "![" : "[" };
    return 0;
  }

  const innerTokens = tokens.slice(openerIndex + 1);
  processEmphasis(innerTokens, 0);
  const children = finish(innerTokens);
  const node: Inline = opener.image
    ? { type: "image", src: target.href, alt: inlineText(children), title: target.title }
    : { type: "link", href: target.href, title: target.title, children };
  tokens.splice(openerIndex, tokens.length - openerIndex, node);
  // Links never contain links: every earlier link opener stops being one.
  if (!opener.image) {
    for (const token of tokens) if (isBracket(token) && !token.image) token.active = false;
  }
  return target.end;
}

/** CommonMark's "process emphasis" over the delimiter tokens from `bottom`. */
function processEmphasis(tokens: Token[], bottom: number) {
  const openersBottom = new Map<string, number>();
  let index = bottom;
  while (index < tokens.length) {
    const closer = tokens[index]!;
    if (!isDelimiter(closer) || !closer.canClose) {
      index++;
      continue;
    }
    const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.original % 3}`;
    const floor = Math.max(bottom, openersBottom.get(key) ?? bottom);
    let openerIndex = -1;
    for (let back = index - 1; back >= floor; back--) {
      const candidate = tokens[back]!;
      if (!isDelimiter(candidate) || candidate.char !== closer.char || !candidate.canOpen || candidate.count === 0) continue;
      if (closer.char !== "~" && (candidate.canClose || closer.canOpen) && (candidate.original + closer.original) % 3 === 0 && !(candidate.original % 3 === 0 && closer.original % 3 === 0)) continue;
      if (closer.char === "~" && candidate.count !== closer.count) continue;
      openerIndex = back;
      break;
    }
    if (openerIndex < 0) {
      openersBottom.set(key, index);
      if (!closer.canOpen) closer.canClose = false;
      index++;
      continue;
    }

    const opener = tokens[openerIndex] as DelimiterToken;
    const use = closer.char === "~" ? 2 : closer.count >= 2 && opener.count >= 2 ? 2 : 1;
    const inner = finish(tokens.slice(openerIndex + 1, index));
    const node: Inline = closer.char === "~"
      ? { type: "del", children: inner }
      : use === 2 ? { type: "strong", children: inner } : { type: "em", children: inner };
    opener.count -= use;
    closer.count -= use;
    // Replace everything between the two delimiters with the new node, and keep the recorded floors on the tokens
    // they named (indices move with every splice).
    const between = index - openerIndex - 1;
    tokens.splice(openerIndex + 1, between, node);
    for (const [key, floorAt] of openersBottom) {
      if (floorAt > openerIndex && floorAt < index) openersBottom.set(key, openerIndex + 1);
      else if (floorAt >= index) openersBottom.set(key, floorAt - (between - 1));
    }
    index = openerIndex + 2; // the closer's new position
    if (opener.count === 0) {
      tokens.splice(openerIndex, 1);
      for (const [key, floorAt] of openersBottom) if (floorAt > openerIndex) openersBottom.set(key, floorAt - 1);
      index--;
    }
    if (closer.count === 0) {
      tokens.splice(index, 1);
      for (const [key, floorAt] of openersBottom) if (floorAt > index) openersBottom.set(key, floorAt - 1);
    }
  }
}

/** Turns leftover delimiter and bracket tokens into text and merges neighbouring text nodes. */
function finish(tokens: Token[]): Inline[] {
  const out: Inline[] = [];
  for (const token of tokens) {
    let node: Inline;
    if (isDelimiter(token)) {
      if (token.count === 0) continue;
      node = { type: "text", value: token.char.repeat(token.count) };
    } else if (isBracket(token)) {
      node = { type: "text", value: token.image ? "![" : "[" };
    } else {
      node = token;
    }
    const last = out[out.length - 1];
    if (node.type === "text" && last?.type === "text") last.value += node.value;
    else out.push(node.type === "text" ? { type: "text", value: node.value } : node);
  }
  return out;
}

/** GitHub's autolink literals: bare https://… and www.… addresses in text become links. */
function autolinkLiterals(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of inlines) {
    if (node.type === "text") {
      out.push(...linkifyText(node.value));
    } else if (node.type === "strong" || node.type === "em" || node.type === "del") {
      out.push({ ...node, children: autolinkLiterals(node.children) });
    } else {
      out.push(node);
    }
  }
  return out;
}

const LITERAL_URL = /(^|[\s*_~(])((?:https?:\/\/|www\.)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?::\d+)?[^\s<]*)/g;

function linkifyText(value: string): Inline[] {
  if (!value.includes("http") && !value.includes("www.")) return [{ type: "text", value }];
  const out: Inline[] = [];
  let last = 0;
  for (const match of value.matchAll(LITERAL_URL)) {
    let url = match[2]!;
    const start = match.index! + match[1]!.length;
    // Trailing punctuation is not part of the address, and neither is an unbalanced closing parenthesis.
    for (;;) {
      const trimmed = url.replace(/[?!.,:*_~'"]+$/, "");
      let next = trimmed;
      if (next.endsWith(")")) {
        const opens = (next.match(/\(/g) ?? []).length;
        const closes = (next.match(/\)/g) ?? []).length;
        if (closes > opens) next = next.slice(0, -1);
      }
      next = next.replace(/&[a-zA-Z0-9]+;$/, "");
      if (next === url) break;
      url = next;
    }
    if (!/\.[A-Za-z0-9_-]+/.test(url.replace(/^https?:\/\//, "")) && url.startsWith("www.")) continue;
    if (start > last) out.push({ type: "text", value: value.slice(last, start) });
    out.push({ type: "link", href: url.startsWith("www.") ? `http://${url}` : url, title: null, children: [{ type: "text", value: url }] });
    last = start + url.length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------
 * Headings and the document
 * ------------------------------------------------------------------------------------------------------------------ */

/**
 * GitHub's heading anchors (github-slugger): lowercase, drop everything but letters, numbers, marks, connector
 * punctuation, hyphens and spaces, then turn each space into a hyphen.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/** Hands out GitHub-style unique ids: the first `foo`, then `foo-1`, `foo-2`… */
export class Slugger {
  private seen = new Map<string, number>();

  slug(text: string): string {
    const base = slugify(text) || "section";
    let candidate = base;
    let count = this.seen.get(base) ?? 0;
    while (this.seen.has(candidate)) {
      count++;
      candidate = `${base}-${count}`;
    }
    this.seen.set(base, count);
    this.seen.set(candidate, 0);
    return candidate;
  }
}

function assignHeadingIds(blocks: Block[], slugger: Slugger, headings: Heading[]) {
  for (const block of blocks) {
    if (block.type === "heading") {
      block.text = inlineText(block.children).replace(/\s+/g, " ").trim();
      block.id = slugger.slug(block.text);
      headings.push({ depth: block.depth, id: block.id, text: block.text, children: block.children });
    } else if (block.type === "blockquote" || block.type === "callout") {
      assignHeadingIds(block.children, slugger, headings);
    } else if (block.type === "list") {
      for (const item of block.items) assignHeadingIds(item.children, slugger, headings);
    }
  }
}

/** Parses a Markdown document (without its front matter). */
export function parseMarkdown(source: string): MarkdownDocument {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\u0000/g, "�").split("\n").map(expandTabs);
  const refs: References = new Map();
  // Link reference definitions may appear after their use: collect them in a first pass (outside code fences).
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line, fence.char, fence.length)) fence = null;
      continue;
    }
    const opened = fenceOpen(line);
    if (opened) {
      fence = { char: opened.char, length: opened.length };
      continue;
    }
    const definition = REFERENCE_DEFINITION.exec(line);
    if (!definition) continue;
    const label = normalizeLabel(definition[1]!);
    if (refs.has(label)) continue;
    const rawHref = definition[2]!;
    refs.set(label, { href: unescapeMarkdown(rawHref.startsWith("<") ? rawHref.slice(1, -1) : rawHref), title: definition[3] ? unescapeMarkdown(definition[3].slice(1, -1)) : null });
  }
  const { blocks } = new BlockParser(refs).parse(lines);
  const headings: Heading[] = [];
  assignHeadingIds(blocks, new Slugger(), headings);
  return { blocks, headings };
}

/** Splits `---` front matter from the body. Returns the raw YAML (or null) and the Markdown after it. */
export function splitFrontMatter(source: string): { yaml: string | null; body: string; bodyLine: number } {
  const normalized = source.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { yaml: null, body: normalized, bodyLine: 1 };
  return { yaml: match[1]!, body: normalized.slice(match[0].length), bodyLine: match[0].split("\n").length };
}
