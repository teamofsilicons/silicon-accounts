/**
 * /sign-in-methods, the Security pillar: the emails, phone numbers and Google or Apple accounts that sign you in, where you are signed in, and a way to Activity (web-account: app/(app)/(shell)/(account)/ and components/account/).
 */
import type { Metadata } from "next";
import { SignInMethods } from "@/components/account/sign-in-methods/sign-in-methods";

export const metadata: Metadata = { title: "Security" };

export default function Page() {
  return <SignInMethods />;
}
