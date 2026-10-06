/**
 * /sign-in-methods: the emails, phone numbers and Google or Apple accounts that sign you in (web-account: app/(shell)/(account)/ and components/account/).
 */
import type { Metadata } from "next";
import { SignInMethods } from "@/components/account/sign-in-methods/sign-in-methods";

export const metadata: Metadata = { title: "Sign-in methods" };

export default function Page() {
  return <SignInMethods />;
}
