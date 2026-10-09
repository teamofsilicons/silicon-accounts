/**
 * GET /llms-full.txt: everything in one file for language models (llmstxt.org), the Carbon's own
 * developer/llms/llms-full.md served exactly as written (bundled at build time by lib/docs/build.ts; a build without
 * it serves every docs page in reading order, with links between pages made absolute).
 */
import { LLMS_FILES, llmsFull, publicOrigin } from "@/lib/docs/llms";
import { preflight, publicResponse } from "@/lib/server/public-response";

export function GET(request: Request) {
  return publicResponse(request, llmsFull(publicOrigin(request.headers, request.url)), { type: "text/plain; charset=utf-8", maxAge: 3600, modified: LLMS_FILES.full.modified });
}

export const HEAD = GET;
export const OPTIONS = () => preflight();
