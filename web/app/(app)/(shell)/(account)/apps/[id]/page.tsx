/**
 * /apps/[id]: one connected app's page (components/account/apps/app-page.tsx). The segment is its app id.
 */
import type { Metadata } from "next";
import { AppPage } from "@/components/account/apps/app-page";

export const metadata: Metadata = { title: "App" };

export default async function Page({ params }: PageProps<"/apps/[id]">) {
  const { id } = await params;
  return <AppPage appId={decodeURIComponent(id)} />;
}
