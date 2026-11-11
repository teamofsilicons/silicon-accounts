/**
 * /__dialog: the Text code dialog now, beside the same dialog with a hierarchy (Anil, 2026-11-10). Development only,
 * like /__links and /__text: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DialogLab } from "@/components/kitchen/dialog/dialog-lab";

export const metadata: Metadata = { title: "Dialog hierarchy lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <DialogLab />;
}
