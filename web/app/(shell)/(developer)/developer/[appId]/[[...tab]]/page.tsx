/**
 * /developer/[appId]/[[...tab]]: one tab of an app's developer pages; no tab is the overview, the tabs are
 * DEVELOPER_TABS in lib/navigation.ts.
 *
 * The app's layout (../layout.tsx, components/developer/app/app-scope.tsx) renders the tab the address names, and a
 * switch between tabs only changes the address in the browser (history.pushState), so it never waits for the server.
 * This page renders nothing: on a load it names the tab in the document title. An address that names no tab never
 * reaches it on a load: proxy.ts answers it with the not-found page and a real 404. (A client-side navigation to one
 * still ends at the overview, without adding a history entry.)
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { developerTitle } from "@/components/developer/app/titles";
import { developerTabFrom, paths } from "@/lib/navigation";

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function generateMetadata({ params }: PageProps<"/developer/[appId]/[[...tab]]">): Promise<Metadata> {
  const { appId, tab } = await params;
  return { title: developerTitle(developerTabFrom(tab) ?? "overview", decode(appId)) };
}

export default async function Page({ params }: PageProps<"/developer/[appId]/[[...tab]]">) {
  const { appId, tab } = await params;
  if (!developerTabFrom(tab)) redirect(paths.developerApp(decode(appId)));
  return null;
}
