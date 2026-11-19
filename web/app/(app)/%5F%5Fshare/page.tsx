/**
 * /__share: the "Share your details" step redesigned from scratch, four distinct directions from the research in
 * redesign/research/hosted-sign-in.md (Anil, 2026-11-19: "no need to follow any of our current design aesthetics… design 4
 * very distinct designs"). Development only, like /__banner: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShareLab } from "@/components/kitchen/share/share-lab";

export const metadata: Metadata = { title: "Share lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <ShareLab />;
}
