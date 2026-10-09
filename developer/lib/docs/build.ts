/**
 * Builds the docs for the site from the repository's docs/ (`pnpm build:docs`; `pnpm dev` and `pnpm build` run it
 * first). The site never reads docs/ at run time: everything it needs is bundled here, so the standalone server works
 * without the repository beside it.
 *
 *   lib/docs/generated/pages.ts   every page's front matter, Markdown and last change, imported by the /docs routes
 *                                 (git-ignored)
 *   lib/docs/generated/llms.ts    developer/llms/llms.md and llms-full.md exactly as written, served at /llms.txt and
 *                                 /llms-full.txt (git-ignored; a missing llms-full.md leaves the generated full text)
 *   public/docs/<path>.md         each page as written, served at /docs/<path>.md (git-ignored)
 *   public/docs.md                docs/index.md with its links made relative to /, served at /docs.md
 *
 * A page's last change (`modified`, ISO 8601) is its file's last commit, or the file's own time when it has changes
 * not committed yet (or no git is at hand). It feeds dateModified, the sitemap's lastmod and the JSON API.
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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readDocSource } from "./frontmatter";
import { resolveLink, rewriteRelativeLinks } from "./links";
import { parseMarkdown, splitFrontMatter, type Block, type Inline } from "./markdown";
import type { DocSource } from "./types";
import { slugOf, SECTIONS } from "./site";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedFile = join(webRoot, "lib", "docs", "generated", "pages.ts");
const generatedLlms = join(webRoot, "lib", "docs", "generated", "llms.ts");
const llmsDir = join(webRoot, "llms");
const publicDocs = join(webRoot, "public", "docs");
const publicIndex = join(webRoot, "public", "docs.md");

interface Options {
  docs: string;
  apps: string;
  check: boolean;
  watch: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { docs: process.env.ACCOUNTS_DOCS_DIR?.trim() || resolve(webRoot, "..", "docs"), apps: process.env.APPS_DOCS_DIR?.trim() || resolve(webRoot, "..", "docs-apps"), check: false, watch: false, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--check") options.check = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--apps") options.apps = resolve(argv[++index] ?? "");
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

/** Runs git in `directory`, or null when git or the repository is not there. */
function git(directory: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/**
 * When each file under `directory` last changed, as ISO 8601 (keys are paths relative to it): its last commit, or the
 * file's own modification time when it has uncommitted changes, is untracked, or git is not available.
 */
function modifiedDates(directory: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const log = git(directory, ["log", "--format=--%cI", "--name-only", "--relative", "--", "."]);
  if (log !== null) {
    let date: string | null = null;
    for (const line of log.split("\n")) {
      if (line.startsWith("--")) date = line.slice(2).trim();
      else if (line.trim() && date && !out.has(line.trim())) out.set(line.trim(), new Date(date).toISOString());
    }
  }
  const dirty = new Set((git(directory, ["ls-files", "-m", "-o", "--exclude-standard", "--", "."]) ?? "").split("\n").map(line => line.trim()).filter(Boolean));
  for (const file of files) {
    if (log === null || dirty.has(file) || !out.has(file)) {
      try {
        out.set(file, statSync(join(directory, file)).mtime.toISOString());
      } catch {
        out.delete(file);
      }
    }
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
  const files = markdownFiles(docsDir);
  const modified = modifiedDates(docsDir, files);
  for (const path of files) {
    const text = readFileSync(join(docsDir, path), "utf8");
    raw.set(path, text);
    const { yaml, body, bodyLine } = splitFrontMatter(text);
    const { source, problems: found } = readDocSource(path, yaml, body, bodyLine);
    for (const problem of found) problems.push(`docs/${path}: ${problem}`);
    sources.push({ ...source, modified: modified.get(path) ?? null });
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

/** The hand-written agent files, exactly as written (null when one is missing), and when each last changed. */
interface LlmsFiles {
  index: string | null;
  full: string | null;
  indexModified: string | null;
  fullModified: string | null;
}

function readLlms(): LlmsFiles {
  const names = ["llms.md", "llms-full.md"];
  const present = names.filter(name => existsSync(join(llmsDir, name)));
  const modified = present.length ? modifiedDates(llmsDir, present) : new Map<string, string>();
  const read = (name: string) => (present.includes(name) ? readFileSync(join(llmsDir, name), "utf8") : null);
  return { index: read("llms.md"), full: read("llms-full.md"), indexModified: modified.get("llms.md") ?? null, fullModified: modified.get("llms-full.md") ?? null };
}

function llmsModule(files: LlmsFiles): string {
  return [
    "/* Generated by lib/docs/build.ts from developer/llms/: do not edit. Run `pnpm build:docs` (pnpm dev and pnpm build do). */",
    "",
    "/** developer/llms/llms.md exactly as written, served at /llms.txt (null: the file is missing, the index is generated). */",
    `export const LLMS_TXT: string | null = ${JSON.stringify(files.index)};`,
    "/** developer/llms/llms-full.md exactly as written, served at /llms-full.txt (null: missing, the full text is generated). */",
    `export const LLMS_FULL_TXT: string | null = ${JSON.stringify(files.full)};`,
    `export const LLMS_TXT_MODIFIED: string | null = ${JSON.stringify(files.indexModified)};`,
    `export const LLMS_FULL_TXT_MODIFIED: string | null = ${JSON.stringify(files.fullModified)};`,
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

function write(result: BuildResult, llms: LlmsFiles): string[] {
  const written: string[] = [];
  if (writeIfChanged(generatedFile, bundleModule(result.sources))) written.push(relative(webRoot, generatedFile));
  if (writeIfChanged(generatedLlms, llmsModule(llms))) written.push(relative(webRoot, generatedLlms));
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
  const accounts = collect(options.docs);
  const apps = collect(options.apps);
  const landing = readFileSync(join(webRoot, "lib/docs/landing.md"), "utf8");
  const parsed = splitFrontMatter(landing);
  const root = readDocSource("index.md", parsed.yaml, parsed.body, parsed.bodyLine);
  const landingModified = modifiedDates(join(webRoot, "lib/docs"), ["landing.md"]).get("landing.md") ?? null;
  const result: BuildResult = { sources: [{ ...root.source, modified: landingModified }], raw: new Map([["index.md", landing]]), problems: root.problems };
  const llms = readLlms();
  // Not a problem for --check: the agent files fall back to the generated text, and are the Carbon's to write.
  if (llms.index === null && !options.quiet) console.warn("build:docs: developer/llms/llms.md is missing, so /llms.txt serves the generated index");
  if (llms.full === null && !options.quiet) console.warn("build:docs: developer/llms/llms-full.md is missing, so /llms-full.txt serves the generated full text");
  for (const [product, data] of [["accounts", accounts], ["apps", apps]] as const) {
    result.sources.push(...data.sources.map(source => ({ ...source, path: `${product}/${source.path}`, related: source.related.map(path => `${product}/${path}`) })));
    for (const [path, raw] of data.raw) result.raw.set(`${product}/${path}`, raw);
    result.problems.push(...data.problems.map(problem => `${product}: ${problem}`));
  }
  // Validate the new shared landing and cross-product links after namespacing too.
  const byPath = new Map(result.sources.map(source => [source.path, source]));
  const bySlug = new Map(result.sources.map(source => [slugOf(source.path), source]));
  for (const source of result.sources) {
    for (const href of linksIn(parseMarkdown(source.body).blocks)) {
      const link = resolveLink(href, source.path, path => byPath.has(path));
      let target = link.kind === "page" ? byPath.get(link.path) : link.kind === "anchor" ? source : undefined;
      let anchor = link.kind === "page" || link.kind === "anchor" ? link.anchor : null;
      if (link.kind === "site" && /^\/docs(?:\/|$)/.test(link.href)) {
        const url = new URL(link.href, "https://developers.teamofsilicons.com");
        const slug = decodeURIComponent(url.pathname.replace(/^\/docs\/?/, "")).replace(/\/$/, "");
        target = byPath.get(slug) ?? bySlug.get(slug);
        anchor = decodeURIComponent(url.hash.slice(1)) || null;
        const isGroup = SECTIONS.some(section => ["apps", "accounts"].some(product => slug === `${product}/${section.key}`));
        if (!target && !isGroup) result.problems.push(`${source.path}: link "${href}" names no documentation page`);
      }
      if (link.kind === "missing") result.problems.push(`${source.path}: link "${href}" goes nowhere: ${link.reason}`);
      if (target && anchor && !parseMarkdown(target.body).headings.some(heading => heading.id === anchor)) result.problems.push(`${source.path}: link "${href}" names no heading in ${target.path}`);
    }
  }
  const written = options.check ? [] : write(result, llms);
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
  for (const directory of [options.docs, options.apps, join(webRoot, "lib/docs"), llmsDir].filter(existsSync)) watch(directory, { recursive: true }, (_event, filename) => {
    if (directory.endsWith("lib/docs") && filename !== "landing.md") return;
    if (directory === llmsDir && !String(filename ?? "").endsWith(".md")) return;
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
