"use client";

/**
 * /developer: the apps this Carbon owns, as a grid of app icons; each opens the app's sign-in setup. New apps are
 * created in Silicon Apps (ACCOUNTS_SILICON_APPS_URL, from /v1/meta); as soon as one exists there it can sign people
 * in and shows up here.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUpRight, Braces, Plus, Users } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { ButtonLink } from "@/components/foundation/button-link";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader, Surface } from "@/components/foundation/layout/layout";
import type { OwnedApp } from "@/lib/api/types";
import { useRegisterCommands } from "@/lib/commands";
import { formatCount } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useOwnedApps } from "@/lib/query/developer";
import { useMeta, useSession } from "@/lib/query/session";
import { siliconAppsUrlOf } from "../lib/context";
import { SOURCE_LABEL, appStatus } from "../lib/labels";
import { AppIcon } from "../parts/app-icon";
import styles from "./developer-home.module.css";

const usersLabel = (count: number) => `${formatCount(count)} ${count === 1 ? "user" : "users"}`;

function AppTile({ app }: { app: OwnedApp }) {
  const status = appStatus(app.status);
  return (
    <Link
      href={paths.developerApp(app.app_id)}
      data-sq="surface"
      className={styles.tile}
      data-status={app.status}
      aria-label={`${app.name} (${app.app_id}), ${usersLabel(app.users)}${app.status !== "active" ? `, ${status.label.toLowerCase()}` : ""}`}
    >
      <span className={styles.tileTop}>
        <AppIcon name={app.name} src={app.logo_url} size={56} decorative />
        {app.status !== "active" ? <Badge size="sm" tone={status.tone}>{status.label}</Badge> : null}
      </span>
      <span className={styles.tileText}>
        <span className={styles.tileName}>{app.name}</span>
        <span className={styles.tileId}>{app.app_id}</span>
      </span>
      <span className={styles.tileFoot}>
        <span className={styles.tileStat}><Users size={14} strokeWidth={1.75} aria-hidden="true" />{usersLabel(app.users)}</span>
        <span className={styles.tileSource}>{SOURCE_LABEL[app.source] ?? app.source}</span>
        <ArrowRight className={styles.tileArrow} size={16} strokeWidth={1.75} aria-hidden="true" />
      </span>
    </Link>
  );
}

function NewAppTile({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener" data-sq="surface" className={styles.newTile}>
      <span className={styles.newMark} aria-hidden="true"><Plus size={20} strokeWidth={1.75} /></span>
      <span className={styles.tileText}>
        <span className={styles.tileName}>New app</span>
        <span className={styles.newText}>Apps are created in Silicon Apps. One can sign people in as soon as it exists there, and its sign-in setup appears here.</span>
      </span>
      <span className={styles.newLink}>Open Silicon Apps<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" /></span>
    </a>
  );
}

function TileSkeletons() {
  return (
    <div className={styles.grid} aria-busy="true" aria-label="Loading your apps">
      {[0, 1, 2].map(index => (
        <div key={index} data-sq="surface" className={styles.tileSkeleton}>
          <SkeletonBlock width="56px" height="56px" radius="16px" index={index} />
          <SkeletonBlock width="60%" height="20px" radius="8px" index={index + 1} />
          <SkeletonBlock width="40%" height="14px" radius="6px" index={index + 2} />
          <SkeletonBlock width="100%" height="16px" radius="6px" index={index + 3} />
        </div>
      ))}
    </div>
  );
}

export function DeveloperHome() {
  const router = useRouter();
  const { session } = useSession();
  const meta = useMeta();
  const owned = useOwnedApps();
  const isSilicon = session?.account.kind === "silicon";
  const newAppUrl = siliconAppsUrlOf(meta.data);
  const apps = owned.data?.items;

  useRegisterCommands(() => [
    ...(isSilicon ? [] : [{
      id: "developer.new-app",
      label: "Create an app in Silicon Apps",
      description: "Opens Silicon Apps in a new tab",
      group: "Developer",
      icon: <Plus size={16} strokeWidth={1.75} />,
      keywords: ["new", "app", "create"],
      run: () => void window.open(newAppUrl, "_blank", "noopener"),
    }]),
    ...(apps ?? []).map(app => ({
      id: `developer.app.${app.app_id}`,
      label: `Open ${app.name}`,
      description: `Sign-in setup of ${app.app_id}`,
      group: "Your apps",
      icon: <Braces size={16} strokeWidth={1.75} />,
      keywords: [app.app_id, "app", "developer"],
      run: () => router.push(paths.developerApp(app.app_id)),
    })),
  ], [isSilicon, newAppUrl, apps, router]);

  let content;
  if (isSilicon) {
    content = (
      <Surface padding="none">
        <EmptyState
          icon={<Braces size={24} strokeWidth={1.5} />}
          title="Apps are owned by Carbons"
          description="Silicons sign in to apps but never own them. The Carbon who created an app in Silicon Apps manages its sign-in here."
        />
      </Surface>
    );
  } else if (owned.error && !apps) {
    content = (
      <Alert tone="danger" title="Your apps could not be loaded">
        {owned.error.message} {owned.error.hint}
        <span className={styles.alertActions}><Button size="sm" variant="secondary" onClick={() => void owned.refetch()}>Try again</Button></span>
      </Alert>
    );
  } else if (!apps) {
    content = <TileSkeletons />;
  } else if (!apps.length) {
    content = (
      <Surface padding="none">
        <EmptyState
          icon={<Braces size={24} strokeWidth={1.5} />}
          title="No apps yet"
          description="Apps you create in Silicon Apps appear here, with their sign-in setup, users, webhooks and proofs."
          action={<ButtonLink href={newAppUrl} external target="_blank" rel="noopener">Create an app in Silicon Apps<ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" /></ButtonLink>}
        />
      </Surface>
    );
  } else {
    content = (
      <ul className={styles.grid} role="list" aria-label="Your apps">
        {apps.map(app => <li key={app.app_id}><AppTile app={app} /></li>)}
        <li><NewAppTile href={newAppUrl} /></li>
      </ul>
    );
  }

  return (
    <Page width="default">
      <PageHeader
        title="Your apps"
        description="Apps you own and how they sign Carbons and Silicons in."
        actions={isSilicon ? undefined : <ButtonLink href={newAppUrl} external target="_blank" rel="noopener" variant="secondary">New app<ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" /></ButtonLink>}
      />
      {content}
    </Page>
  );
}
