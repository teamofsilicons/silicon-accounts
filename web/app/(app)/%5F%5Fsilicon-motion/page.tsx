/**
 * /__silicon-motion: motion experiments for the Silicon avatars on their cards (Anil, 2026-11-13). Development only,
 * like /__silicon-cards: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiliconMotionLab } from "@/components/kitchen/silicon-motion/silicon-motion-lab";

export const metadata: Metadata = { title: "Silicon motion lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <SiliconMotionLab />;
}
