/** /authorize/flow/[id]: one hosted sign-in; Google and Apple return here too (web-auth area). */
import type { Metadata } from "next";
import { Flow } from "@/components/auth/flow-page";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default async function Page({ params }: PageProps<"/authorize/flow/[id]">) {
  const { id } = await params;
  return <Flow id={decodeURIComponent(id)} />;
}
