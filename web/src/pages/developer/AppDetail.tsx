/**
 * /developer/:appId/:tab?: one app's sign-in setup, in tabs: Overview, Sign-in, Branding, Users, Import, Webhooks,
 * Proofs and Embed (DEVELOPER_TABS; an unknown tab shows Overview). The app is read once (GET /v1/apps/{app_id}) and
 * shared with every tab, together with one draft of its sign-in config, so switching tabs never loses an edit and
 * leaving with unsaved changes asks first.
 */
import { A, useBeforeLeave, useNavigate, useParams } from "@solidjs/router";
import { ArrowLeft, ArrowUpRight, Braces, CircleSlash, Code, KeyRound, LayoutDashboard, Palette, ShieldCheck, Upload, Users, Webhook } from "lucide-solid";
import { For, Match, Show, Suspense, Switch, createEffect, createSignal, lazy, on, onCleanup, onMount, untrack, type Accessor, type Component, type JSX } from "solid-js";
import { api, ApiError, type AppDetail as AppDetailView, type Meta } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { Badge } from "../../arc/badge/badge";
import { Button, LinkButton } from "../../arc/button/button";
import { CopyButton } from "../../arc/copy-button/copy-button";
import { Dialog, DialogClose, DialogContent } from "../../arc/dialog/dialog";
import { EmptyState } from "../../arc/empty-state/empty-state";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../arc/tabs/tabs";
import { registerCommands } from "../../app/commands";
import { Page, Surface } from "../../app/layout/layout";
import { DEVELOPER_TABS, DEVELOPER_TAB_LABELS, paths, type DeveloperTab } from "../../app/navigation";
import { pageRendered } from "../../app/shell/page-transition";
import { DeveloperAppContextValue, type DeveloperAppContext } from "./lib/context";
import { createConfigEditor } from "./lib/editor";
import { APP_STATUS, SOURCE_LABEL } from "./lib/labels";
import { publicUrl, useMeta } from "./lib/meta";
import { AppIcon } from "./parts/AppIcon";
import styles from "./developer.module.css";

const TAB_COMPONENTS: Record<DeveloperTab, Component> = {
  overview: lazy(() => import("./tabs/Overview")),
  "sign-in": lazy(() => import("./tabs/SignInTab")),
  branding: lazy(() => import("./tabs/BrandingTab")),
  users: lazy(() => import("./tabs/UsersTab")),
  import: lazy(() => import("./tabs/ImportTab")),
  webhooks: lazy(() => import("./tabs/WebhooksTab")),
  proofs: lazy(() => import("./tabs/ProofsTab")),
  embed: lazy(() => import("./tabs/EmbedTab")),
};

const TAB_ICONS: Record<DeveloperTab, () => JSX.Element> = {
  overview: () => <LayoutDashboard size={16} stroke-width={1.75} />,
  "sign-in": () => <KeyRound size={16} stroke-width={1.75} />,
  branding: () => <Palette size={16} stroke-width={1.75} />,
  users: () => <Users size={16} stroke-width={1.75} />,
  import: () => <Upload size={16} stroke-width={1.75} />,
  webhooks: () => <Webhook size={16} stroke-width={1.75} />,
  proofs: () => <ShieldCheck size={16} stroke-width={1.75} />,
  embed: () => <Code size={16} stroke-width={1.75} />,
};

const isTab = (value: string | undefined): value is DeveloperTab => DEVELOPER_TABS.includes(value as DeveloperTab);

export default function AppDetail() {
  const params = useParams<{ appId: string; tab?: string }>();
  // A different app is a different page: its own load, its own draft.
  return <Show when={params.appId} keyed>{appId => <AppScope appId={appId} />}</Show>;
}

function AppScope(props: { appId: string }) {
  const meta = useMeta();
  const [app, setApp] = createSignal<AppDetailView>();
  const [error, setError] = createSignal<ApiError>();
  const load = async (): Promise<AppDetailView | undefined> => {
    try {
      const detail = await api.apps.get(props.appId);
      setApp(detail);
      setError(undefined);
      return detail;
    } catch (raw) {
      setError(ApiError.from(raw));
      return undefined;
    }
  };
  void load();

  return (
    <Page width="default">
      <Switch>
        <Match when={app()}>
          {detail => <Loaded appId={props.appId} app={detail} setApp={setApp} reload={load} meta={meta} />}
        </Match>
        <Match when={error()}>{failure => <Problem appId={props.appId} error={failure()} retry={() => void load()} />}</Match>
        <Match when={true}><HeaderSkeleton /></Match>
      </Switch>
    </Page>
  );
}

function HeaderSkeleton() {
  return (
    <div class={styles.loadingHeader} aria-busy="true" aria-label="Loading the app">
      <SkeletonBlock width="96px" height="16px" radius="6px" />
      <div class={styles.loadingIdentity}>
        <SkeletonBlock width="64px" height="64px" radius="18px" index={1} />
        <div style={{ display: "grid", gap: "10px", flex: "1" }}>
          <SkeletonBlock width="min(280px, 70%)" height="40px" radius="12px" index={2} />
          <SkeletonBlock width="min(220px, 50%)" height="16px" radius="6px" index={3} />
        </div>
      </div>
      <SkeletonBlock width="min(640px, 100%)" height="46px" radius="22px" index={4} />
      <SkeletonBlock width="100%" height="240px" radius="var(--radius-surface)" index={5} />
    </div>
  );
}

function Problem(props: { appId: string; error: ApiError; retry: () => void }) {
  const back = <LinkButton href={paths.developer} variant="secondary">Open your apps</LinkButton>;
  return (
    <div class={styles.problem}>
      <A href={paths.developer} class={styles.back}><ArrowLeft size={16} stroke-width={1.75} aria-hidden="true" />Your apps</A>
      <h1 class="sr-only">{props.appId}</h1>
      <Switch fallback={
        <Alert tone="danger" title={`${props.appId} could not be loaded`} action={<Button size="sm" variant="secondary" onClick={() => props.retry()}>Try again</Button>}>
          {props.error.message} {props.error.hint}
        </Alert>
      }>
        <Match when={props.error.status === 404}>
          <Surface padding="none">
            <EmptyState icon={<CircleSlash size={24} stroke-width={1.5} />} title={`No app with the id ${props.appId}`} description={`${props.error.message} Apps live in Silicon Apps; check the id, or open one of your apps.`} action={back} />
          </Surface>
        </Match>
        <Match when={props.error.status === 403}>
          <Surface padding="none">
            <EmptyState icon={<Braces size={24} stroke-width={1.5} />} title={`You don't own ${props.appId}`} description={`${props.error.message} Only the Carbon who owns an app in Silicon Apps manages its sign-in here.`} action={back} />
          </Surface>
        </Match>
      </Switch>
    </div>
  );
}

function TabSkeleton() {
  return (
    <div class={styles.panel} aria-busy="true" aria-label="Loading">
      <SkeletonBlock width="100%" height="140px" radius="var(--radius-surface)" />
      <SkeletonBlock width="100%" height="260px" radius="var(--radius-surface)" index={1} />
    </div>
  );
}

function Loaded(props: { appId: string; app: Accessor<AppDetailView>; setApp: (detail: AppDetailView) => void; reload: () => Promise<AppDetailView | undefined>; meta: Accessor<Meta | undefined> }) {
  const params = useParams<{ appId: string; tab?: string }>();
  const navigate = useNavigate();
  const tab = (): DeveloperTab => (isTab(params.tab) ? params.tab : "overview");
  const openTab = (next: DeveloperTab) => navigate(paths.developerApp(props.appId, next));
  const editor = createConfigEditor({ appId: props.appId, initial: untrack(props.app), onStored: detail => props.setApp(detail) });
  // Another load of the app (a reload after a webhook change, a newer version) keeps every unsaved edit on top.
  createEffect(on(props.app, detail => editor.adopt(detail), { defer: true }));
  const [importJob, setImportJob] = createSignal<string | null>(null);

  const context: DeveloperAppContext = {
    appId: props.appId,
    app: props.app,
    setApp: props.setApp,
    reload: props.reload,
    meta: props.meta,
    publicUrl: () => publicUrl(props.meta()),
    editor,
    openTab,
    importJob,
    setImportJob,
  };

  // Leaving with unsaved changes asks first: inside the app (another tab) the draft stays, outside it would be lost.
  const [leaving, setLeaving] = createSignal<{ retry: () => void } | null>(null);
  const appBase = () => paths.developerApp(props.appId);
  const insideApp = (path: string) => path === appBase() || path.startsWith(`${appBase()}/`);
  useBeforeLeave(event => {
    if (event.defaultPrevented || !editor.anyDirty()) return;
    // Back and Forward arrive as a history delta, after the browser already moved: the address bar holds the target.
    const to = typeof event.to === "number" ? window.location.pathname : (event.to.split(/[?#]/)[0] ?? "");
    if (insideApp(to)) return;
    event.preventDefault();
    // The shell may have started a page transition for this navigation; release it now instead of after its timeout.
    if (typeof event.to === "string") pageRendered(event.to);
    setLeaving({ retry: () => event.retry(true) });
  });
  onMount(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      if (!editor.anyDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    onCleanup(() => window.removeEventListener("beforeunload", onUnload));
  });

  registerCommands(() => DEVELOPER_TABS.map(value => ({
    id: `developer.tab.${value}`,
    label: `${DEVELOPER_TAB_LABELS[value]} of ${props.app().name}`,
    description: `Open the ${DEVELOPER_TAB_LABELS[value]} tab`,
    group: props.app().name,
    icon: TAB_ICONS[value](),
    keywords: [props.appId, value, "developer", "app"],
    run: () => openTab(value),
  })));

  // Correct an unknown tab in the address bar without adding a history entry.
  createEffect(() => {
    if (params.tab !== undefined && !isTab(params.tab)) navigate(paths.developerApp(props.appId), { replace: true });
  });

  const status = () => APP_STATUS[props.app().status] ?? { label: props.app().status, tone: "neutral" as const };
  const dirtyTab = (value: DeveloperTab) => (value === "sign-in" && editor.dirty("signin")) || (value === "branding" && editor.dirty("branding"));

  return (
    <DeveloperAppContextValue.Provider value={context}>
      <header class={styles.header}>
        <A href={paths.developer} class={styles.back}><ArrowLeft size={16} stroke-width={1.75} aria-hidden="true" />Your apps</A>
        <div class={styles.identity}>
          <AppIcon name={props.app().name} src={props.app().logo_url} size={64} />
          <div class={styles.identityText}>
            <h1 class={styles.title}>{props.app().name}</h1>
            <div class={styles.facts}>
              <span class={styles.appId}>{props.app().app_id}<CopyButton value={props.app().app_id} label="Copy app id" iconOnly size="xs" variant="plain" /></span>
              <span class={styles.factDivider} aria-hidden="true" />
              <Badge size="sm" tone={status().tone} dot={props.app().status === "active"}>{status().label}</Badge>
              <span class={styles.factDivider} aria-hidden="true" />
              <span>{SOURCE_LABEL[props.app().source] ?? props.app().source}</span>
            </div>
          </div>
          <div class={styles.headerActions}>
            <Show when={props.app().homepage_url}>
              {href => <LinkButton href={href()} target="_blank" rel="noopener" variant="ghost" size="sm">Homepage<ArrowUpRight size={14} stroke-width={1.75} aria-hidden="true" /></LinkButton>}
            </Show>
          </div>
        </div>
        <Show when={props.app().status === "disabled"}>
          <Alert tone="warning" title={`${props.app().name} is disabled`}>It can't sign anyone in until it is enabled again in Silicon Apps. Its setup can still be changed here.</Alert>
        </Show>
      </header>
      <Tabs value={tab()} onValueChange={next => openTab(next as DeveloperTab)} class={styles.tabs}>
        <TabsList aria-label={`${props.app().name} sections`}>
          <For each={DEVELOPER_TABS}>
            {value => (
              <TabsTrigger value={value}>
                <span class={styles.tabLabel}>
                  {DEVELOPER_TAB_LABELS[value]}
                  <Show when={dirtyTab(value)}><span class={styles.tabDot} role="img" aria-label="unsaved changes" /></Show>
                </span>
              </TabsTrigger>
            )}
          </For>
        </TabsList>
        <For each={DEVELOPER_TABS}>
          {value => {
            const Tab = TAB_COMPONENTS[value];
            return (
              <TabsContent value={value}>
                <Suspense fallback={<TabSkeleton />}><Tab /></Suspense>
              </TabsContent>
            );
          }}
        </For>
      </Tabs>
      <Dialog open={!!leaving()} onOpenChange={open => { if (!open) setLeaving(null); }}>
        <DialogContent
          title="Leave with unsaved changes?"
          description={`Your changes to ${[editor.dirty("signin") ? "Sign-in" : "", editor.dirty("branding") ? "Branding" : ""].filter(Boolean).join(" and ")} of ${props.app().name} are not saved yet.`}
          footer={
            <>
              <DialogClose variant="ghost">Keep editing</DialogClose>
              <Button variant="danger" onClick={() => {
                // Leaving the app unmounts it, and its draft with it; nothing to discard by hand.
                const pending = leaving();
                setLeaving(null);
                pending?.retry();
              }}>Discard and leave</Button>
            </>
          }
        >
          <p style={{ margin: 0 }}>Leaving drops them. Stay to save them first.</p>
        </DialogContent>
      </Dialog>
    </DeveloperAppContextValue.Provider>
  );
}
