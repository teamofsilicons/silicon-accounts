"use client";

/**
 * The tab of an app's developer page the address names. Each tab is its own chunk (the page editor and the import
 * wizard are big): the first one shows a skeleton in the final layout while it loads, and the others load in the
 * background once the app is on screen (`preloadTabs`), so switching tabs later needs nothing from the network and works
 * on a lost connection. A tab that fails to load or render says so in its panel, with Try again; the app's header,
 * the tabs and the draft stay. The tab fades in. Opacity only: a transform here would turn the tab into the
 * containing block of its fixed save bar while the entrance runs.
 */
import { Component, Suspense, createElement, use, useState, type ComponentType, type ReactNode, type ReactPromise } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { DEVELOPER_TAB_LABELS, type DeveloperTab } from "@/lib/navigation";

function TabSkeleton() {
  return (
    <div style={{ display: "grid", gap: "var(--space-6)" }} aria-busy="true" aria-label="Loading">
      <SkeletonBlock width="100%" height="140px" radius="var(--radius-surface)" />
      <SkeletonBlock width="100%" height="260px" radius="var(--radius-surface)" index={1} />
    </div>
  );
}

const LOADERS: Record<DeveloperTab, () => Promise<ComponentType>> = {
  publishing: () => import("../../publishing/workspace").then(module => module.PublishingTab),
  releases: () => import("../../publishing/workspace").then(module => module.ReleasesTab),
  authors: () => import("../../publishing/workspace").then(module => module.AuthorsTab),
  history: () => import("../../publishing/workspace").then(module => module.HistoryTab),
  overview: () => import("../tabs/overview").then(module => module.OverviewTab),
  "sign-in": () => import("../tabs/sign-in").then(module => module.SignInTab),
  details: () => import("../tabs/details").then(module => module.DetailsTab),
  flows: () => import("../tabs/flows").then(module => module.FlowsTab),
  pages: () => import("../tabs/pages").then(module => module.PagesTab),
  users: () => import("../tabs/users").then(module => module.UsersTab),
  import: () => import("../tabs/import").then(module => module.ImportTab),
  webhooks: () => import("../tabs/webhooks").then(module => module.WebhooksTab),
  "app-verification": () => import("../tabs/app_verification").then(module => module.AppVerificationTab),
  embed: () => import("../tabs/embed").then(module => module.EmbedTab),
};

/**
 * One load per tab, shared by every render; a failed load is forgotten, so Try again (or the next visit) loads afresh.
 * A finished load carries React's thenable fields (status, value), so `use` reads it at once: a tab loaded in the
 * background renders without a skeleton frame.
 */
const loads = new Map<DeveloperTab, ReactPromise<ComponentType>>();
function loadTab(tab: DeveloperTab): ReactPromise<ComponentType> {
  const found = loads.get(tab);
  if (found) return found;
  const load = LOADERS[tab]();
  loads.set(tab, load);
  load.then(
    value => {
      loads.set(tab, Object.assign(load, { status: "fulfilled" as const, value }));
    },
    () => {
      if (loads.get(tab) === load) loads.delete(tab);
    },
  );
  return load;
}

/** Loads every tab's code in the background (once the app is on screen), so a later switch is instant and offline-proof. */
export function preloadTabs(): void {
  // A failure here is quiet: the tab says so itself if it is opened before a later load succeeds.
  for (const tab of Object.keys(LOADERS) as DeveloperTab[]) loadTab(tab).then(undefined, () => undefined);
}

/** The tab, once its code is here (suspends until then). */
function LoadedTab({ tab }: { tab: DeveloperTab }) {
  // The same component every time for a tab (a module's export), only known once its code is here.
  return createElement(use(loadTab(tab)));
}

interface BoundaryProps {
  tab: DeveloperTab;
  onRetry: () => void;
  children: ReactNode;
}

/** Keeps a tab's failure inside its panel (the site's own error page would take the whole app and its draft away). */
class TabBoundary extends Component<BoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = /chunk|module|import|fetch/i.test(`${error.name} ${error.message}`);
    return (
      <Alert tone="danger" title={`The ${DEVELOPER_TAB_LABELS[this.props.tab]} tab could not be shown`}>
        {chunk
          ? "Its code did not arrive, most likely because the connection dropped. Your unsaved changes are still here. Check your connection, then try again."
          : `It failed while drawing: ${error.message}. Your unsaved changes are still here.`}
        <span style={{ display: "flex", marginTop: "var(--space-3)" }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              this.setState({ error: null });
              this.props.onRetry();
            }}
          >
            Try again
          </Button>
        </span>
      </Alert>
    );
  }
}

export function DeveloperTabPage({ tab }: { tab: DeveloperTab }) {
  const reduced = useReducedMotion();
  const [attempt, setAttempt] = useState(0);
  return (
    <motion.div
      key={tab}
      style={{ display: "grid", minWidth: 0 }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduced ? motionTokens.duration.instant : motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}
    >
      <TabBoundary
        key={attempt}
        tab={tab}
        onRetry={() => setAttempt(value => value + 1)}
      >
        <Suspense fallback={<TabSkeleton />}>
          <LoadedTab tab={tab} />
        </Suspense>
      </TabBoundary>
    </motion.div>
  );
}
