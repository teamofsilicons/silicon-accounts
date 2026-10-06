"use client";

/**
 * Users: the app's user base (GET /v1/apps/{app_id}/users), every Carbon and Silicon that signed in or was imported,
 * with the details they share with the app. Search and filters run on the server; sorting runs on the rows loaded.
 * A row opens a drawer with the membership's details and its last 20 sign-ins.
 */
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Users } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { Drawer, DrawerContent } from "@/components/arc/drawer/drawer";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { FilterToolbar, type FilterChip, type FilterField } from "@/components/arc/filter-toolbar/filter-toolbar";
import { SearchField } from "@/components/arc/search-field/search-field";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { SortableDataTable, type DataColumn } from "@/components/arc/sortable-data-table/sortable-data-table";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { DescriptionItem, DescriptionList, Surface } from "@/components/foundation/layout/layout";
import type { AccountKind, AppUser, AppUserStatus, MembershipSource } from "@/lib/api/types";
import { SCOPE_SHORT, formatCount, formatDate, formatDateTime, formatPhone, formatRelative, kindNoun } from "@/lib/format";
import { useAppUser } from "@/lib/query/developer";
import { useDeveloperApp } from "../lib/context";
import { MEMBERSHIP_SOURCE, SIGNIN_METHOD_LABEL, SIGNIN_OUTCOME, userStatus } from "../lib/labels";
import { useUserBase } from "../lib/queries";
import styles from "./users.module.css";

type Row = {
  uuid: string;
  name: string;
  kind: AccountKind;
  status: string;
  contact: string | null;
  source: MembershipSource;
  last: number | null;
  user: AppUser;
};

const STATUS_FILTER: Record<string, AppUserStatus> = { Active: "active", Imported: "imported", "Access removed": "access_removed", Deleted: "deleted" };
const KIND_FILTER: Record<string, AccountKind> = { Carbon: "carbon", Silicon: "silicon" };
const SOURCE_FILTER: Record<string, MembershipSource> = { "Sign-in": "signin", "Silicon token": "slt", Import: "import" };

const FIELDS: FilterField[] = [
  { id: "status", label: "Status", options: Object.keys(STATUS_FILTER) },
  { id: "kind", label: "Kind", options: Object.keys(KIND_FILTER) },
  { id: "source", label: "Source", options: Object.keys(SOURCE_FILTER) },
];

const time = (value: string | null | undefined) => (value ? new Date(value).getTime() : null);

function UserDrawerBody({ appId, appName, user: listed }: { appId: string; appName: string; user: AppUser }) {
  const detail = useAppUser(appId, listed.uuid);
  const user = detail.data ?? listed;
  const status = userStatus(user.status);
  const scopes = (user.granted_scopes ?? []).filter(scope => scope !== "openid" && scope !== "offline_access");
  const imported = user.status === "imported";
  return (
    <div className={styles.drawer}>
      <div className={styles.drawerHero}>
        <Avatar name={user.display_name} src={user.pfp_url} size="xl" />
        <div className={styles.drawerWho}>
          <span className={styles.drawerId}>{user.id ?? "No id (deleted)"}</span>
          <span className={styles.drawerBadges}>
            <Badge size="sm" tone={status.tone}>{status.label}</Badge>
            <Badge size="sm">{kindNoun(user.kind)}</Badge>
          </span>
          {status.description ? <span className={styles.drawerNote}>{status.description}</span> : null}
        </div>
      </div>
      <DescriptionList>
        <DescriptionItem label="uuid"><span className={styles.copyLine}><code className="mono">{user.uuid}</code><CopyButton value={user.uuid} label="Copy uuid" iconOnly variant="plain" /></span></DescriptionItem>
        <DescriptionItem label="Membership"><span className={styles.copyLine}><code className="mono">{user.membership_id}</code><CopyButton value={user.membership_id} label="Copy membership id" iconOnly variant="plain" /></span></DescriptionItem>
        {user.external_id ? <DescriptionItem label="External id"><code className="mono">{user.external_id}</code></DescriptionItem> : null}
        <DescriptionItem label="Joined through">{MEMBERSHIP_SOURCE[user.source] ?? user.source}</DescriptionItem>
        <DescriptionItem label="Shares">
          <span className={styles.scopes}>{scopes.length ? scopes.map(scope => <Badge key={scope} size="sm">{SCOPE_SHORT[scope] ?? scope}</Badge>) : "Name, id and photo"}</span>
        </DescriptionItem>
        {user.email ? <DescriptionItem label={imported ? "Email (imported)" : "Email"}>{user.email}</DescriptionItem> : null}
        {user.phone ? <DescriptionItem label={imported ? "Phone (imported)" : "Phone"}>{formatPhone(user.phone)}</DescriptionItem> : null}
        {user.dob ? <DescriptionItem label="Date of birth">{formatDate(user.dob)}</DescriptionItem> : null}
        {user.timezone ? <DescriptionItem label="Timezone">{user.timezone}</DescriptionItem> : null}
        <DescriptionItem label="First signed in">{user.first_signed_in_at ? formatDateTime(user.first_signed_in_at) : "Not yet"}</DescriptionItem>
        <DescriptionItem label="Last signed in">{user.last_signed_in_at ? `${formatRelative(user.last_signed_in_at)} (${formatDateTime(user.last_signed_in_at)})` : "Not yet"}</DescriptionItem>
        <DescriptionItem label="Member since">{formatDate(user.created_at)}</DescriptionItem>
      </DescriptionList>
      <section className={styles.history} aria-label="Recent sign-ins">
        <h3 className={styles.historyTitle}>Recent sign-ins</h3>
        {detail.error ? (
          <Alert tone="danger" title="The sign-in history could not be loaded">{detail.error.message} {detail.error.hint}</Alert>
        ) : !detail.data ? (
          <Skeleton lines={4} label="Loading sign-ins" />
        ) : detail.data.history.length === 0 ? (
          <p className={styles.paragraph}>No sign-ins to {appName} yet{imported ? ": imported users appear here after their first sign-in." : "."}</p>
        ) : (
          <ol className={styles.signins} role="list">
            {detail.data.history.map((entry, index) => {
              const outcome = SIGNIN_OUTCOME[String(entry.outcome ?? "")] ?? { label: String(entry.outcome ?? "Unknown"), tone: "neutral" as const };
              return (
                <li key={`${entry.at}-${index}`} className={styles.signin}>
                  <span className={styles.signinMethod}>{SIGNIN_METHOD_LABEL[String(entry.method ?? "")] ?? entry.method ?? "Unknown method"}</span>
                  <Badge size="sm" tone={outcome.tone}>{outcome.label}</Badge>
                  <span className={styles.signinWhen} title={formatDateTime(entry.at)}>{formatRelative(entry.at)}</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

export function UsersTab() {
  const ctx = useDeveloperApp();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<FilterChip[]>([]);
  // The drawer keeps showing the last user while it slides out.
  const [selected, setSelected] = useState<AppUser | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openUser = (user: AppUser) => {
    setSelected(user);
    setDrawerOpen(true);
  };
  const filterValue = (id: string) => filters.find(filter => filter.id === id)?.value ?? "";

  // Search waits for a pause in typing; filters apply at once.
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 260);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = {
    q: q || undefined,
    status: STATUS_FILTER[filterValue("status")],
    kind: KIND_FILTER[filterValue("kind")],
    source: SOURCE_FILTER[filterValue("source")],
  };
  const list = useUserBase(ctx.appId, query);
  const users = useMemo(() => list.data?.pages.flatMap(page => page.items) ?? [], [list.data]);
  const rows = useMemo<Row[]>(() => users.map(user => ({
    uuid: user.uuid,
    name: user.display_name,
    kind: user.kind,
    status: user.status,
    contact: user.email ?? (user.phone ? formatPhone(user.phone) : null),
    source: user.source,
    last: time(user.last_signed_in_at),
    user,
  })), [users]);
  const filtered = !!q || filters.length > 0;

  const columns: DataColumn<Row>[] = [
    {
      key: "name",
      label: "Name",
      render: (_, row) => (
        <button type="button" className={styles.person} data-open-user={row.uuid} onClick={() => openUser(row.user)} aria-label={`Open ${row.name}${row.user.id ? ` (${row.user.id})` : ""}`}>
          <Avatar name={row.name} src={row.user.pfp_url} size="sm" aria-hidden="true" />
          <span className={styles.personText}>
            <span className={styles.personName}>{row.name}</span>
            <span className={styles.personId}>{row.user.id ?? "deleted"}</span>
          </span>
        </button>
      ),
    },
    { key: "kind", label: "Kind", render: value => kindNoun(value as AccountKind), width: 96 },
    {
      key: "status",
      label: "Status",
      render: value => {
        const status = userStatus(String(value));
        return <Badge size="sm" tone={status.tone}>{status.label}</Badge>;
      },
      width: 150,
    },
    { key: "contact", label: "Email or phone", render: value => (value ? <span className={styles.contact}>{String(value)}</span> : <span className={styles.muted}>Not shared</span>) },
    { key: "source", label: "Joined through", render: value => MEMBERSHIP_SOURCE[value as MembershipSource] ?? String(value), width: 140 },
    {
      key: "last",
      label: "Last sign-in",
      render: (_, row) => (row.last ? <span title={formatDateTime(row.user.last_signed_in_at)}>{formatRelative(row.user.last_signed_in_at)}</span> : <span className={styles.muted}>Never</span>),
      width: 140,
    },
  ];

  /** A click anywhere on a row opens it, like its name button (links, buttons and selections keep their own clicks). */
  const openRow = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, label") || window.getSelection()?.toString()) return;
    target.closest("tbody tr")?.querySelector<HTMLButtonElement>("[data-open-user]")?.click();
  };

  let body;
  if (list.isPending) {
    body = (
      <Surface padding="none" aria-busy="true" aria-label="Loading users">
        <div className={styles.skeletonRows}>
          {[0, 1, 2, 3, 4].map(index => (
            <div key={index} className={styles.skeletonRow}>
              <SkeletonBlock width="28px" height="28px" radius="9px" index={index} />
              <SkeletonBlock width="38%" height="14px" radius="6px" index={index} />
              <SkeletonBlock width="18%" height="14px" radius="6px" index={index + 1} />
              <SkeletonBlock width="14%" height="14px" radius="6px" index={index + 2} />
            </div>
          ))}
        </div>
      </Surface>
    );
  } else if (!list.error && !rows.length && !filtered) {
    body = (
      <Surface padding="none">
        <EmptyState
          icon={<Users size={24} strokeWidth={1.5} />}
          title="No one has signed in yet"
          description={`Carbons and Silicons who sign in to ${ctx.app.name}, and users you import, appear here with the details they share.`}
          action={
            <div className={styles.emptyActions}>
              <Button onClick={() => ctx.openTab("embed")}>Add sign-in to your app</Button>
              <Button variant="secondary" onClick={() => ctx.openTab("import")}>Import users</Button>
            </div>
          }
        />
      </Surface>
    );
  } else {
    body = (
      <>
        <div className={styles.tableFrame} onClick={openRow} aria-busy={list.isPlaceholderData || undefined}>
          <SortableDataTable
            rows={rows}
            columns={columns}
            rowKey="uuid"
            caption={`Users of ${ctx.app.name}`}
            emptyMessage={filtered ? "No user matches this search and these filters." : "No users yet."}
            defaultSort={{ key: "last", direction: "desc" }}
          />
        </div>
        <div className={styles.footer}>
          <span className={styles.count}>
            {formatCount(rows.length)} {rows.length === 1 ? "user" : "users"} shown{list.hasNextPage ? "; sorting applies to the users loaded so far" : ""}
          </span>
          {list.hasNextPage ? <Button size="sm" variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more users</Button> : null}
        </div>
      </>
    );
  }

  return (
    <div className={styles.users}>
      <div className={styles.toolbar}>
        <SearchField label="Search users" value={search} onValueChange={setSearch} placeholder="Id, name, email, phone or external id" />
        <FilterToolbar
          filters={filters}
          onRemove={id => setFilters(current => current.filter(filter => filter.id !== id))}
          onClearAll={() => setFilters([])}
          addFilter={{ fields: FIELDS, onAdd: chip => setFilters(current => [...current.filter(filter => filter.id !== chip.id), chip]) }}
          label="User filters"
        />
      </div>

      {list.error ? (
        <Alert tone="danger" title="The user base could not be loaded">
          {list.error.message} {list.error.hint}
          <span className={styles.alertActions}><Button size="sm" variant="secondary" onClick={() => void list.refetch()}>Try again</Button></span>
        </Alert>
      ) : null}

      {body}

      <Drawer open={drawerOpen && !!selected} onOpenChange={setDrawerOpen}>
        {selected ? (
          <DrawerContent title={selected.display_name} description={selected.membership_id}>
            <UserDrawerBody appId={ctx.appId} appName={ctx.app.name} user={selected} />
          </DrawerContent>
        ) : null}
      </Drawer>
    </div>
  );
}
