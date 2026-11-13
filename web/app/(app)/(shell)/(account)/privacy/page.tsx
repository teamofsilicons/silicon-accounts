/**
 * /privacy, Data & privacy: what each app sees, and deleting your account (components/account/privacy/privacy.tsx;
 * Anil, 2026-11-12). /settings redirects here (next.config.ts) (web-account: app/(app)/(shell)/(account)/ and
 * components/account/).
 */
import type { Metadata } from "next";
import { Privacy } from "@/components/account/privacy/privacy";

export const metadata: Metadata = { title: "Data & Privacy" };

export default function Page() {
  return <Privacy />;
}
