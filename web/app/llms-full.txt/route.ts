/**
 * GET /llms-full.txt (llmstxt.org): everything in one file, the Carbon's own web/llms/llms-full.md served exactly as
 * written, or web/llms/llms.md when there is no full file (bundled at build time by lib/agent/build-llms.ts).
 */
import { LLMS_FULL_TXT, LLMS_FULL_TXT_MODIFIED, LLMS_TXT, LLMS_TXT_MODIFIED } from "@/lib/agent/generated/llms";
import { errorResponse, preflight, publicResponse } from "@/lib/server/public-response";

export function GET(request: Request) {
  const body = LLMS_FULL_TXT ?? LLMS_TXT;
  if (body === null) return errorResponse(404, { code: "not_found", message: "This build has no llms-full.txt.", hint: "Read https://developers.teamofsilicons.com/llms-full.txt instead." });
  return publicResponse(request, body, { type: "text/plain; charset=utf-8", maxAge: 3600, modified: LLMS_FULL_TXT !== null ? LLMS_FULL_TXT_MODIFIED : LLMS_TXT_MODIFIED });
}

export const HEAD = GET;
export const OPTIONS = () => preflight();
