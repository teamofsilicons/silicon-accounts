/**
 * /__accounts-signin: the hosted sign-in in /__google-signin's structure, drawn in the account site's own design (Anil,
 * 2026-11-19: "same structure, but accounts design, separate playground"). Development only, like /__banner: production
 * builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountsSigninLab } from "@/components/kitchen/accounts-signin/accounts-signin-lab";

export const metadata: Metadata = { title: "Accounts sign-in lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <AccountsSigninLab />;
}
