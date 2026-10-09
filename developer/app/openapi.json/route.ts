/** GET /openapi.json: OpenAPI 3.1 for this site's public endpoints (lib/agent/openapi.ts). */
import { openApi } from "@/lib/agent/openapi";
import { jsonResponse, preflight } from "@/lib/server/public-response";

export function GET(request: Request) {
  return jsonResponse(request, openApi(), { maxAge: 3600 });
}

export const OPTIONS = () => preflight();
