/**
 * GET /status.json: whether Silicon Accounts, Silicon Apps and this site are up right now, as JSON (lib/status.ts).
 * The twin of /status. Always 200 when this site answers: a service that is down is data, not an error. Caches may keep
 * it until the round of checks is 30 seconds old, when it is checked again.
 */
import { jsonResponse, preflight } from "@/lib/server/public-response";
import { secondsLeft, statusReport } from "@/lib/status";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const report = await statusReport();
  return jsonResponse(request, report, {
    modified: report.checked_at,
    headers: { "Cache-Control": `public, max-age=${secondsLeft(report)}, must-revalidate` },
  });
}

export const OPTIONS = () => preflight();
