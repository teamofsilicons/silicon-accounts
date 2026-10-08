/**
 * /sign-in: the account site's own sign-in (first-party flow, app `silicon-accounts`), and where that flow comes back
 * (?code&state or ?error&state) before returning to the page the visitor asked for (web-auth area).
 */
import type { Metadata } from "next";
import { SignIn } from "@/components/auth/sign-in";

export const metadata: Metadata = { title: "Sign in" };

export default function Page() {
  return <SignIn />;
}
