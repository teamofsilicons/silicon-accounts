/** Any other address under /api/docs: a structured 404, never the HTML not-found page. */
import { errorResponse } from "@/lib/server/public-response";

function missing(request: Request): Response {
  const path = new URL(request.url).pathname;
  return errorResponse(404, { code: "not_found", message: `The docs API has nothing at ${path.slice(0, 160)}.`, hint: "Use /api/docs/search, /api/docs/pages or /api/docs/pages/{product}/{path}; /openapi.json describes them." });
}

export const GET = missing;
export const POST = missing;
export const PUT = missing;
export const PATCH = missing;
export const DELETE = missing;
