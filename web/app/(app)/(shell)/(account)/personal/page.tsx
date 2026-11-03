/**
 * /personal: Personal info, the signed-in account's identity card (photo, name, id, date of birth, contact details)
 * (web-account: app/(app)/(shell)/(account)/ and components/account/).
 */
import type { Metadata } from "next";
import { Identity } from "@/components/account/identity/identity";

export const metadata: Metadata = { title: "Personal info" };

export default function Page() {
  return <Identity />;
}
