/** /authorize?app_id=…&redirect_uri=…: starts a hosted sign-in (web-auth area). */
import type { Metadata } from "next";
import { Authorize } from "@/components/auth/authorize";

export const metadata: Metadata = { title: "Signing in", robots: { index: false, follow: false } };

export default async function Page({ searchParams }: PageProps<"/authorize">) {
  const raw = await searchParams;
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") query[key] = first;
  }
  return <Authorize query={query} />;
}
