/** Only labels a link (the BFF enforces the session): a transient refresh failure keeps the cookie's answer. */
import "server-only";
import { cookies } from "next/headers";
import { sessionCookieName, sessionFromCookie, refreshSession } from "./session";
export async function isSignedIn(): Promise<boolean> {
  const store = await cookies();
  const session = sessionFromCookie(store.get(sessionCookieName())?.value);
  if (!session) return false;
  const result = await refreshSession(session, {});
  return result.ok || result.error !== "invalid_grant";
}
