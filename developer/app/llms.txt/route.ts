/**
 * GET /llms.txt: the docs index for language models (llmstxt.org), the Carbon's own developer/llms/llms.md served
 * exactly as written (bundled at build time by lib/docs/build.ts; a build without it serves a generated index).
 */
import { LLMS_FILES, llmsIndex, publicOrigin } from "@/lib/docs/llms";
import { preflight, publicResponse } from "@/lib/server/public-response";

export function GET(request: Request) {
  return publicResponse(request, llmsIndex(publicOrigin(request.headers, request.url)), { type: "text/plain; charset=utf-8", maxAge: 3600, modified: LLMS_FILES.index.modified });
}

export const HEAD = GET;
export const OPTIONS = () => preflight();
