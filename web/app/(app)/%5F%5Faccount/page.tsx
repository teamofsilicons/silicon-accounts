/**
 * /__account: designs for Home's "Your account" cards, to compare and pick from (Anil, 2026-11-12). Development only,
 * like /__banner and /__cards: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountLab } from "@/components/kitchen/account/account-lab";

export const metadata: Metadata = { title: "Your account lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <AccountLab />;
}
