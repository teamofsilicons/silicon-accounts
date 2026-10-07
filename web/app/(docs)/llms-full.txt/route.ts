/**
 * GET /llms-full.txt: every page of the docs as Markdown in one file, in reading order (llmstxt.org), with links
 * between pages made absolute. Built from the bundled docs.
 */
import { llmsFull, publicOrigin } from "@/lib/docs/llms";

export function GET(request: Request) {
  return new Response(llmsFull(publicOrigin(request.headers, request.url)), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
