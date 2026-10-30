/**
 * /personal: Personal info, the profile and contact details, each editor opened by ?edit=<field>
 * (web-account: app/(app)/(shell)/(account)/ and components/account/). Suspense: the page reads its search params.
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { Identity } from "@/components/account/identity/identity";

export const metadata: Metadata = { title: "Personal info" };

export default function Page() {
  return <Suspense fallback={null}><Identity /></Suspense>;
}
