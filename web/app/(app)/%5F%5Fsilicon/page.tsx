/**
 * /__silicon: versions of a Silicon's page as its profile, to compare and pick from. Development only, like /__kitchen:
 * production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiliconProfileLab } from "@/components/kitchen/silicon-profile/silicon-profile-lab";

export const metadata: Metadata = { title: "Silicon profile lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <SiliconProfileLab />;
}
