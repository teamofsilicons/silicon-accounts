/**
 * /__links: an action among words as a link, underlined always or on hover only (Anil, 2026-11-10). Development only,
 * like /__text and /__cards: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LinksLab } from "@/components/kitchen/links/links-lab";

export const metadata: Metadata = { title: "Link button lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <LinksLab />;
}
