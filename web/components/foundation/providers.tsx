"use client";

/**
 * Everything every page shares, mounted once by the root layout: the TanStack Query client (errors toast with message
 * and hint; a 401 marks the session gone), the Arc toast stack, and the squircle runtime for browsers without
 * corner-shape. Importing lib/telemetry here applies the stored telemetry choice before any query runs.
 */
import "@/lib/telemetry";
import { useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastStack, ToastStackProvider, useToastStack } from "@/components/arc/toast-stack/toast-stack";
import { SquircleRuntime } from "@/components/foundation/squircle/squircle";
import { configureApi } from "@/lib/api/http";
import { connectToasts } from "@/lib/notify";
import { createQueryClient } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { markSignedOut } from "@/lib/query/session";
import { applyTheme } from "@/lib/theme";
import styles from "./providers.module.css";

/** Hands the mounted toast stack to lib/notify, so toasts can be raised from anywhere. */
function ToastBridge() {
  const { toast, update, dismiss } = useToastStack();
  useEffect(() => connectToasts({ toast, update, dismiss }), [toast, update, dismiss]);
  return null;
}

export interface ProvidersProps {
  children: ReactNode;
  /** "embed" (the iframe page): no toasts, no theme sync on <html>. */
  surface?: "site" | "embed";
  /**
   * "none" when the request carried no session cookie: the browser is signed out for sure, so the session starts
   * known (null) and signed-out pages render on the server. "cookie": ask GET /v1/session.
   */
  sessionHint?: "none" | "cookie";
}

export function Providers({ children, surface = "site", sessionHint = "cookie" }: ProvidersProps) {
  const [client] = useState(() => {
    const created = createQueryClient(() => markSignedOut(created));
    // Any call that answers 401 (outside the query cache too) marks the session gone.
    configureApi({ onUnauthenticated: () => markSignedOut(created) });
    if (sessionHint === "none") created.setQueryData(queryKeys.session, null);
    return created;
  });

  // The boot script painted the stored theme; from here the theme store keeps <html> in sync.
  useEffect(() => {
    if (surface === "site") applyTheme();
  }, [surface]);

  return (
    <QueryClientProvider client={client}>
      <ToastStackProvider>
        <SquircleRuntime />
        {children}
        {surface === "site" ? (
          <>
            <ToastBridge />
            <ToastStack label="Notifications" className={styles.toasts} />
          </>
        ) : null}
      </ToastStackProvider>
    </QueryClientProvider>
  );
}
