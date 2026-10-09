/**
 * The signed-in portal around every page under it: the shared providers (query client, toasts, squircle runtime), the
 * top bar, the ⌘K palette and the sign-in gate. One instance stays mounted while you move between your apps and their
 * tabs. The branded hosted-page styles load here only: the public pages never show a branded preview.
 */
import "@/styles/branding.css";
import type { ReactNode } from "react";
import { Providers } from "@/components/foundation/providers";
import { DeveloperShell } from "@/components/foundation/shell/developer-shell";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <DeveloperShell>{children}</DeveloperShell>
    </Providers>
  );
}
