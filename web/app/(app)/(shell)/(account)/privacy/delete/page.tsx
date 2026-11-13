/**
 * /privacy/delete, Delete your account: the checks before deleting, what you lose, and Delete Account
 * (components/account/privacy/delete-page.tsx; Anil, 2026-11-12, /__delete design H). Reached from Data & privacy
 * (web-account: app/(app)/(shell)/(account)/ and components/account/).
 */
import type { Metadata } from "next";
import { DeletePage } from "@/components/account/privacy/delete-page";

export const metadata: Metadata = { title: "Delete your account" };

export default function Page() {
  return <DeletePage />;
}
