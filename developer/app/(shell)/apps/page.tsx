/** /: the apps a Carbon owns, each opening its sign-in setup (components/developer/home). */
import type { Metadata } from "next";
import { DeveloperHome } from "@/components/developer/home/developer-home";

export const metadata: Metadata = { title: "Your apps" };

export default function Page() {
  return <DeveloperHome />;
}
