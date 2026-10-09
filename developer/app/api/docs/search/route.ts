/**
 * GET /api/docs/search?q=&product=apps|accounts&kind=start|learn|reference|overview&limit=: search the docs. Ranked
 * pages and sections with their addresses, Markdown addresses, product, kind and a snippet. Public, cacheable,
 * rate limited per address (documented in /openapi.json).
 */
import { isProblem, parseKind, parseLimit, parseProduct, parseQuery, search } from "@/lib/docs/api";
import { docsApi, methodNotAllowed } from "@/lib/server/docs-api";
import { preflight } from "@/lib/server/public-response";

export function GET(request: Request) {
  return docsApi(request, () => {
    const params = new URL(request.url).searchParams;
    const query = parseQuery(params.get("q") ?? params.get("query"));
    if (isProblem(query)) return { problem: query };
    const product = parseProduct(params.get("product"));
    if (isProblem(product)) return { problem: product };
    const kind = parseKind(params.get("kind"));
    if (isProblem(kind)) return { problem: kind };
    const limit = parseLimit(params.get("limit"));
    if (isProblem(limit)) return { problem: limit };
    return { body: search({ query, product, kind, limit }) };
  });
}

export const OPTIONS = () => preflight();
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
