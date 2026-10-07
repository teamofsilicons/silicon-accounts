/**
 * /sign-in: the developer site's front door for a visitor without a session (and where a failed sign-in lands, with a
 * fixed message per error code). "Continue with Silicon Accounts" starts the sign-in (/auth/sign-in).
 */
import type { Metadata } from "next";
import { SignInPage } from "@/components/sign-in/sign-in-page";

export const metadata: Metadata = { title: "Sign in" };

export default async function Page({ searchParams }: PageProps<"/sign-in">) {
  const query = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
  return <SignInPage error={one(query.error)} returnTo={one(query.return_to)} signedOut={one(query.signed_out) === "1"} />;
}
