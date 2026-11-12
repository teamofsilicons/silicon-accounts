/**
 * /__activity: the Activity page beside three other designs (Anil, 2026-11-12). Development only, like /__dialog and
 * /__links: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActivityLab } from "@/components/kitchen/activity/activity-lab";

export const metadata: Metadata = { title: "Activity designs", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <ActivityLab />;
}
