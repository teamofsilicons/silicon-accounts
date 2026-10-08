# Legacy Accounts docs renderer

The public documentation now lives in `developer/`, together with Silicon Apps documentation at
`https://developers.teamofsilicons.com/docs`. This renderer is retained as source during the migration, but
`web/proxy.ts` permanently redirects its public routes before rendering. See `web/README.md` for the exact
redirect mapping and runtime developer-origin configuration. New public docs behavior belongs in `developer/`.

The following describes the retained renderer, not routes still served by the Accounts site.

The site renders every Markdown file under the repository's `docs/` at `/docs`, serves each one as it is at
`/docs/<path>.md`, and lists them for language models at `/llms.txt` (the index) and `/llms-full.txt` (everything).
Nothing reads `docs/` at run time: `pnpm build:docs` bundles it, and `pnpm dev`, `pnpm build` and `pnpm typecheck` run
it first.

| Address | What answers |
| --- | --- |
| `/docs` | `docs/index.md` |
| `/docs/<path>` | `docs/<path>.md` (for example `/docs/start/add-sign-in`) |
| `/docs/start`, `/docs/learn`, `/docs/reference` | the group's pages, with their descriptions |
| `/docs/<path>.md`, `/docs/index.md`, `/docs.md` | the Markdown as written (static files in `public/docs`) |
| `/docs/search-index.json` | the search index the docs search loads |
| `/llms.txt`, `/llms-full.txt` | llmstxt.org files, with links on the origin the request came to (or `ACCOUNTS_PUBLIC_URL`) |

## Writing a page

Every page starts with front matter:

```yaml
---
title: Verify a proof
description: One line. It is the page's lede, its search summary and its note in llms.txt.
kind: instructive        # instructive (do this) or informative (why it works this way)
order: 40                # position in its navigation group, smaller first
related:                 # pages shown under "Related" at the end, as paths inside docs/
  - learn/proofs.md
  - reference/api/proofs.md
---
```

- **Where it goes:** the folder is the navigation group: `start/` (Start), `learn/` (Learn), `reference/` (Reference).
  A page named like a folder holds that folder's pages under it (`reference/api.md` above `reference/api/*.md`).
- **The title** comes from the front matter; a leading `# Title` in the body is not shown twice.
- **Links** are written for the files, the way GitHub reads them: `../learn/proofs.md#what-ends-a-proof`. The site turns
  them into `/docs/…` links; links to files outside `docs/` go to GitHub. Heading anchors are GitHub's.
- **GitHub** (`GITHUB_PUBLISHED` in `lib/docs/site.ts`): the repository at `GITHUB_REPO` holds only `understanding/`
  so far, so the pages leave out "Edit on GitHub" and the footer's GitHub link, and links to repository files render as
  text. Set it to `true` once `docs/` is pushed there.
- **Callouts** are GitHub alerts: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`.
- **Code blocks** name their language (`sh`, `json`, `ts`, `rust`, `http`, `toml`, `html`, `text`…) for highlighting,
  and may take a title: ```` ```sh title="Start the stack" ````. Blocks over 30 lines scroll until "Show all".
- **Raw HTML** renders as text; HTML comments (`<!-- … -->`) are dropped, so they can hold notes for authors.

`pnpm build:docs` prints every problem with its file and line: front matter that is missing or wrong, links to pages
that don't exist, and `#anchors` that name no heading. The page still renders with a fallback. `pnpm build:docs --check`
only checks and fails on any problem; `pnpm build:docs --watch` rebuilds on every change while `pnpm dev` runs.

## How it is built

| File | Does |
| --- | --- |
| `lib/docs/build.ts` | the build step: reads `docs/`, checks it, writes `lib/docs/generated/pages.ts` and `public/docs/**` |
| `lib/docs/frontmatter.ts` | the front matter (a small YAML subset) and its checks |
| `lib/docs/markdown.ts` | the Markdown parser (CommonMark + GitHub tables, strikethrough, autolinks, task items, alerts) |
| `lib/docs/links.ts` | resolves links written for files into site addresses |
| `lib/docs/highlight.ts` | syntax highlighting, on the server |
| `lib/docs/content.ts` | the pages in reading order, navigation, previous/next, parsed pages (server only) |
| `lib/docs/search-index.ts`, `lib/docs/search.ts` | the search index (server) and ranking (browser) |
| `lib/docs/llms.ts` | `/llms.txt` and `/llms-full.txt` |
| `components/docs/` | the frame, navigation, search, contents, article, Markdown and code block components |
| `app/(docs)/` | the routes |

The parser was checked against markdown-it on every page of the docs (identical output, apart from the alerts and the
dropped comments) and the highlighter on every code block (lossless).

An address under `/docs` that is no page answers `404`; the docs' "No page here" renders on the client, as every
`notFound()` below the root layout does in this app (the developer pages avoid it in `proxy.ts`). A rewrite there
would make it render on the server too.
