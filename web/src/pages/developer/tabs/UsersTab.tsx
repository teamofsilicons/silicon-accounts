/**
 * Users: the app's user base (GET /v1/apps/{app_id}/users), every Carbon and Silicon that signed in or was imported,
 * with the details they share with the app. Search and filters run on the server; sorting runs on the rows loaded.
 * A row opens a drawer with the membership's details and its last 20 sign-ins.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { Users } from "lucide-solid";
import { api, createPagedList, type AccountKind, type AppUser, type AppUserDetail, type MembershipSource, type MembershipStatus, type Scope } from "../../../api";
import { Alert } from "../../../arc/alert/alert";
import { Avatar } from "../../../arc/avatar/avatar";
import { Badge } from "../../../arc/badge/badge";
import { Button } from "../../../arc/button/button";
import { CopyButton } from "../../../arc/copy-button/copy-button";
import { Drawer, DrawerContent } from "../../../arc/drawer/drawer";
import { EmptyState } from "../../../arc/empty-state/empty-state";
import { FilterToolbar, type FilterChip, type FilterField } from "../../../arc/filter-toolbar/filter-toolbar";
import { SearchField } from "../../../arc/search-field/search-field";
import { Skeleton, SkeletonBlock } from "../../../arc/skeleton/skeleton";
import { SortableDataTable, type DataColumn } from "../../../arc/sortable-data-table/sortable-data-table";
import { DescriptionItem, DescriptionList, Surface } from "../../../app/layout/layout";
import { SCOPE_SHORT, formatCount, formatDate, formatDateTime, formatPhone, formatRelative, kindNoun } from "../../../lib/format";
import { useDeveloperApp } from "../lib/context";
import { MEMBERSHIP_SOURCE, SIGNIN_METHOD_LABEL, SIGNIN_OUTCOME, USER_STATUS } from "../lib/labels";
import styles from "./users.module.css";

type Row = {
  uuid: string;
  name: string;
  id: string | null;
  kind: AccountKind;
  status: string;
  contact: string | null;
  source: MembershipSource;
  last: number | null;
  first: number | null;
  user: AppUser;
};

const STATUS_FILTER: Record<string, string> = { Active: "active", Imported: "imported", "Access removed": "access_removed", Deleted: "deleted" };
const KIND_FILTER: Record<string, AccountKind> = { Carbon: "carbon", Silicon: "silicon" };
const SOURCE_FILTER: Record<string, MembershipSource> = { "Sign-in": "signin", "Silicon token": "slt", Import: "import" };

const FIELDS: FilterField[] = [
  { id: "status", label: "Status", options: Object.keys(STATUS_FILTER) },
  { id: "kind", label: "Kind", options: Object.keys(KIND_FILTER) },
  { id: "source", label: "Source", options: Object.keys(SOURCE_FILTER) },
];

const time = (value: string | null | undefined) => (value ? new Date(value).getTime() : null);

function UserDrawerBody(props: { appId: string; user: AppUser }) {
  const [detail, setDetail] = createSignal<AppUserDetail>();
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.user.uuid, uuid => {
    setDetail(undefined);
    setError(null);
    let cancelled = false;
    api.apps.user(props.appId, uuid).then(value => { if (!cancelled) setDetail(value); }).catch(raw => {
      if (!cancelled) setError(raw instanceof Error ? raw.message : String(raw));
    });
    onCleanup(() => { cancelled = true; });
  }));
  const user = () => detail() ?? props.user;
  const status = () => USER_STATUS[user().status] ?? { label: user().status, tone: "neutral" as const, description: "" };
  const scopes = () => (user().granted_scopes ?? []).filter((scope: Scope) => scope !== "openid" && scope !== "offline_access");
  return (
    <div class={styles.drawer}>
      <div class={styles.drawerHero}>
        <Avatar name={user().display_name} src={user().pfp_url} kind={user().kind} size="xl" />
        <div class={styles.drawerWho}>
          <span class={styles.drawerId}>{user().id ?? "No id (deleted)"}</span>
          <span class={styles.drawerBadges}>
            <Badge size="sm" tone={status().tone} dot={user().status === "active"}>{status().label}</Badge>
            <Badge size="sm">{kindNoun(user().kind)}</Badge>
          </span>
          <span class={styles.drawerNote}>{status().description}</span>
        </div>
      </div>
      <DescriptionList>
        <DescriptionItem label="uuid"><span class={styles.copyLine}><code class="mono">{user().uuid}</code><CopyButton value={user().uuid} label="Copy uuid" iconOnly size="xs" variant="plain" /></span></DescriptionItem>
        <DescriptionItem label="Membership"><span class={styles.copyLine}><code class="mono">{user().membership_id}</code><CopyButton value={user().membership_id} label="Copy membership id" iconOnly size="xs" variant="plain" /></span></DescriptionItem>
        <Show when={user().external_id}>{external => <DescriptionItem label="External id"><code class="mono">{external()}</code></DescriptionItem>}</Show>
        <DescriptionItem label="Joined through">{MEMBERSHIP_SOURCE[user().source] ?? user().source}</DescriptionItem>
        <DescriptionItem label="Shares">
          <span class={styles.scopes}><For each={scopes()}>{scope => <Badge size="sm">{SCOPE_SHORT[scope] ?? scope}</Badge>}</For></span>
        </DescriptionItem>
        <Show when={user().email}>{email => <DescriptionItem label={user().status === "imported" ? "Email (imported)" : "Email"}>{email()}</DescriptionItem>}</Show>
        <Show when={user().phone}>{phone => <DescriptionItem label={user().status === "imported" ? "Phone (imported)" : "Phone"}>{formatPhone(phone())}</DescriptionItem>}</Show>
        <Show when={user().dob}>{dob => <DescriptionItem label="Date of birth">{formatDate(dob())}</DescriptionItem>}</Show>
        <Show when={user().timezone}>{zone => <DescriptionItem label="Timezone">{zone()}</DescriptionItem>}</Show>
        <DescriptionItem label="First signed in">{user().first_signed_in_at ? formatDateTime(user().first_signed_in_at) : "Not yet"}</DescriptionItem>
        <DescriptionItem label="Last signed in">{user().last_signed_in_at ? `${formatRelative(user().last_signed_in_at)} (${formatDateTime(user().last_signed_in_at)})` : "Not yet"}</DescriptionItem>
        <DescriptionItem label="Member since">{formatDate(user().created_at)}</DescriptionItem>
      </DescriptionList>
      <section class={styles.history} aria-label="Recent sign-ins">
        <h3 class={styles.historyTitle}>Recent sign-ins</h3>
        <Switch>
          <Match when={error()}>{message => <Alert tone="danger" title="The sign-in history could not be loaded">{message()}</Alert>}</Match>
          <Match when={!detail()}><Skeleton lines={4} label="Loading sign-ins" /></Match>
          <Match when={detail()?.history.length === 0}><p class={styles.muted}>No sign-ins to {props.appId} yet{user().status === "imported" ? ": imported users appear here after their first sign-in." : "."}</p></Match>
          <Match when={detail()}>
            {value => (
              <ol class={styles.signins} role="list">
                <For each={value().history}>
                  {entry => {
                    const outcome = () => SIGNIN_OUTCOME[String(entry.outcome ?? "")] ?? { label: String(entry.outcome ?? "Unknown"), tone: "neutral" as const };
                    return (
                      <li class={styles.signin}>
                        <span class={styles.signinMethod}>{SIGNIN_METHOD_LABEL[String(entry.method ?? "")] ?? entry.method ?? "Unknown method"}</span>
                        <Badge size="sm" tone={outcome().tone}>{outcome().label}</Badge>
                        <span class={styles.signinWhen} title={formatDateTime(entry.at)}>{formatRelative(entry.at)}</span>
                      </li>
                    );
                  }}
                </For>
              </ol>
            )}
          </Match>
        </Switch>
      </section>
    </div>
  );
}

export default function UsersTab() {
  const ctx = useDeveloperApp();
  const [search, setSearch] = createSignal("");
  const [filters, setFilters] = createSignal<FilterChip[]>([]);
  const [selected, setSelected] = createSignal<AppUser | null>(null);
  const filterValue = (id: string) => filters().find(filter => filter.id === id)?.value;

  const list = createPagedList(query => api.apps.users(ctx.appId, {
    ...query,
    q: search().trim() || undefined,
    status: (STATUS_FILTER[filterValue("status") ?? ""] as MembershipStatus | undefined) ?? undefined,
    kind: KIND_FILTER[filterValue("kind") ?? ""],
    source: SOURCE_FILTER[filterValue("source") ?? ""],
  }), { limit: 50, immediate: false });

  // Search waits for a pause in typing; filters apply at once.
  let timer = 0;
  createEffect(on(search, () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void list.reset(), 260);
  }, { defer: true }));
  createEffect(on(() => filters().map(filter => `${filter.id}:${filter.value}`).join("|"), () => void list.reset()));
  onCleanup(() => window.clearTimeout(timer));

  const rows = createMemo<Row[]>(() => list.items().map(user => ({
    uuid: user.uuid,
    name: user.display_name,
    id: user.id,
    kind: user.kind,
    status: user.status,
    contact: user.email ?? (user.phone ? formatPhone(user.phone) : null),
    source: user.source,
    last: time(user.last_signed_in_at),
    first: time(user.first_signed_in_at),
    user,
  })));
  const filtered = () => !!search().trim() || filters().length > 0;

  const columns: DataColumn<Row>[] = [
    {
      key: "name",
      label: "Name",
      render: (_, row) => (
        <span class={styles.person}>
          <Avatar name={row.name} src={row.user.pfp_url} kind={row.kind} size="sm" />
          <span class={styles.personText}>
            <span class={styles.personName}>{row.name}</span>
            <span class={styles.personId}>{row.id ?? "deleted"}</span>
          </span>
        </span>
      ),
    },
    { key: "kind", label: "Kind", render: value => kindNoun(value as AccountKind), width: 96 },
    {
      key: "status",
      label: "Status",
      render: value => {
        const status = USER_STATUS[String(value)] ?? { label: String(value), tone: "neutral" as const };
        return <Badge size="sm" tone={status.tone} dot={value === "active"}>{status.label}</Badge>;
      },
      width: 150,
    },
    { key: "contact", label: "Email or phone", render: value => (value ? <span class={styles.contact}>{String(value)}</span> : <span class={styles.muted}>Not shared</span>) },
    { key: "source", label: "Joined through", render: value => MEMBERSHIP_SOURCE[value as MembershipSource] ?? String(value), width: 140 },
    { key: "last", label: "Last sign-in", render: (_, row) => (row.last ? <span title={formatDateTime(row.user.last_signed_in_at)}>{formatRelative(row.last)}</span> : <span class={styles.muted}>Never</span>), sortValue: row => row.last, width: 140 },
  ];

  return (
    <div class={styles.users}>
      <div class={styles.toolbar}>
        <SearchField label="Search users" hideLabel value={search()} onValueChange={setSearch} placeholder="Search by id, name, email, phone or external id" class={styles.search} />
        <FilterToolbar
          filters={filters()}
          onRemove={id => setFilters(list => list.filter(filter => filter.id !== id))}
          onClearAll={() => setFilters([])}
          addFilter={{ fields: FIELDS, onAdd: chip => setFilters(list => [...list.filter(filter => filter.id !== chip.id), chip]) }}
          label="User filters"
        />
      </div>

      <Show when={list.error()}>
        {error => <Alert tone="danger" title="The user base could not be loaded" action={<Button size="sm" variant="secondary" onClick={() => void list.reset()}>Try again</Button>}>{error().message} {error().hint}</Alert>}
      </Show>

      <Switch>
        <Match when={list.loading() && !list.items().length}>
          <Surface padding="none" aria-busy="true" aria-label="Loading users">
            <div class={styles.skeletonRows}>
              <For each={[0, 1, 2, 3, 4]}>{index => <div class={styles.skeletonRow}><SkeletonBlock width="28px" height="28px" radius="9px" index={index} /><SkeletonBlock width="38%" height="14px" radius="6px" index={index} /><SkeletonBlock width="18%" height="14px" radius="6px" index={index + 1} /><SkeletonBlock width="14%" height="14px" radius="6px" index={index + 2} /></div>}</For>
            </div>
          </Surface>
        </Match>
        <Match when={!list.error() && !list.items().length && !filtered()}>
          <Surface padding="none">
            <EmptyState
              icon={<Users size={24} stroke-width={1.5} />}
              title="No one has signed in yet"
              description={`Carbons and Silicons who sign in to ${ctx.app().name}, and users you import, appear here with the details they share.`}
              action={<div class={styles.emptyActions}><Button onClick={() => ctx.openTab("embed")}>Add sign-in to your app</Button><Button variant="secondary" onClick={() => ctx.openTab("import")}>Import users</Button></div>}
            />
          </Surface>
        </Match>
        <Match when={true}>
          <SortableDataTable
            rows={rows()}
            columns={columns}
            rowKey="uuid"
            caption={`Users of ${ctx.app().name}`}
            emptyMessage={filtered() ? "No user matches this search and these filters." : "No users yet."}
            defaultSort={{ key: "last", direction: "desc" }}
            onRowActivate={row => setSelected(row.user)}
            class={styles.table}
          />
          <div class={styles.footer}>
            <span class={styles.count}>
              {formatCount(rows().length)} {rows().length === 1 ? "user" : "users"} shown{list.hasMore() ? "; sorting applies to the users loaded so far" : ""}
            </span>
            <Show when={list.hasMore()}><Button size="sm" variant="secondary" loading={list.loadingMore()} onClick={() => void list.loadMore()}>Load more</Button></Show>
          </div>
        </Match>
      </Switch>

      <Drawer open={!!selected()} onOpenChange={open => { if (!open) setSelected(null); }}>
        <Show when={selected()}>
          {user => (
            <DrawerContent title={user().display_name} description={user().membership_id}>
              <UserDrawerBody appId={ctx.appId} user={user()} />
            </DrawerContent>
          )}
        </Show>
      </Drawer>
    </div>
  );
}
