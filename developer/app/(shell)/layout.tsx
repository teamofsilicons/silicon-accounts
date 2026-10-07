/**
 * The developer site's shell around every signed-in page: the top bar, the ⌘K palette and the sign-in gate. One
 * instance stays mounted while you move between your apps and their tabs.
 */
import type { ReactNode } from "react";
import { DeveloperShell } from "@/components/foundation/shell/developer-shell";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <DeveloperShell>{children}</DeveloperShell>;
}
