/**
 * /__cards: card systems for Your Silicons and Your apps, to compare and pick from (Anil, 2026-11-11). Development
 * only, like /__kitchen, /__banner and /__needs: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CardsLab } from "@/components/kitchen/cards/cards-lab";

export const metadata: Metadata = { title: "Cards lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <CardsLab />;
}
