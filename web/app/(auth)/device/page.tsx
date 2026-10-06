/** /device and /device?code=…: approving a CLI sign-in (web-auth area). */
import type { Metadata } from "next";
import { Device } from "@/components/auth/device";

export const metadata: Metadata = { title: "Approve a sign-in", robots: { index: false, follow: false } };

export default function Page() {
  return <Device />;
}
