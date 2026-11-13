/**
 * /__text: text colour ladders with a step between the text and the secondary text (Anil, 2026-11-10). Development
 * only, like /__cards, /__banner and /__needs: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TextLab } from "@/components/kitchen/text/text-lab";

export const metadata: Metadata = { title: "Text colour lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <TextLab />;
}
