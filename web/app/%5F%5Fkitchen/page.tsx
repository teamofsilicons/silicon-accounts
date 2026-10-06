/**
 * /__kitchen: the style guide, every installed Arc component in both themes with the Silicon Accounts brand and
 * squircles. Development only: production builds answer 404 unless ACCOUNTS_KITCHEN=1 (a review build).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Kitchen } from "@/components/kitchen/kitchen";

export const metadata: Metadata = { title: "Style guide", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <Kitchen />;
}
