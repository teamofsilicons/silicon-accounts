/**
 * What every tab of an app's detail page shares: the loaded app (GET /v1/apps/{app_id}), the meta document, the shared
 * sign-in config editor, and small pieces of state that must survive switching tabs (the import being watched).
 */
import { createContext, useContext, type Accessor, type Setter } from "solid-js";
import type { AppDetail, Meta } from "../../../api";
import type { DeveloperTab } from "../../../app/navigation";
import type { ConfigEditor } from "./editor";

export interface DeveloperAppContext {
  appId: string;
  app: Accessor<AppDetail>;
  /** Replaces the app with a fresh server answer (a PATCH or PUT returned it). */
  setApp: (detail: AppDetail) => void;
  /** Reads the app again (stats, webhook state). */
  reload: () => Promise<AppDetail | undefined>;
  meta: Accessor<Meta | undefined>;
  /** Browser-facing origin of Silicon Accounts, without a trailing slash. */
  publicUrl: Accessor<string>;
  editor: ConfigEditor;
  /** Opens another tab of this app. */
  openTab: (tab: DeveloperTab) => void;
  /** The import job the Import tab is showing (kept while other tabs are open). */
  importJob: Accessor<string | null>;
  setImportJob: Setter<string | null>;
}

export const DeveloperAppContextValue = createContext<DeveloperAppContext>();

export function useDeveloperApp(): DeveloperAppContext {
  const value = useContext(DeveloperAppContextValue);
  if (!value) throw new Error("Developer tabs must render inside the app detail page (DeveloperAppContextValue is missing).");
  return value;
}
