# Unified developer documentation

The native docs engine bundles `../docs/` as Accounts and `../docs-apps/` as Apps. `landing.md` is the shared overview. `pnpm dev`, `pnpm build` and `pnpm typecheck` generate content first. No source files are read at runtime.

| Address | Content |
| --- | --- |
| `/docs` | Shared landing page |
| `/docs/accounts/<path>` | `docs/<path>.md` |
| `/docs/apps/<path>` | `docs-apps/<path>.md` |
| `/docs/<product>/start`, `/learn`, `/reference` | Product section indexes |
| `/docs/<product>/<path>.md` | Original Markdown, including product `index.md` |
| `/docs.md`, `/docs/index.md` | Shared landing Markdown |
| `/docs/search-index.json` | One search index with product-labelled results |
| `/llms.txt`, `/llms-full.txt` | Combined index and full documentation |

The shell is public for all `/docs` descendants. Canonical links use `developers.teamofsilicons.com`; exports use `DEVELOPER_PUBLIC_URL` when configured, the canonical origin in production, or the local request origin in development.

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
  them into `/docs/<product>/…` links; links to files outside `docs/` go to GitHub. Heading anchors are GitHub's.
- **GitHub** source links point to the published Accounts repository: `docs/` for Accounts, `docs-apps/` for Apps. Links to external Apps source files should use absolute GitHub URLs.
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
| `app/(shell)/docs/`, `app/(docs)/` | HTML routes and plain-text exports |

The parser was checked against markdown-it on every page of the docs (identical output, apart from the alerts and the
dropped comments) and the highlighter on every code block (lossless).

Unknown documentation paths are checked in `proxy.ts` before streaming and render the native missing-page view with HTTP 404. Client navigation also calls `notFound()`.
