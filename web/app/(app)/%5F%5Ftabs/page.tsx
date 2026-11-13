/**
 * /__tabs: tighter versions of Silicon UI's Tabs to choose from (Anil, 2026-11-13: "reduce the padding"), before the
 * change is made in Silicon UI itself. Development only, like the other labs.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TabsLab } from "@/components/kitchen/tabs/tabs-lab";

export const metadata: Metadata = { title: "Tabs lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <TabsLab />;
}
