/**
 * /__needs: alternatives for Home's Needs you block, to compare and pick from. Development only, like /__kitchen:
 * production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NeedsLab } from "@/components/kitchen/needs/needs-lab";

export const metadata: Metadata = { title: "Needs you lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <NeedsLab />;
}
