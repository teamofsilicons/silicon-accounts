/**
 * /silicons/[uuid]: one Silicon's page (components/account/silicons/silicon-page.tsx). The segment is its uuid (its si:id
 * works too).
 */
import type { Metadata } from "next";
import { SiliconPage } from "@/components/account/silicons/silicon-page";

export const metadata: Metadata = { title: "Silicon" };

export default async function Page({ params }: PageProps<"/silicons/[uuid]">) {
  const { uuid } = await params;
  return <SiliconPage uuid={decodeURIComponent(uuid)} />;
}
