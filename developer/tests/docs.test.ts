import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DOC_SOURCES } from "../lib/docs/generated/pages";
import { splitFrontMatter, parseMarkdown } from "../lib/docs/markdown";
import { resolveLink, rewriteRelativeLinks } from "../lib/docs/links";
import { pageHref, rawHref, editHref } from "../lib/docs/site";

const files = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)).map(path => `${entry.name}/${path}`) : entry.name.endsWith(".md") ? [entry.name] : []);
const exists = (path: string) => DOC_SOURCES.some(source => source.path === path);

test("every source page is bundled unchanged under its product and exported as Markdown", () => {
  for (const [product, directory] of [["accounts", "../docs"], ["apps", "../docs-apps"]]) {
    const sources = files(directory);
    assert.equal(DOC_SOURCES.filter(page => page.path.startsWith(`${product}/`)).length, sources.length);
    assert.ok(sources.length >= (product === "accounts" ? 42 : 9));
    for (const path of sources) {
      const raw = readFileSync(join(directory, path), "utf8");
      const source = DOC_SOURCES.find(page => page.path === `${product}/${path}`)!;
      assert.equal(source.body, splitFrontMatter(raw).body);
      assert.equal(readFileSync(join("public/docs", product, path), "utf8"), raw);
      assert.deepEqual(parseMarkdown(source.body).headings, parseMarkdown(splitFrontMatter(raw).body).headings);
    }
  }
});

test("relative links, anchors, groups and source files keep the correct product namespace", () => {
  assert.deepEqual(resolveLink("../reference/api.md#authentication-and-retries", "apps/start/publish.md", exists), { kind: "page", path: "apps/reference/api.md", href: "/docs/apps/reference/api#authentication-and-retries", anchor: "authentication-and-retries" });
  assert.equal(resolveLink("../learn/accounts.md", "accounts/start/add-sign-in.md", exists).kind, "page");
  assert.equal(resolveLink("reference/", "accounts/index.md", exists).kind, "section");
  assert.deepEqual(resolveLink("/docs/accounts/start/add-sign-in", "apps/start/publish.md", exists), { kind: "site", href: "/docs/accounts/start/add-sign-in" });
  assert.equal(resolveLink("javascript:alert(1)", "apps/index.md", exists).kind, "missing");
  assert.equal(resolveLink("../missing.md", "apps/start/publish.md", exists).kind, "missing");
  assert.equal(pageHref("accounts/index.md"), "/docs/accounts");
  assert.equal(rawHref("apps/index.md"), "/docs/apps/index.md");
  assert.equal(editHref("apps/start/install.md"), "https://github.com/teamofsilicons/silicon-accounts/blob/main/docs-apps/start/install.md");
});

test("relocated Markdown rewrites prose links while preserving code examples", () => {
  const source = "[Read](apps/index.md)\n```md\n[Example](same.md)\n```\n`[Code](literal.md)`";
  assert.equal(rewriteRelativeLinks(source, href => `docs/${href}`), "[Read](docs/apps/index.md)\n```md\n[Example](same.md)\n```\n`[Code](literal.md)`");
});
