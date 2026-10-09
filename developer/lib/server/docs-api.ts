/**
 * The public docs JSON API's shared handling (app/api/docs): the per-address rate limit, structured errors, and the
 * cacheable JSON answer with the rate-limit headers on it.
 */
import "server-only";
import type { QueryProblem } from "@/lib/docs/api";
import { RATE_LIMITS } from "@/lib/site";
import { errorResponse, jsonResponse } from "./public-response";
import { rateLimit, rateLimitedError } from "./rate-limit";

export type ApiResult = { status?: number; body: unknown } | { problem: QueryProblem; status?: number };

export function docsApi(request: Request, handle: () => ApiResult): Response {
  const decision = rateLimit(request, "api", RATE_LIMITS.api);
  if (!decision.ok) return errorResponse(429, rateLimitedError(decision, RATE_LIMITS.api.windowSeconds), decision.headers);
  try {
    const result = handle();
    if ("problem" in result) return errorResponse(result.status ?? 400, result.problem, decision.headers);
    return jsonResponse(request, result.body, { maxAge: 300, status: result.status ?? 200, headers: decision.headers });
  } catch (error) {
    console.error("developer site: the docs API failed:", error);
    return errorResponse(500, { code: "internal_error", message: "The docs API failed to answer this request.", hint: "Try again; if it keeps happening, report it with `silicon-accounts report`." }, decision.headers);
  }
}

/** The answer to a method the docs API does not take: it only reads. */
export function methodNotAllowed(): Response {
  return errorResponse(405, { code: "method_not_allowed", message: "The docs API only reads: use GET.", hint: "See /openapi.json for every endpoint and its parameters." }, { Allow: "GET, HEAD, OPTIONS" });
}
