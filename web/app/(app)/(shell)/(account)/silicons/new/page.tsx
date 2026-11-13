/**
 * /silicons/new: create a Silicon you are custodian of (components/account/silicons/new-silicon-page.tsx), a page of its
 * own rather than a side panel (Anil, 2026-11-01).
 */
import type { Metadata } from "next";
import { NewSiliconPage } from "@/components/account/silicons/new-silicon-page";

export const metadata: Metadata = { title: "Create a Silicon" };

export default function Page() {
  return <NewSiliconPage />;
}
