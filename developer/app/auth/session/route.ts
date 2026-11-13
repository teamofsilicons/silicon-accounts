import { NextResponse, type NextRequest } from "next/server";
import { readSession, refreshSession, clientHeaders, clearSession, writeSession, errorBody } from "@/lib/server/session";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const session = readSession(request);
  if (!session) return NextResponse.json({ signed_in: false }, { headers: { "Cache-Control": "no-store" } });
  const result = await refreshSession(session, clientHeaders(request));
  if (!result.ok && result.error !== "invalid_grant") return NextResponse.json(errorBody("session_unavailable", result.description, "Retry shortly."), { status: 503, headers: { "Cache-Control": "no-store" } });
  const response = NextResponse.json({ signed_in: result.ok }, { headers: { "Cache-Control": "no-store" } });
  if (result.ok) writeSession(response, result.session); else clearSession(response);
  return response;
}
