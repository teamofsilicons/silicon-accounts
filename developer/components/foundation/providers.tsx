"use client";

/**
 * Everything every page shares, mounted once by the root layout: the TanStack Query client (errors toast with message
 * and hint; a signed-out 401 marks the session gone), the Arc toast stack, and the squircle runtime for browsers
 * without corner-shape. Importing lib/telemetry here applies the stored telemetry choice before any query runs.
 */
import "@/lib/telemetry";
import { useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastStack, ToastStackProvider, useToastStack } from "@/components/silicon-ui/toast-stack/toast-stack";
import { SquircleRuntime } from "@/components/foundation/squircle/squircle";
import { configureApi } from "@/lib/api/http";
import { connectToasts } from "@/lib/notify";
import { createQueryClient, isSignedOutError } from "@/lib/query/client";
import { markSignedOut } from "@/lib/query/session";
import { applyTheme } from "@/lib/theme";
import styles from "./providers.module.css";

/** Hands the mounted toast stack to lib/notify, so toasts can be raised from anywhere. */
function ToastBridge() {
  const { toast, update, dismiss } = useToastStack();
  useEffect(() => connectToasts({ toast, update, dismiss }), [toast, update, dismiss]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const created = createQueryClient(() => markSignedOut(created));
    // A call outside the query cache that finds the sign-in gone marks the session gone too.
    configureApi({ onUnauthenticated: error => { if (isSignedOutError(error)) markSignedOut(created); } });
    return created;
  });

  // The boot script painted the stored theme; from here the theme store keeps <html> in sync.
  useEffect(() => {
    applyTheme();
  }, []);

  return (
    <QueryClientProvider client={client}>
      <ToastStackProvider>
        <SquircleRuntime />
        {children}
        <ToastBridge />
        <ToastStack label="Notifications" className={styles.toasts} />
      </ToastStackProvider>
    </QueryClientProvider>
  );
}
