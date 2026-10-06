/**
 * /developer: the apps this Carbon owns, as a grid of app icons. Each opens the app's sign-in setup. New apps are
 * created in Silicon Apps (ACCOUNTS_SILICON_APPS_URL from /v1/meta); as soon as one exists there it can sign people in
 * and shows up here.
 */
import { A, useNavigate } from "@solidjs/router";
import { ArrowRight, ArrowUpRight, Braces, Plus, Users } from "lucide-solid";
import { For, Match, Show, Switch } from "solid-js";
import { api, collectPages, createApiResource, type OwnedApp } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { Badge } from "../../arc/badge/badge";
import { Button, LinkButton } from "../../arc/button/button";
import { EmptyState } from "../../arc/empty-state/empty-state";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { useSquircle } from "../../arc/lib/squircle";
import { pressable } from "../../arc/lib/motion";
import { registerCommands } from "../../app/commands";
import { Page, PageHeader, Surface } from "../../app/layout/layout";
import { paths } from "../../app/navigation";
import { signedInAccount } from "../../app/session";
import { formatCount } from "../../lib/format";
import { APP_STATUS, SOURCE_LABEL } from "./lib/labels";
import { siliconAppsUrl, useMeta } from "./lib/meta";
import { AppIcon } from "./parts/AppIcon";
import styles from "./developer.module.css";

function AppTile(props: { app: OwnedApp }) {
  return (
    <A
      href={paths.developerApp(props.app.app_id)}
      ref={el => { useSquircle(el); pressable(el); }}
      class={styles.tile}
      aria-label={`${props.app.name} (${props.app.app_id}), ${formatCount(props.app.users)} ${props.app.users === 1 ? "user" : "users"}`}
      data-status={props.app.status}
    >
      <span class={styles.tileTop}>
        <AppIcon name={props.app.name} src={props.app.logo_url} size={56} />
        <Show when={props.app.status !== "active"}><Badge size="sm" tone={APP_STATUS[props.app.status]?.tone ?? "neutral"}>{APP_STATUS[props.app.status]?.label ?? props.app.status}</Badge></Show>
      </span>
      <span class={styles.tileText}>
        <span class={styles.tileName}>{props.app.name}</span>
        <span class={styles.tileId}>{props.app.app_id}</span>
      </span>
      <span class={styles.tileFoot}>
        <span class={styles.tileStat}><Users size={14} stroke-width={1.75} aria-hidden="true" />{formatCount(props.app.users)} {props.app.users === 1 ? "user" : "users"}</span>
        <span class={styles.tileSource}>{SOURCE_LABEL[props.app.source] ?? props.app.source}</span>
        <ArrowRight class={styles.tileArrow} size={16} stroke-width={1.75} aria-hidden="true" />
      </span>
    </A>
  );
}

function NewAppTile(props: { href: string }) {
  return (
    <a href={props.href} target="_blank" rel="noopener" ref={el => { useSquircle(el); pressable(el); }} class={styles.newTile}>
      <span class={styles.newMark} aria-hidden="true"><Plus size={20} stroke-width={1.75} /></span>
      <span class={styles.tileText}>
        <span class={styles.tileName}>New app</span>
        <span class={styles.newText}>Apps are created in Silicon Apps. One can sign people in as soon as it exists there, and its sign-in setup appears here.</span>
      </span>
      <span class={styles.newLink}>Open Silicon Apps<ArrowUpRight size={14} stroke-width={1.75} aria-hidden="true" /></span>
    </a>
  );
}

function TileSkeletons() {
  return (
    <div class={styles.grid} aria-busy="true" aria-label="Loading your apps">
      <For each={[0, 1, 2]}>
        {index => (
          <div ref={el => useSquircle(el)} class={styles.tileSkeleton}>
            <SkeletonBlock width="56px" height="56px" radius="16px" index={index} />
            <SkeletonBlock width="60%" height="20px" radius="8px" index={index + 1} />
            <SkeletonBlock width="40%" height="14px" radius="6px" index={index + 2} />
            <SkeletonBlock width="100%" height="16px" radius="6px" index={index + 3} />
          </div>
        )}
      </For>
    </div>
  );
}

export default function Developer() {
  const meta = useMeta();
  const navigate = useNavigate();
  const isSilicon = () => signedInAccount()?.kind === "silicon";
  const [apps, { refetch }] = createApiResource(() => (isSilicon() ? Promise.resolve([] as OwnedApp[]) : collectPages(query => api.me.ownedApps(query))));
  const newAppUrl = () => siliconAppsUrl(meta());

  registerCommands(() => [
    { id: "developer.new-app", label: "Create an app in Silicon Apps", description: "Opens Silicon Apps in a new tab", group: "Developer", icon: <Plus size={16} stroke-width={1.75} />, keywords: ["new", "app", "create"], run: () => void window.open(newAppUrl(), "_blank", "noopener") },
    ...(apps.error ? [] : apps() ?? []).map(app => ({
      id: `developer.app.${app.app_id}`,
      label: `Open ${app.name}`,
      description: `Sign-in setup of ${app.app_id}`,
      group: "Your apps",
      icon: <Braces size={16} stroke-width={1.75} />,
      keywords: [app.app_id, "app", "developer"],
      run: () => navigate(paths.developerApp(app.app_id)),
    })),
  ]);

  return (
    <Page width="default">
      <PageHeader
        title="Your apps"
        description="Apps you own and how they sign Carbons and Silicons in."
        actions={<Show when={!isSilicon()}><LinkButton href={newAppUrl()} target="_blank" rel="noopener" variant="secondary">New app<ArrowUpRight size={16} stroke-width={1.75} aria-hidden="true" /></LinkButton></Show>}
      />
      <Switch>
        <Match when={isSilicon()}>
          <Surface padding="none">
            <EmptyState
              icon={<Braces size={24} stroke-width={1.5} />}
              title="Apps are owned by Carbons"
              description="Silicons sign in to apps but never own them. The Carbon who created an app in Silicon Apps manages its sign-in here."
            />
          </Surface>
        </Match>
        <Match when={apps.error}>
          {error => (
            <Alert tone="danger" title="Your apps could not be loaded" action={<Button size="sm" variant="secondary" onClick={() => void refetch()}>Try again</Button>}>
              {error().message} {error().hint}
            </Alert>
          )}
        </Match>
        <Match when={apps.loading && !apps.latest}><TileSkeletons /></Match>
        <Match when={apps()?.length === 0}>
          <Surface padding="none">
            <EmptyState
              icon={<Braces size={24} stroke-width={1.5} />}
              title="No apps yet"
              description="Apps you create in Silicon Apps appear here, with their sign-in setup, users, webhooks and proofs."
              action={<LinkButton href={newAppUrl()} target="_blank" rel="noopener">Create an app in Silicon Apps<ArrowUpRight size={16} stroke-width={1.75} aria-hidden="true" /></LinkButton>}
            />
          </Surface>
        </Match>
        <Match when={apps()}>
          {list => (
            <div class={styles.grid}>
              <For each={list()}>{app => <AppTile app={app} />}</For>
              <NewAppTile href={newAppUrl()} />
            </div>
          )}
        </Match>
      </Switch>
    </Page>
  );
}
