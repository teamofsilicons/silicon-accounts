"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { useNavigationGuard } from "@/lib/navigation-guard";
import { draftSnapshot, flushPendingSaves, hasPendingSaves, pendingDrafts, subscribeDrafts } from "./api";
import "./publishing.css";

/** A failed save blocks our links. Browser history retains the draft in this tab and offers a direct way back. */
export function PublishingGuard() {
  const router = useRouter();
  const pathname = usePathname();
  useSyncExternalStore(subscribeDrafts, draftSnapshot, () => 0);
  const [error, setError] = useState<Error>();
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (!hasPendingSaves()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  useNavigationGuard({
    protects: () => hasPendingSaves(),
    confirm: async () => {
      try { await flushPendingSaves(); setError(undefined); return true; }
      catch (failure) { setError(failure as Error); return false; }
    },
  });
  const away = pendingDrafts().find(draft => draft.href.split("?")[0] !== pathname);
  if (!error && !away) return null;
  return <Alert tone="warning" title="Publishing changes are not saved yet">
    {error?.message || "Your draft is kept in this browser tab. Return to it to retry saving before closing or reloading."}
    {away ? <Button variant="secondary" size="sm" onClick={() => router.push(away.href)}>Return to publishing draft</Button> : null}
  </Alert>;
}
