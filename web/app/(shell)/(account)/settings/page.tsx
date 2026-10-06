/**
 * /settings: theme, telemetry, where you are signed in, signing out and deleting your account (web-account: app/(shell)/(account)/ and components/account/).
 */
import type { Metadata } from "next";
import { Settings } from "@/components/account/settings/settings";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return <Settings />;
}
