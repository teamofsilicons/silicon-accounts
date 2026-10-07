/**
 * GET /auth/session: whether this browser has a developer-site sign-in, answered from the sealed cookie alone (no call
 * to Silicon Accounts). The pages ask this before reading `/api/accounts/me`, so a signed-out visit gets a plain
 * `{"signed_in": false}` instead of a 401 that browsers log as an error on every signed-out page.
 */
import { NextResponse, type NextRequest } from "next/server";
import { readSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const response = NextResponse.json({ signed_in: readSession(request) !== null });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
