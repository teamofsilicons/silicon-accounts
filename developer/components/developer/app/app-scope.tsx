"use client";

/**
 * /apps/[appId]/…: one app's pages, in tabs (Overview, Sign-in, Details, Flows, Pages, Users, Import, Webhooks, ATA,
 * Embed). This is the app's layout: it stays mounted while the tab changes, so the app is read once
 * (GET /v1/apps/{app_id}, through the BFF) and shared with every tab together with one draft of its sign-in setup;
 * switching tabs never loses an edit.
 *
 * Tabs switch in the browser. The tab shown is the one the address names, and a switch only pushes the new address
 * (history.pushState, which Next's router follows), so it is instant, never asks the server and can't fail on a lost
 * connection; Back and Forward move between tabs the same way. The page below (`children`) renders nothing: it names
 * the tab in the document title on a load and sends an unknown tab to the overview.
 *
 * Leaving with unsaved changes asks first, whatever starts it: the brand, Apps, the command palette, signing out, or a
 * link on the page ("Your apps"). The
 * layout registers a navigation guard (lib/navigation-guard.ts) and the shell asks it before every move; the browser
 * asks before a reload or close (lib/editor.ts). A navigation that cannot ask (Back, a typed address) keeps the draft:
 * the editor stays in memory for this browser tab, a notice on the next page offers the way back (lib/kept-drafts.ts),
 * and the save bar greets the Carbon when they return.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, Braces, CircleSlash, Code, KeyRound, LayoutDashboard, ListChecks, Palette, ShieldCheck, Upload, Users, Webhook, Workflow } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { ButtonLink } from "@/components/foundation/button-link";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, Surface } from "@/components/foundation/layout/layout";
import type { ApiError } from "@/lib/api/errors";
import type { AppDetail, Meta } from "@/lib/api/types";
import { useRegisterCommands } from "@/lib/commands";
import { DEVELOPER_TABS, DEVELOPER_TAB_LABELS, navigationType, paths, type DeveloperTab } from "@/lib/navigation";
import { useNavigationGuard, type LeaveRequest } from "@/lib/navigation-guard";
import { useApp } from "@/lib/query/developer";
import { queryKeys } from "@/lib/query/keys";
import { useMeta } from "@/lib/query/session";
import { DeveloperAppContext, publicUrlOf, siliconAppsUrlOf, type DeveloperApp } from "../lib/context";
import { SECTIONS, SECTION_KEYS, type SectionKey } from "../lib/config";
import { obtainEditor, releaseEditor, retainEditor, useEditor } from "../lib/editor";
import { announceKeptDraft, draftSections, forgetKeptDraft } from "../lib/kept-drafts";
import { SOURCE_LABEL, appStatus } from "../lib/labels";
import { AppIcon } from "../parts/app-icon";
import { DeveloperTabPage, preloadTabs } from "./tab-page";
import { developerDocumentTitle } from "./titles";
import styles from "./app.module.css";

const TAB_ICONS: Record<DeveloperTab, ReactNode> = {
  overview: <LayoutDashboard size={16} strokeWidth={1.75} />,
  "sign-in": <KeyRound size={16} strokeWidth={1.75} />,
  details: <ListChecks size={16} strokeWidth={1.75} />,
  flows: <Workflow size={16} strokeWidth={1.75} />,
  pages: <Palette size={16} strokeWidth={1.75} />,
  users: <Users size={16} strokeWidth={1.75} />,
  import: <Upload size={16} strokeWidth={1.75} />,
  webhooks: <Webhook size={16} strokeWidth={1.75} />,
  ata: <ShieldCheck size={16} strokeWidth={1.75} />,
  embed: <Code size={16} strokeWidth={1.75} />,
};

/** The editor tabs and the save group each edits (Details and Flows edit one group: the flow holds the details). */
const TAB_SECTION: Partial<Record<DeveloperTab, SectionKey>> = { "sign-in": "signin", details: "flow", flows: "flow", pages: "pages" };
/** Which of a group's keys a tab shows, for its unsaved dot. */
const TAB_KEYS: Partial<Record<DeveloperTab, readonly string[]>> = { details: ["required_fields", "optional_fields"], flows: ["flow"] };

const isTab = (value: string | undefined): value is DeveloperTab => (DEVELOPER_TABS as readonly string[]).includes(value ?? "");

/** The tab a path of this app names (`/apps/briefcase/webhooks` → "webhooks"); the overview otherwise. */
function tabOf(pathname: string): DeveloperTab {
  const segment = pathname.split("/")[3];
  return isTab(segment) ? segment : "overview";
}

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function AppScope({ appId, children }: { appId: string; children: ReactNode }) {
  const query = useApp(appId);
  const meta = useMeta();
  let content: ReactNode;
  if (query.data) content = <Loaded key={appId} appId={appId} app={query.data} meta={meta.data} />;
  else if (query.error) content = <Problem appId={appId} error={query.error} retry={() => void query.refetch()} />;
  else content = <HeaderSkeleton />;
  // The page renders nothing, but it stays in the tree: it carries the redirect of an unknown tab.
  return <Page width="default">{content}{children}</Page>;
}

function HeaderSkeleton() {
  return (
    <div className={styles.loadingHeader} aria-busy="true" aria-label="Loading the app">
      <SkeletonBlock width="96px" height="16px" radius="6px" />
      <div className={styles.loadingIdentity}>
        <SkeletonBlock width="64px" height="64px" radius="18px" index={1} />
        <div className={styles.loadingLines}>
          <SkeletonBlock width="min(280px, 70%)" height="40px" radius="12px" index={2} />
          <SkeletonBlock width="min(220px, 50%)" height="16px" radius="6px" index={3} />
        </div>
      </div>
      <SkeletonBlock width="min(640px, 100%)" height="46px" radius="22px" index={4} />
      <SkeletonBlock width="100%" height="240px" radius="var(--radius-surface)" index={5} />
    </div>
  );
}

function Problem({ appId, error, retry }: { appId: string; error: ApiError; retry: () => void }) {
  const back = <ButtonLink href={paths.developer} variant="secondary">Open your apps</ButtonLink>;
  let body: ReactNode;
  if (error.status === 404) {
    body = (
      <Surface padding="none">
        <EmptyState icon={<CircleSlash size={24} strokeWidth={1.5} />} title={`No app with the id ${appId}`} description={`${error.message} Apps come from Silicon Apps; check the id, or open one of your apps.`} action={back} />
      </Surface>
    );
  } else if (error.status === 403) {
    body = (
      <Surface padding="none">
        <EmptyState icon={<Braces size={24} strokeWidth={1.5} />} title={`You don't own ${appId}`} description={`${error.message} Only the Carbon who owns an app manages its sign-in here.`} action={back} />
      </Surface>
    );
  } else {
    body = (
      <Alert tone="danger" title={`${appId} could not be loaded`}>
        {error.message} {error.hint}
        <span className={styles.alertActions}><Button size="sm" variant="secondary" onClick={retry}>Try again</Button></span>
      </Alert>
    );
  }
  return (
    <div className={styles.problem}>
      <Link href={paths.developer} className={styles.back}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />Your apps</Link>
      <h1 className="sr-only">{appId}</h1>
      {body}
    </div>
  );
}

function Loaded({ appId, app, meta }: { appId: string; app: AppDetail; meta: Meta | undefined }) {
  const pathname = usePathname();
  const router = useRouter();
  const client = useQueryClient();
  const tab = tabOf(pathname);
  const appBase = paths.developerApp(appId);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [editor] = useState(() => obtainEditor(appId, app));
  const view = useEditor(editor);
  const [importJob, setImportJob] = useState<string | null>(null);
  /** The navigation waiting for the leave question (the shell asked this app's guard), with its answer. */
  const [leaving, setLeaving] = useState<LeaveRequest | null>(null);
  const answer = useRef<((leave: boolean) => void) | null>(null);
  /** Where focus goes back when the Carbon stays: the link or the key's control, or what opened the phone sheet. */
  const returnFocus = useRef<HTMLElement | null>(null);
  /** What the kept-draft notice needs after this page is gone. */
  const latest = useRef({ name: app.name, router });
  useEffect(() => {
    latest.current = { name: app.name, router };
  });

  // This page shows the app's draft: a kept one comes back (and its notice goes), and newer stored details go to the
  // cache (the header and the tabs follow). Leaving with unsaved changes keeps the draft and says where it is.
  useEffect(() => {
    retainEditor(editor);
    forgetKeptDraft(appId);
    editor.connect({
      onStored: detail => {
        client.setQueryData(queryKeys.app.detail(appId), detail);
        void client.invalidateQueries({ queryKey: queryKeys.app.configHistory(appId) });
        void client.invalidateQueries({ queryKey: queryKeys.app.public(appId) });
      },
    });
    return () => {
      if (!releaseEditor(editor)) return;
      const kept = editor.getView();
      const href = paths.developerApp(appId, kept.dirty.signin ? "sign-in" : kept.dirty.flow ? "flows" : "pages");
      const { name, router: navigate } = latest.current;
      announceKeptDraft(appId, {
        name,
        sections: draftSections(kept),
        open: () => navigate.push(href, { transitionTypes: [navigationType(window.location.pathname, href)] }),
      });
    };
  }, [editor, client, appId]);
  // Every read of the app (a refetch on focus, after a webhook change or an import) reaches the draft.
  useEffect(() => editor.adopt(app), [editor, app]);
  // Once the app is on screen, the other tabs' code loads in the background: a later switch needs no network at all.
  useEffect(() => {
    // Safari has no requestIdleCallback: a short wait stands in for it.
    if (typeof window.requestIdleCallback !== "function") {
      const timer = setTimeout(preloadTabs, 1500);
      return () => clearTimeout(timer);
    }
    const handle = window.requestIdleCallback(() => preloadTabs(), { timeout: 4000 });
    return () => window.cancelIdleCallback(handle);
  }, []);
  // A tab switch changes only the address, so the document title follows here.
  useEffect(() => {
    document.title = developerDocumentTitle(tab, appId);
  }, [tab, appId]);

  const openTab = useCallback((next: DeveloperTab) => {
    const href = paths.developerApp(appId, next);
    if (window.location.pathname !== href) window.history.pushState(null, "", href);
    // Keep the tab list in view when the switch happens far down a long tab.
    const frame = tabsRef.current;
    if (frame && frame.getBoundingClientRect().top < 0) frame.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [appId]);

  const reload = useCallback(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.app.detail(appId) });
  }, [client, appId]);

  const setApp = useCallback((update: (current: AppDetail) => AppDetail) => {
    client.setQueryData<AppDetail>(queryKeys.app.detail(appId), current => (current ? update(current) : current));
  }, [client, appId]);

  const context = useMemo<DeveloperApp>(() => ({
    appId,
    app,
    meta,
    publicUrl: publicUrlOf(meta),
    siliconAppsUrl: siliconAppsUrlOf(meta),
    editor,
    openTab,
    reload,
    setApp,
    importJob,
    setImportJob,
  }), [appId, app, meta, editor, openTab, reload, setApp, importJob]);

  // Leaving with unsaved changes: the shell asks this guard before every way out (links, the dock and its sheet, the
  // palette, number keys, Settings, signing out). Moving between this app's tabs never asks.
  const anyDirty = view.anyDirty;
  useNavigationGuard(anyDirty ? {
    protects: (href, reason) => reason === "sign-out" || !(href === appBase || href.startsWith(`${appBase}/`) || href.startsWith(`${appBase}?`)),
    confirm: request => new Promise<boolean>(resolve => {
      answer.current?.(false);
      answer.current = resolve;
      returnFocus.current = request.returnFocus;
      setLeaving(request);
    }),
  } : null);

  /** Answers the question: leave (keeping the draft, or discarding it first) or stay. */
  const decide = (choice: "stay" | "keep" | "discard") => {
    const resolve = answer.current;
    answer.current = null;
    // Leaving: the next page takes focus; nothing here gets it back.
    if (choice !== "stay") returnFocus.current = null;
    if (choice === "discard") for (const section of SECTIONS) editor.discard(section);
    setLeaving(null);
    resolve?.(choice !== "stay");
  };

  useRegisterCommands(() => DEVELOPER_TABS.map(value => ({
    id: `developer.tab.${value}`,
    label: `${DEVELOPER_TAB_LABELS[value]} of ${app.name}`,
    description: `Open the ${DEVELOPER_TAB_LABELS[value]} tab`,
    group: app.name,
    icon: TAB_ICONS[value],
    keywords: [appId, value, "developer", "app"],
    run: () => openTab(value),
  })), [app.name, appId, openTab]);

  const status = appStatus(app.status);
  const dirtyTab = (value: DeveloperTab) => {
    const section = TAB_SECTION[value];
    if (!section || !view.dirty[section]) return false;
    const keys = TAB_KEYS[value] ?? SECTION_KEYS[section];
    return view.changes[section].some(path => keys.some(key => path === key || path.startsWith(`${key}.`) || path.startsWith(`${key}[`))) || (value === "sign-in" && view.typedPaths.signin.length > 0);
  };

  return (
    <DeveloperAppContext.Provider value={context}>
      <header className={styles.header}>
        <Link href={paths.developer} className={styles.back}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />Your apps</Link>
        <div className={styles.identity}>
          <AppIcon name={app.name} src={app.logo_url} size={64} decorative />
          <div className={styles.identityText}>
            <h1 className={styles.title}>{app.name}</h1>
            <div className={styles.facts}>
              <span className={styles.appId}>{app.app_id}<CopyButton value={app.app_id} label="Copy app id" iconOnly variant="plain" /></span>
              <span className={styles.factDivider} aria-hidden="true" />
              <Badge size="sm" tone={status.tone}>{status.label}</Badge>
              <span className={styles.factDivider} aria-hidden="true" />
              <span>{SOURCE_LABEL[app.source] ?? app.source}</span>
            </div>
          </div>
          {app.homepage_url ? (
            <div className={styles.headerActions}>
              <ButtonLink href={app.homepage_url} external target="_blank" rel="noopener" variant="ghost" size="sm">Homepage<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" /></ButtonLink>
            </div>
          ) : null}
        </div>
        {app.status === "disabled" ? (
          <Alert tone="warning" title={`${app.name} is disabled`}>It can&apos;t sign anyone in until it is enabled again in Silicon Apps. Its setup can still be changed here.</Alert>
        ) : null}
      </header>
      <div ref={tabsRef} className={styles.tabFrame}>
        <Tabs value={tab} onValueChange={next => { if (isTab(next) && next !== tab) openTab(next); }} activationMode="manual" className={styles.tabs}>
          <TabsList aria-label={`${app.name} sections`}>
            {DEVELOPER_TABS.map(value => (
              <TabsTrigger key={value} value={value}>
                <span className={styles.tabLabel}>
                  {DEVELOPER_TAB_LABELS[value]}
                  {dirtyTab(value) ? <span className={styles.tabDot} role="img" aria-label="unsaved changes" /> : null}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={tab} forceMount className={styles.panel}><DeveloperTabPage tab={tab} /></TabsContent>
        </Tabs>
      </div>
      <Dialog open={!!leaving} onOpenChange={open => { if (!open) decide("stay"); }}>
        <DialogContent
          className={styles.leaveDialog}
          title={leaving?.reason === "sign-out" ? "Sign out with unsaved changes?" : "Leave with unsaved changes?"}
          description={`Your changes to ${draftSections(view) || "the sign-in setup"} of ${app.name} are not saved yet.`}
          onCloseAutoFocus={event => {
            // Staying: focus goes back where the Carbon was (the dialog has no trigger of its own to return to).
            const target = returnFocus.current;
            returnFocus.current = null;
            if (!target) return;
            event.preventDefault();
            (target.isConnected ? target : document.querySelector<HTMLElement>("[role='tabpanel'][data-state='active']"))?.focus({ preventScroll: true });
          }}
        >
          <div className={styles.leaveBody}>
            {leaving?.reason === "sign-out" ? (
              <p>Signing out ends this browser tab&apos;s drafts too, so they would be lost. Save them first, or discard them.</p>
            ) : (
              <p>Leave them as a draft to come back to in this browser tab (reloading the page loses it), or discard them.</p>
            )}
            <div className={styles.leaveActions}>
              <Button variant="danger" className={styles.leaveDiscard} onClick={() => decide("discard")}>{leaving?.reason === "sign-out" ? "Discard and sign out" : "Discard and leave"}</Button>
              <Button variant="ghost" onClick={() => decide("stay")}>Keep editing</Button>
              {leaving?.reason === "sign-out" ? null : <Button variant="secondary" onClick={() => decide("keep")}>Leave, keep the draft</Button>}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </DeveloperAppContext.Provider>
  );
}
