/** A stored-cookie hint is never treated as current server authority. */
import "server-only";
import { cookies } from "next/headers";
import { sessionCookieName, sessionFromCookie, refreshSession } from "./session";
export async function isSignedIn(): Promise<boolean> {
  const store = await cookies();
  const session = sessionFromCookie(store.get(sessionCookieName())?.value);
  if (!session) return false;
  const result = await refreshSession(session, {});
  if (!result.ok && result.error !== "invalid_grant") throw new Error("Your sign-in is temporarily unavailable. Please retry shortly.");
  return result.ok;
}
