/**
 * The search index the docs search loads (server only, served at /docs/search-index.json): one record for each page
 * (its title, description and intro) and one for each h2 and h3 section (its heading and everything under it, h4 and
 * deeper included), as plain text. Prose and code are kept apart: both are searched, snippets come from the prose.
 */
import "server-only";
import { docs, parsedPage } from "./content";
import { inlineText, type Block } from "./markdown";
import type { SearchRecord } from "./search";

/** Code is searchable (commands, fields, endpoints), but only the start of each block, and less of it per section. */
const CODE_BLOCK_LIMIT = 240;
const CODE_RECORD_LIMIT = 1200;
const TEXT_RECORD_LIMIT = 3600;

interface Parts {
  text: string[];
  code: string[];
}

function collect(block: Block, parts: Parts): void {
  switch (block.type) {
    case "heading":
    case "paragraph":
      parts.text.push(inlineText(block.children));
      return;
    case "code":
      parts.code.push(block.value.slice(0, CODE_BLOCK_LIMIT));
      return;
    case "blockquote":
    case "callout":
      for (const child of block.children) collect(child, parts);
      return;
    case "list":
      for (const item of block.items) for (const child of item.children) collect(child, parts);
      return;
    case "table":
      for (const row of [block.head, ...block.rows]) parts.text.push(row.map(inlineText).join(" · "));
      return;
    case "hr":
      return;
  }
}

const tidy = (pieces: string[], limit: number) => {
  const flat = pieces.join(" ").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

export function buildSearchIndex(): SearchRecord[] {
  const records: SearchRecord[] = [];
  docs().pages.forEach((page, order) => {
    const { blocks } = parsedPage(page);
    let current: SearchRecord = { t: page.title, u: page.href, g: page.groupLabel, x: "", o: order };
    let parts: Parts = { text: [page.description], code: [] };
    const flush = () => {
      current.x = tidy(parts.text, TEXT_RECORD_LIMIT);
      const code = tidy(parts.code, CODE_RECORD_LIMIT);
      if (code) current.c = code;
      records.push(current);
    };
    for (const block of blocks) {
      if (block.type === "heading" && (block.depth === 2 || block.depth === 3)) {
        flush();
        current = { t: page.title, h: block.text, u: `${page.href}#${block.id}`, g: page.groupLabel, x: "", o: order };
        parts = { text: [], code: [] };
        continue;
      }
      collect(block, parts);
    }
    flush();
  });
  return records;
}
