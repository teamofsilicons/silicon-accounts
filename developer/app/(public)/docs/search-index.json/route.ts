/**
 * GET /docs/search-index.json: every page and h2/h3 section as plain text, for the docs search in the browser
 * (components/docs/docs-search.tsx). Built once per server process from the bundled docs.
 */
import { buildSearchIndex } from "@/lib/docs/search-index";

let body: string | null = null;

export function GET() {
  body ??= JSON.stringify(buildSearchIndex());
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
