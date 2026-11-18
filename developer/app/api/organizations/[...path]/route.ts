import {NextRequest} from "next/server";
import {organizationsApiUrl} from "@/lib/server/config";
import {organizationProxyRoute} from "@/lib/server/organization-routes";
import {integrationProxy} from "@/lib/server/integration-proxy";
export const dynamic = "force-dynamic";
function handle(request: NextRequest) {
  const raw = request.nextUrl.pathname.slice("/api/organizations/".length);
  return integrationProxy(request, organizationsApiUrl(), organizationProxyRoute(raw, request.method), "Organizations");
}
export const GET = handle;
export const POST = handle;
