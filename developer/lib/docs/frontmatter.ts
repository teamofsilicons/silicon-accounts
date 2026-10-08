/**
 * The docs' front matter: the small piece of YAML at the top of every page.
 *
 *   ---
 *   title: Add sign-in to your app
 *   description: Register where Silicon Accounts may send people back, …
 *   kind: instructive            # or informative
 *   order: 10                    # position in its navigation group
 *   related:                     # paths inside docs/
 *     - start/hosted-pages.md
 *     - learn/sign-in-flow.md
 *   ---
 *
 * The YAML subset covers what front matter needs: `key: value` scalars (plain, "double" or 'single' quoted, numbers,
 * booleans, null), flow lists (`[a, b]`), block lists (`- item`), plain scalars continued on indented lines, and `|` /
 * `>` block scalars. Problems are reported with the line they are on, never thrown.
 */
import type { DocKind, DocSource } from "./types";

export type YamlValue = string | number | boolean | null | YamlValue[];

export interface YamlResult {
  data: Record<string, YamlValue>;
  problems: string[];
}

function stripComment(value: string): string {
  let quote: string | null = null;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quote) {
      if (char === "\\" && quote === "\"") index++;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "#" && (index === 0 || /\s/.test(value[index - 1]!))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function scalar(raw: string): YamlValue {
  const value = stripComment(raw.trim());
  if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  if (/^[-+]?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (value === "" || value === "~" || /^null$/i.test(value)) return null;
  return value;
}

function flowList(raw: string): YamlValue[] | null {
  const value = stripComment(raw.trim());
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of value.slice(1, -1)) {
    if (quote) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === "\"" || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) items.push(current);
  return items.map(scalar);
}

export function parseYaml(yaml: string, firstLine = 2): YamlResult {
  const lines = yaml.split("\n");
  const data: Record<string, YamlValue> = {};
  const problems: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const lineNumber = firstLine + index;
    if (/^\s*(#.*)?$/.test(line)) {
      index++;
      continue;
    }
    const match = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (!match) {
      problems.push(`line ${lineNumber}: expected "key: value", found ${JSON.stringify(line.trim())}`);
      index++;
      continue;
    }
    const key = match[1]!;
    const rest = stripComment(match[2] ?? "");
    if (key in data) problems.push(`line ${lineNumber}: "${key}" is set twice; the last one wins`);
    index++;

    if (/^[|>][+-]?$/.test(rest)) {
      // Block scalar: the indented lines below, kept (|) or folded into one line (>).
      const block: string[] = [];
      while (index < lines.length && (/^\s+\S/.test(lines[index]!) || /^\s*$/.test(lines[index]!))) {
        block.push(lines[index]!.trim());
        index++;
      }
      while (block.length && !block[block.length - 1]) block.pop();
      data[key] = rest.startsWith("|") ? block.join("\n") : block.join(" ").replace(/\s+/g, " ").trim();
      continue;
    }

    if (rest === "") {
      // A block list (indented "- item" lines), or nothing.
      const items: YamlValue[] = [];
      while (index < lines.length) {
        const item = /^\s*-(?:[ \t]+(.*))?$/.exec(lines[index]!);
        if (item) {
          items.push(scalar(item[1] ?? ""));
          index++;
        } else if (/^\s*(#.*)?$/.test(lines[index]!)) {
          index++;
        } else {
          break;
        }
      }
      data[key] = items.length ? items : null;
      continue;
    }

    const list = flowList(rest);
    if (list) {
      data[key] = list;
      continue;
    }

    // A plain or quoted scalar, possibly continued on more-indented lines.
    let value = rest;
    while (index < lines.length && /^\s+\S/.test(lines[index]!) && !/^\s*-\s/.test(lines[index]!)) {
      value += ` ${lines[index]!.trim()}`;
      index++;
    }
    data[key] = scalar(value);
  }
  return { data, problems };
}

const KNOWN_KEYS = new Set(["title", "description", "kind", "order", "related"]);

/** The heading text of the first `# Title` in a body, as a fallback title. */
function firstHeading(body: string): string | null {
  const match = /^ {0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  return match ? match[1]!.replace(/[`*_]/g, "").trim() : null;
}

/**
 * Turns a page's front matter into a DocSource. Every problem is reported (with the reason and what was used instead)
 * and the page still renders with a sensible fallback, so one bad header never hides a page.
 */
export function readDocSource(path: string, yaml: string | null, body: string, bodyLine: number): { source: DocSource; problems: string[] } {
  const problems: string[] = [];
  const parsed = yaml === null ? { data: {}, problems: ["has no front matter (a --- block with title, description, kind, order)"] } : parseYaml(yaml);
  problems.push(...parsed.problems);
  const data = parsed.data as Record<string, YamlValue | undefined>;

  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`unknown front matter key "${key}" (known: ${[...KNOWN_KEYS].join(", ")}); it is ignored`);
  }

  const fallbackTitle = firstHeading(body) ?? path.split("/").pop()!.replace(/\.md$/, "").replace(/[-_]/g, " ");
  let title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "";
  if (!title) {
    problems.push(`front matter "title" is missing or not text; using "${fallbackTitle}"`);
    title = fallbackTitle;
  }

  let description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) problems.push(`front matter "description" is missing; the page has no lede, search summary or llms.txt note`);
  if (description.includes("\n")) description = description.replace(/\s+/g, " ");

  const section = path.includes("/") ? path.split("/")[0] : "";
  let kind: DocKind = section === "start" ? "instructive" : "informative";
  if (data.kind === "instructive" || data.kind === "informative") kind = data.kind;
  else problems.push(`front matter "kind" must be instructive or informative, found ${JSON.stringify(data.kind ?? null)}; using ${kind}`);

  let order = 1000;
  if (typeof data.order === "number" && Number.isFinite(data.order)) order = data.order;
  else problems.push(`front matter "order" must be a number, found ${JSON.stringify(data.order ?? null)}; the page goes last in its group`);

  let related: string[] = [];
  if (data.related === undefined || data.related === null) related = [];
  else if (Array.isArray(data.related)) {
    related = data.related.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map(entry => entry.trim().replace(/^\.\//, "").replace(/^\/+/, ""));
    if (related.length !== data.related.length) problems.push(`front matter "related" has entries that are not paths; they are ignored`);
  } else {
    problems.push(`front matter "related" must be a list of paths inside docs/, found ${JSON.stringify(data.related)}`);
  }

  return { source: { path, title, description, kind, order, related, body, bodyLine }, problems };
}
