/**
 * GET /llms.txt: the docs index for language models (llmstxt.org): what Silicon Accounts is, how the docs are
 * organised, and every page's Markdown address with its one-line description. Built from the bundled docs.
 */
import { llmsIndex, publicOrigin } from "@/lib/docs/llms";

export function GET(request: Request) {
  return new Response(llmsIndex(publicOrigin(request.headers, request.url)), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
