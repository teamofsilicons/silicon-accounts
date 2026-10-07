"use client";

/**
 * /: the apps this Carbon owns, as a grid of app icons; each opens the app's sign-in setup. Apps are created in Silicon
 * Apps (UNDERSTANDING "Apps"), which isn't built yet: until it is, a few stand-in apps run inside Silicon Accounts with
 * fixed app ids and secrets, behaving exactly like real apps and keeping their ids and users when Silicon Apps ships.
 * "New app" explains that, and lists the stand-in apps this Carbon owns.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, ArrowUpRight, Braces, Plus, Users } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
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
  const source = SOURCE_LABEL[app.source] ?? app.source;
  // The link's name is what the tile shows, in the order it shows it, with pauses (WCAG 2.5.3). The {" "} between the
  // parts keep the tile's own text in words too; the grid and flex boxes ignore them in layout.
  const name = [app.status !== "active" ? status.label : null, app.name, app.app_id, usersLabel(app.users), source].filter(Boolean).join(", ");
  return (
    <Link href={paths.developerApp(app.app_id)} data-sq="surface" className={styles.tile} data-status={app.status} aria-label={name}>
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
        <span className={styles.tileSource}>{source}</span>
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
        <span className={styles.newText}>Apps are created in Silicon Apps. Once an app exists, its sign-in is set up here.</span>
      </span>{" "}
      <span className={styles.newLink}>How apps are made<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></span>
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

/** "New app": where apps come from, and the stand-in apps that exist until Silicon Apps does. */
function NewAppDialog({ open, onOpenChange, apps, siliconAppsUrl }: { open: boolean; onOpenChange: (open: boolean) => void; apps: OwnedApp[]; siliconAppsUrl: string }) {
  const standIns = apps.filter(app => app.source === "fake");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialog} title="Apps come from Silicon Apps" description="Silicon Apps is where every app is created; as soon as an app exists there, it can sign people in with Silicon Accounts, and its sign-in is set up here.">
        <div className={styles.dialogBody}>
          <p>
            Silicon Apps isn&apos;t open yet. Until it is, a few stand-in apps run inside Silicon Accounts, each with a fixed
            app id and secret. They behave exactly like real apps, and when Silicon Apps ships they become real apps,
            keeping their app ids and their users.
          </p>
          {standIns.length ? (
            <>
              <p className={styles.dialogLabel}>{standIns.length === 1 ? "Your stand-in app" : "Your stand-in apps"}</p>
              <ul className={styles.standIns} role="list">
                {standIns.map(app => (
                  <li key={app.app_id}>
                    <Link href={paths.developerApp(app.app_id)} className={styles.standIn} onClick={() => onOpenChange(false)}>
                      <AppIcon name={app.name} src={app.logo_url} size={32} decorative />
                      <span className={styles.standInText}><span>{app.name}</span><code>{app.app_id}</code></span>
                      <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>You don&apos;t own a stand-in app. Stand-in apps are assigned to their owners by the Silicon Accounts team; ask them for one, or wait for Silicon Apps.</p>
          )}
          <div className={styles.dialogActions}>
            <ButtonLink href={siliconAppsUrl} external target="_blank" rel="noopener" variant="secondary">Silicon Apps<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" /></ButtonLink>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DeveloperHome() {
  const router = useRouter();
  const { me } = useSession();
  const meta = useMeta();
  const owned = useOwnedApps();
  const [newApp, setNewApp] = useState(false);
  const isSilicon = me?.kind === "silicon";
  const siliconAppsUrl = siliconAppsUrlOf(meta.data);
  const apps = owned.data?.items;
  const standIns = apps?.filter(app => app.source === "fake").length ?? 0;

  useRegisterCommands(() => [
    ...(isSilicon ? [] : [{
      id: "developer.new-app",
      label: "New app",
      description: "How apps are made (Silicon Apps)",
      group: "Apps",
      icon: <Plus size={16} strokeWidth={1.75} />,
      keywords: ["new", "app", "create"],
      run: () => setNewApp(true),
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
  ], [isSilicon, apps, router]);

  let content;
  if (isSilicon) {
    content = (
      <Surface padding="none">
        <EmptyState
          icon={<Braces size={24} strokeWidth={1.5} />}
          title="Apps are owned by Carbons"
          description="Silicons sign in to apps but never own them. The Carbon who owns an app sets up its sign-in here."
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
          description="Apps you own appear here, with their sign-in setup, users, webhooks and ATA proofs. Apps are created in Silicon Apps."
          action={<Button onClick={() => setNewApp(true)}>How apps are made</Button>}
        />
      </Surface>
    );
  } else {
    content = (
      <ul className={styles.grid} role="list" aria-label="Your apps">
        {apps.map(app => <li key={app.app_id}><AppTile app={app} /></li>)}
        <li><NewAppTile onOpen={() => setNewApp(true)} /></li>
      </ul>
    );
  }

  return (
    <Page width="default">
      <PageHeader
        title="Your apps"
        description="Apps you own, and how they sign Carbons and Silicons in with Silicon Accounts."
        actions={isSilicon ? undefined : <Button variant="secondary" onClick={() => setNewApp(true)}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />New app</Button>}
      />
      {standIns ? (
        <Alert tone="info" title="Silicon Apps isn't open yet">
          {standIns === apps?.length ? "These are stand-in apps" : `${standIns} of these are stand-in apps`}: they run inside Silicon Accounts with fixed app ids and secrets, and keep both, with their users, when Silicon Apps ships.
        </Alert>
      ) : null}
      {content}
      <NewAppDialog open={newApp} onOpenChange={setNewApp} apps={apps ?? []} siliconAppsUrl={siliconAppsUrl} />
    </Page>
  );
}
