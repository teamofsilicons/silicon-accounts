/**
 * Builds the docs for the site from the repository's docs/ (`pnpm build:docs`; `pnpm dev` and `pnpm build` run it
 * first). The site never reads docs/ at run time: everything it needs is bundled here, so the standalone server works
 * without the repository beside it.
 *
 *   lib/docs/generated/pages.ts   every page's front matter and Markdown, imported by the /docs routes (git-ignored)
 *   public/docs/<path>.md         each page as written, served at /docs/<path>.md (git-ignored)
 *   public/docs.md                docs/index.md with its links made relative to /, served at /docs.md
 *
 * It also checks the docs and prints every problem with its file and line: front matter (title, description, kind,
 * order, related), links to pages that don't exist, and #anchors that name no heading on the page they point to.
 * Problems never stop the build (a page with a bad header still renders, with a fallback); --check makes them fail.
 *
 *   tsx lib/docs/build.ts            write the bundle and the raw files
 *   tsx lib/docs/build.ts --check    only check; exit 1 when there are problems
 *   tsx lib/docs/build.ts --watch    write, then again after every change under docs/ (next dev reloads the pages)
 *   --docs <dir>                     read another docs directory (default: ../docs, or ACCOUNTS_DOCS_DIR)
 *   --quiet                          print problems only
 *
 * Several builds may run this at the same time (local stacks build the site in parallel): every file is written to a
 * temporary name and renamed into place, and only when its content changed, so readers never see half a file and a
 * running `next dev` only reloads for real changes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readDocSource } from "./frontmatter";
import { resolveLink, rewriteRelativeLinks } from "./links";
import { parseMarkdown, splitFrontMatter, type Block, type Inline } from "./markdown";
import type { DocSource } from "./types";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedFile = join(webRoot, "lib", "docs", "generated", "pages.ts");
const publicDocs = join(webRoot, "public", "docs");
const publicIndex = join(webRoot, "public", "docs.md");

interface Options {
  docs: string;
  check: boolean;
  watch: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { docs: process.env.ACCOUNTS_DOCS_DIR?.trim() || resolve(webRoot, "..", "docs"), check: false, watch: false, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--check") options.check = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--docs") options.docs = resolve(argv[++index] ?? "");
    else if (arg === "--") continue;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx lib/docs/build.ts [--check] [--watch] [--quiet] [--docs <dir>]");
      process.exit(0);
    } else {
      console.error(`build:docs: unknown option ${arg}. Usage: tsx lib/docs/build.ts [--check] [--watch] [--quiet] [--docs <dir>]`);
      process.exit(2);
    }
  }
  return options;
}

/** Every .md file under `root`, as POSIX paths relative to it, skipping dotfiles and node_modules. */
function markdownFiles(root: string, directory = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) out.push(...markdownFiles(root, path));
    else if (stats.isFile() && name.endsWith(".md")) out.push(relative(root, path).split(sep).join("/"));
  }
  return out;
}

/** Writes `content` to `file` through a temporary file and a rename, only when it changed. Returns whether it wrote. */
function writeIfChanged(file: string, content: string): boolean {
  try {
    if (readFileSync(file, "utf8") === content) return false;
  } catch {
    // Not there yet.
  }
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  // Another build may prune an empty directory between our mkdir and rename: make it again once.
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temporary, content);
      renameSync(temporary, file);
      return true;
    } catch (error) {
      rmSync(temporary, { force: true });
      if (attempt > 0 || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** The line (1-based, in the file) where `needle` first appears in the body, for messages. */
function lineOf(source: DocSource, needle: string): number {
  const at = source.body.indexOf(needle);
  return at < 0 ? source.bodyLine : source.bodyLine + source.body.slice(0, at).split("\n").length - 1;
}

function linksIn(blocks: Block[]): string[] {
  const out: string[] = [];
  const inlines = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === "link") {
        out.push(node.href);
        inlines(node.children);
      } else if (node.type === "image") {
        out.push(node.src);
      } else if (node.type === "strong" || node.type === "em" || node.type === "del") {
        inlines(node.children);
      }
    }
  };
  const walk = (list: Block[]) => {
    for (const block of list) {
      if (block.type === "heading" || block.type === "paragraph") inlines(block.children);
      else if (block.type === "blockquote" || block.type === "callout") walk(block.children);
      else if (block.type === "list") for (const item of block.items) walk(item.children);
      else if (block.type === "table") for (const row of [block.head, ...block.rows]) for (const cell of row) inlines(cell);
    }
  };
  walk(blocks);
  return out;
}

interface BuildResult {
  sources: DocSource[];
  raw: Map<string, string>;
  problems: string[];
}

function collect(docsDir: string): BuildResult {
  const problems: string[] = [];
  const sources: DocSource[] = [];
  const raw = new Map<string, string>();
  if (!existsSync(docsDir) || !statSync(docsDir).isDirectory()) {
    problems.push(`${docsDir}: no docs directory here (set ACCOUNTS_DOCS_DIR or pass --docs <dir>); the site will have no docs pages`);
    return { sources, raw, problems };
  }
  for (const path of markdownFiles(docsDir)) {
    const text = readFileSync(join(docsDir, path), "utf8");
    raw.set(path, text);
    const { yaml, body, bodyLine } = splitFrontMatter(text);
    const { source, problems: found } = readDocSource(path, yaml, body, bodyLine);
    for (const problem of found) problems.push(`docs/${path}: ${problem}`);
    sources.push(source);
  }
  if (!sources.some(source => source.path === "index.md")) problems.push("docs/index.md is missing: /docs has no landing page and shows the list of pages instead");

  // Cross-links: every page link and #anchor must land somewhere.
  const byPath = new Map(sources.map(source => [source.path, source]));
  const anchors = new Map<string, Set<string>>();
  const parsed = new Map<string, Block[]>();
  for (const source of sources) {
    const doc = parseMarkdown(source.body);
    parsed.set(source.path, doc.blocks);
    anchors.set(source.path, new Set(doc.headings.map(heading => heading.id)));
  }
  for (const source of sources) {
    for (const href of linksIn(parsed.get(source.path) ?? [])) {
      const link = resolveLink(href, source.path, path => byPath.has(path));
      const at = `docs/${source.path}:${lineOf(source, `](${href}`)}`;
      if (link.kind === "missing") problems.push(`${at}: link "${href}" goes nowhere: ${link.reason}`);
      else if (link.kind === "anchor" && !anchors.get(source.path)?.has(link.anchor)) problems.push(`${at}: link "${href}" names no heading on this page`);
      else if (link.kind === "page" && link.anchor && !anchors.get(link.path)?.has(link.anchor)) problems.push(`${at}: link "${href}" names no heading in docs/${link.path}`);
    }
    for (const related of source.related) {
      if (!byPath.has(related)) problems.push(`docs/${source.path}: front matter "related" lists ${related}, which is not a page under docs/`);
      if (related === source.path) problems.push(`docs/${source.path}: front matter "related" lists the page itself`);
    }
  }
  return { sources, raw, problems };
}

function bundleModule(sources: DocSource[]): string {
  const lines = sources.map(source => `  ${JSON.stringify(source)},`);
  return [
    "/* Generated by lib/docs/build.ts from the repository's docs/: do not edit. Run `pnpm build:docs` (pnpm dev and pnpm build do). */",
    "import type { DocSource } from \"../types\";",
    "",
    "export const DOC_SOURCES: DocSource[] = [",
    ...lines,
    "];",
    "",
  ].join("\n");
}

/** Removes .md files under public/docs that no longer have a page, then empty directories. */
function prune(directory: string, keep: Set<string>, root = directory): void {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      prune(path, keep, root);
      try {
        if (!readdirSync(path).length) rmdirSync(path);
      } catch {
        // Another build wrote into it meanwhile: keep it.
      }
    } else if (name.endsWith(".md") && !keep.has(relative(root, path).split(sep).join("/"))) {
      rmSync(path, { force: true });
    }
  }
}

function write(result: BuildResult): string[] {
  const written: string[] = [];
  if (writeIfChanged(generatedFile, bundleModule(result.sources))) written.push(relative(webRoot, generatedFile));
  for (const [path, text] of result.raw) {
    if (writeIfChanged(join(publicDocs, ...path.split("/")), text)) written.push(`public/docs/${path}`);
  }
  prune(publicDocs, new Set(result.raw.keys()));
  const index = result.raw.get("index.md");
  if (index !== undefined) {
    // /docs.md is index.md one level up: its relative links gain the docs/ prefix.
    if (writeIfChanged(publicIndex, rewriteRelativeLinks(index, href => `docs/${href.replace(/^\.\//, "")}`))) written.push("public/docs.md");
  } else {
    rmSync(publicIndex, { force: true });
  }
  return written;
}

function run(options: Options): number {
  const started = performance.now();
  const result = collect(options.docs);
  const written = options.check ? [] : write(result);
  for (const problem of result.problems) console.warn(`build:docs: ${problem}`);
  if (!options.quiet) {
    const where = relative(webRoot, options.docs) || options.docs;
    const output = options.check ? "checked" : written.length ? `wrote ${written.length} file${written.length === 1 ? "" : "s"}` : "nothing changed";
    const problems = result.problems.length ? `, ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"} above` : ", no problems";
    console.log(`build:docs: ${result.sources.length} pages from ${where} (${output}${problems}) in ${Math.round(performance.now() - started)} ms`);
  }
  return result.problems.length;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let problems: number;
  try {
    problems = run(options);
  } catch (error) {
    console.error(`build:docs: could not build the docs: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  }
  if (options.check) process.exit(problems ? 1 : 0);
  if (!options.watch) return;

  console.log(`build:docs: watching ${options.docs} (Ctrl-C to stop)`);
  let timer: NodeJS.Timeout | null = null;
  watch(options.docs, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        run(options);
      } catch (error) {
        console.error(`build:docs: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 120);
  });
}

main();
