/** Whether this request carries a developer-site sign-in, read from the sealed cookie alone (no API call). */
import "server-only";
import { cookies } from "next/headers";
import { sessionCookieName, sessionFromCookie } from "./session";

export async function isSignedIn(): Promise<boolean> {
  const store = await cookies();
  try {
    return sessionFromCookie(store.get(sessionCookieName())?.value) !== null;
  } catch {
    return false;
  }
}
