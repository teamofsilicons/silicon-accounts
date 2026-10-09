/**
 * /activity: what happened to your account, grouped by day (web-account: app/(app)/(shell)/(account)/ and components/account/).
 */
import type { Metadata } from "next";
import { Activity } from "@/components/account/activity/activity";

export const metadata: Metadata = { title: "Activity" };

export default function Page() {
  return <Activity />;
}
