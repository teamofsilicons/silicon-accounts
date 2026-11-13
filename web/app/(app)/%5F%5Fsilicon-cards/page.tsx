/**
 * /__silicon-cards: Silicon cards with their pixel avatars, four ways to blend art and words (Anil, 2026-11-12).
 * Development only, like /__account and /__banner: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiliconCardsLab } from "@/components/kitchen/silicon-cards/silicon-cards-lab";

export const metadata: Metadata = { title: "Silicon cards lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <SiliconCardsLab />;
}
