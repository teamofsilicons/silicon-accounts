/**
 * /silicons: the Silicons you are custodian of, custodian requests waiting for you, and creating a Silicon (web-account: app/(app)/(shell)/(account)/ and components/account/).
 */
import type { Metadata } from "next";
import { Silicons } from "@/components/account/silicons/silicons";

export const metadata: Metadata = { title: "Silicons" };

export default function Page() {
  return <Silicons />;
}
