"use client";

/**
 * What every tab of an app's developer page shares: the loaded app (GET /v1/apps/{app_id}), the service meta, the
 * shared sign-in setup editor, and small pieces of state that must survive switching tabs (the import being followed).
 * Provided by the app's layout (components/developer/app/app-scope.tsx), which stays mounted while tabs change.
 * `publicUrl` is the accounts site (the hosted pages, the SDK, the OIDC issuer), never this site.
 */
import { createContext, useContext } from "react";
import type { AppDetail, Meta } from "@/lib/api/types";
import type { DeveloperTab } from "@/lib/navigation";
import type { ConfigEditor } from "./editor";

export interface DeveloperApp {
  appId: string;
  app: AppDetail;
  meta: Meta | undefined;
  /** Browser-facing origin of Silicon Accounts (the OIDC issuer), without a trailing slash. */
  publicUrl: string;
  /** Where apps are created ("New app"). */
  siliconAppsUrl: string;
  editor: ConfigEditor;
  /** Opens another tab of this app. */
  openTab: (tab: DeveloperTab) => void;
  /** Reads the app again (stats, webhook state); a newer config version reaches the editor as well. */
  reload: () => Promise<void>;
  /** Writes a newer view of the app into the cache (a PUT or DELETE answered it). */
  setApp: (update: (current: AppDetail) => AppDetail) => void;
  /** The import job the Import tab is following (kept while other tabs are open). */
  importJob: string | null;
  setImportJob: (id: string | null) => void;
}

export const DeveloperAppContext = createContext<DeveloperApp | null>(null);

export function useDeveloperApp(): DeveloperApp {
  const value = useContext(DeveloperAppContext);
  if (!value) throw new Error("Developer tabs render inside an app's page (components/developer/app/app-scope.tsx provides DeveloperAppContext).");
  return value;
}

/** The browser-facing origin of Silicon Accounts (the accounts site and OIDC issuer), from /v1/meta. */
export function publicUrlOf(meta: Meta | undefined): string {
  return meta?.public_url?.replace(/\/+$/, "") || "https://accounts.teamofsilicons.com";
}

/** Where apps are created. */
export function siliconAppsUrlOf(meta: Meta | undefined): string {
  return meta?.silicon_apps_url?.replace(/\/+$/, "") || "https://apps.teamofsilicons.com";
}

/** The host of a URL ("accounts.teamofsilicons.com"), for provider consoles and address bars. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "accounts.teamofsilicons.com";
  }
}
