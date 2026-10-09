/**
 * /apps: the apps you have signed into, what each can see, and removing an app's access (web-account: app/(app)/(shell)/(account)/ and components/account/).
 */
import type { Metadata } from "next";
import { Apps } from "@/components/account/apps/apps";

export const metadata: Metadata = { title: "Apps" };

export default function Page() {
  return <Apps />;
}
