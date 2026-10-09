/**
 * The account shell around the account pages (foundation-owned). One instance stays mounted while you
 * move between /apps, /silicons, /proofs…, so the dock's highlight glides instead of reappearing.
 */
import type { ReactNode } from "react";
import { AccountShell } from "@/components/foundation/shell/account-shell";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <AccountShell>{children}</AccountShell>;
}
