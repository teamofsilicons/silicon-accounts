import type { Metadata } from "next";
import { InterfaceAuthorize } from "@/components/auth/interface-authorize";

export const metadata: Metadata = { title: "Sign in to an Interface", robots: { index: false, follow: false } };

export default async function Page({ searchParams }: PageProps<"/interface-authorize">) {
  const raw = await searchParams;
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") query[key] = first;
  }
  return <InterfaceAuthorize query={query} />;
}
