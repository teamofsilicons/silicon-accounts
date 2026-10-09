/**
 * GET /api/docs/pages?product=apps|accounts&kind=start|learn|reference|overview: every docs page in reading order,
 * narrowed by product and kind, each with its address, Markdown address, type and last change. Public, cacheable,
 * rate limited per address.
 */
import { isProblem, listPages, parseKind, parseProduct } from "@/lib/docs/api";
import { docsApi, methodNotAllowed } from "@/lib/server/docs-api";
import { preflight } from "@/lib/server/public-response";

export function GET(request: Request) {
  return docsApi(request, () => {
    const params = new URL(request.url).searchParams;
    const product = parseProduct(params.get("product"));
    if (isProblem(product)) return { problem: product };
    const kind = parseKind(params.get("kind"));
    if (isProblem(kind)) return { problem: kind };
    const pages = listPages({ product, kind });
    return { body: { filters: { product, kind }, total: pages.length, pages } };
  });
}

export const OPTIONS = () => preflight();
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
