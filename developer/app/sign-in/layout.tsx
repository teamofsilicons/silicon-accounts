/** /sign-in reads the session and the accounts site's address through the portal's query client. */
import type { ReactNode } from "react";
import { Providers } from "@/components/foundation/providers";

export default function SignInLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
