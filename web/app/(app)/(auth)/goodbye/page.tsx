/**
 * /goodbye: shown after an account is deleted (components/auth/goodbye.tsx; web-auth area). Public: there is no session
 * left to check.
 */
import type { Metadata } from "next";
import { Goodbye } from "@/components/auth/goodbye";

export const metadata: Metadata = { title: "Account deletion requested", robots: { index: false, follow: false } };

export default function Page() {
  return <Goodbye />;
}
