/**
 * /__request: the custodian request page rethought as a decision (Anil, 2026-11-12), with sample requests. Development
 * only, like /__account: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RequestLab } from "@/components/kitchen/request/request-lab";

export const metadata: Metadata = { title: "Request lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <RequestLab />;
}
