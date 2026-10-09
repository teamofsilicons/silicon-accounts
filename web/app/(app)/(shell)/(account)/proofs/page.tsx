/**
 * /proofs: the User verification proofs apps hold about you, issuing app to receiving app, and revoking them (web-account: app/(app)/(shell)/(account)/ and components/account/).
 */
import type { Metadata } from "next";
import { Proofs } from "@/components/account/proofs/proofs";

export const metadata: Metadata = { title: "User verification" };

export default function Page() {
  return <Proofs />;
}
