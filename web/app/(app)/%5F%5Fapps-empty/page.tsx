/**
 * /__apps-empty: what Connected Apps shows before any app is connected (Anil, 2026-11-13: Home's Apps card leads there
 * for someone who has just joined). Development only, like the other labs.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppsEmptyLab } from "@/components/kitchen/apps-empty/apps-empty-lab";

export const metadata: Metadata = { title: "Apps empty lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <AppsEmptyLab />;
}
