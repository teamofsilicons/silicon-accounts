/**
 * /developer: the apps a Carbon owns, each opening its sign-in setup (web-developer area; components/developer/home).
 */
import type { Metadata } from "next";
import { DeveloperHome } from "@/components/developer/home/developer-home";

export const metadata: Metadata = { title: "Developer" };

export default function Page() {
  return <DeveloperHome />;
}
