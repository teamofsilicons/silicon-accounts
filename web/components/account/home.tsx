"use client";

/** "/" decides by session: the landing page (rendered bare by the shell) or the identity home. */
import { useSession } from "@/lib/query/session";
import { Identity } from "./identity/identity";
import { Landing } from "./landing/landing";

export function Home() {
  const { status } = useSession();
  if (status === "signed_in") return <Identity />;
  if (status === "signed_out") return <Landing />;
  return null;
}
