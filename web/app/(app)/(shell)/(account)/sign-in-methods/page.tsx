/**
 * /sign-in-methods, the Security pillar: a checkup, your Silicons' keys, your ways in, your devices and the way to
 * Activity, on Home's rules (components/account/security/security.tsx; Anil, 2026-11-10). The previous page,
 * components/account/sign-in-methods/sign-in-methods.tsx (SignInMethods), stays for its parts (the email and phone
 * lists, Google and Apple's marks and the connect outcome) and is no longer routed (web-account: app/(app)/(shell)/(account)/
 * and components/account/). Suspense: the page reads its search params (?edit=email|phone opens a list).
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { Security } from "@/components/account/security/security";

export const metadata: Metadata = { title: "Security" };

export default function Page() {
  return <Suspense fallback={null}><Security /></Suspense>;
}
