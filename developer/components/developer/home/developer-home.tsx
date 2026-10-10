"use client";

/** One app registry, with Accounts configuration and Apps publishing in the same workspace. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Braces, Plus, Users } from "lucide-react";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import { EmptyState } from "@/components/silicon-ui/empty-state/empty-state";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader, Surface } from "@/components/foundation/layout/layout";
import type { OwnedApp } from "@/lib/api/types";
import { useRegisterCommands } from "@/lib/commands";
import { formatCount } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useOwnedApps } from "@/lib/query/developer";
import { useResource } from "@/components/publishing/api";
import type { App as PublishingApp } from "@/components/publishing/types";
import { CreateApp } from "@/components/publishing/CreateApp";
import { SOURCE_LABEL, appStatus } from "../lib/labels";
import { AppIcon } from "../parts/app-icon";
import styles from "./developer-home.module.css";

const usersLabel = (count: number) => `${formatCount(count)} ${count === 1 ? "user" : "users"}`;

function AppTile({ app, publishing }: { app: OwnedApp; publishing?: PublishingApp }) {
  const status = appStatus(app.status);
  const source = SOURCE_LABEL[app.source] ?? app.source;
  // The link's name is what the tile shows, in the order it shows it, with pauses (WCAG 2.5.3). The {" "} between the
  // parts keep the tile's own text in words too; the grid and flex boxes ignore them in layout.
  const name = [app.status !== "active" ? status.label : null, app.name, app.app_id, usersLabel(app.users), source].filter(Boolean).join(", ");
  return (
    <Link href={paths.developerApp(app.app_id, publishing && !publishing.published ? "publishing" : undefined)} data-sq="surface" className={styles.tile} data-status={app.status} aria-label={name}>
      <span className={styles.tileTop}>
        <AppIcon name={app.name} src={app.logo_url} size={56} decorative />
        {app.status !== "active" ? <Badge size="sm" tone={status.tone}>{status.label}</Badge> : null}
      </span>{" "}
      <span className={styles.tileText}>
        <span className={styles.tileName}>{app.name}</span>{" "}
        <span className={styles.tileId}>{app.app_id}</span>
      </span>{" "}
      <span className={styles.tileFoot}>
        <span className={styles.tileStat}><Users size={14} strokeWidth={1.75} aria-hidden="true" />{usersLabel(app.users)}</span>{" "}
        <span className={styles.tileSource}>{publishing && !publishing.published ? "Continue setup" : source}</span>
        <ArrowRight className={styles.tileArrow} size={16} strokeWidth={1.75} aria-hidden="true" />
      </span>
    </Link>
  );
}

function NewAppTile({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" data-sq="surface" className={styles.newTile} onClick={onOpen}>
      <span className={styles.newMark} aria-hidden="true"><Plus size={20} strokeWidth={1.75} /></span>
      <span className={styles.tileText}>
        <span className={styles.tileName}>New app</span>{" "}
        <span className={styles.newText}>Create an app, configure sign-in, and publish its first release.</span>
      </span>{" "}
      <span className={styles.newLink}>Create an app<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></span>
    </button>
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
  const owned = useOwnedApps();
  const publishing = useResource<{items: PublishingApp[]}>("/apps?mine=true&limit=100");
  const [newApp, setNewApp] = useState(false);
  const apps = owned.data?.items;

  useRegisterCommands(() => [
    ...[{
      id: "developer.new-app",
      label: "New app",
      description: "Create an app for Accounts and Apps",
      group: "Apps",
      icon: <Plus size={16} strokeWidth={1.75} />,
      keywords: ["new", "app", "create"],
      run: () => setNewApp(true),
    }],
    ...(apps ?? []).map(app => ({
      id: `developer.app.${app.app_id}`,
      label: `Open ${app.name}`,
      description: `Sign-in setup of ${app.app_id}`,
      group: "Your apps",
      icon: <Braces size={16} strokeWidth={1.75} />,
      keywords: [app.app_id, "app", "developer"],
      run: () => router.push(paths.developerApp(app.app_id)),
    })),
  ], [apps, router]);

  let content;
  if (owned.error && !apps) {
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
          description="Create your first app to configure Accounts sign-in and publish packages through Apps."
          action={<Button onClick={() => setNewApp(true)}>Create an app</Button>}
        />
      </Surface>
    );
  } else {
    content = (
      <ul className={styles.grid} role="list" aria-label="Your apps">
        {apps.map(app => <li key={app.app_id}><AppTile app={app} publishing={publishing.data?.items.find(item => item.app_id === app.app_id)} /></li>)}
        <li><NewAppTile onOpen={() => setNewApp(true)} /></li>
      </ul>
    );
  }

  // Publishing details come from Silicon Apps. When it can't answer (or refuses the sign-in), the apps from Silicon
  // Accounts still show, and this says why their publishing state is missing.
  const publishingError = publishing.error as (Error & { hint?: string }) | undefined;

  return (
    <Page width="default">
      <PageHeader
        title="Your apps"
        description="Manage sign-in with Silicon Accounts and publish with Silicon Apps."
        actions={<Button variant="secondary" onClick={() => setNewApp(true)}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />New app</Button>}
      />
      {publishingError ? (
        <Alert tone="warning" title="Publishing details could not be loaded" className={styles.notice}>
          {publishingError.message}{publishingError.hint ? ` ${publishingError.hint}` : ""}
          <span className={styles.alertActions}><Button size="sm" variant="secondary" onClick={publishing.reload}>Try again</Button></span>
        </Alert>
      ) : null}
      {content}
      <CreateApp open={newApp} close={() => { setNewApp(false); void owned.refetch(); }} />
    </Page>
  );
}
