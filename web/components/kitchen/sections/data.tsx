"use client";

import { useState } from "react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Badge } from "@/components/arc/badge/badge";
import { CodeBlock } from "@/components/arc/code-block/code-block";
import { FilterToolbar, type FilterChip, type FilterField } from "@/components/arc/filter-toolbar/filter-toolbar";
import { JsonViewer } from "@/components/arc/json-viewer/json-viewer";
import { SortableDataTable, type DataColumn } from "@/components/arc/sortable-data-table/sortable-data-table";
import { formatRelative } from "@/lib/format";
import { HOUR, portrait, SAMPLE_NOW } from "../samples";
import { Specimen, Specimens, Wide, kitchenStyles as styles } from "../specimen";

type UserRow = { id: string; display_name: string; kind: string; status: string; signins: number; last: number; [key: string]: unknown };

const ROWS: UserRow[] = [
  { id: "c:saket", display_name: "Saket Dev", kind: "Carbon", status: "Active", signins: 128, last: SAMPLE_NOW - 2 * 60_000 },
  { id: "si:scout", display_name: "Scout", kind: "Silicon", status: "Active", signins: 2041, last: SAMPLE_NOW - 3 * HOUR },
  { id: "c:mira", display_name: "Mira Chen", kind: "Carbon", status: "Imported", signins: 0, last: 0 },
  { id: "si:head_of_growth", display_name: "Head of Growth", kind: "Silicon", status: "Active", signins: 377, last: SAMPLE_NOW - 26 * HOUR },
  { id: "c:shubham", display_name: "Shubham", kind: "Carbon", status: "Access removed", signins: 42, last: SAMPLE_NOW - 400 * HOUR },
];

const COLUMNS: DataColumn<UserRow>[] = [
  { key: "display_name", label: "Name", render: (_, row) => <span className={styles.cellName}><Avatar name={row.display_name} src={row.signins ? portrait(row.display_name, (row.signins * 7) % 360) : undefined} size="sm" />{row.display_name}</span> },
  { key: "id", label: "Id", render: value => <span className={styles.mono}>{String(value)}</span> },
  { key: "status", label: "Status", render: value => <Badge size="sm" tone={value === "Active" ? "success" : value === "Imported" ? "neutral" : "warning"}>{String(value)}</Badge> },
  { key: "signins", label: "Sign-ins", numeric: true },
  { key: "last", label: "Last sign-in", render: value => (value ? formatRelative(Number(value), SAMPLE_NOW) : "Never") },
];

const FIELDS: FilterField[] = [
  { id: "status", label: "Status", options: [{ value: "Active", hint: 3 }, { value: "Imported", hint: 1 }, { value: "Access removed", hint: 1 }] },
  { id: "kind", label: "Kind", options: ["Carbon", "Silicon"] },
  { id: "source", label: "Source", options: ["Sign-in", "Short-lived token", "Import"] },
];

const PAYLOAD = {
  event_id: "0192a6f0-0000-7000-8000-0000000000e1",
  type: "account.id_changed",
  occurred_at: "2026-10-06T09:40:12.000Z",
  app_id: "briefcase",
  silicon: null,
  data: { uuid: "a8K", membership_id: "briefcase:a8K", kind: "carbon", old_id: "c:saketdev", new_id: "c:saket" },
};

export function Data() {
  const [filters, setFilters] = useState<FilterChip[]>([{ id: "status", label: "Status", value: "Active" }]);
  return (
    <Wide>
      <Specimen title="FilterToolbar and SortableDataTable (an app's users)">
        <FilterToolbar
          filters={filters}
          onRemove={id => setFilters(list => list.filter(filter => filter.id !== id))}
          onClearAll={() => setFilters([])}
          addFilter={{ fields: FIELDS, onAdd: chip => setFilters(list => [...list.filter(filter => filter.id !== chip.id), chip]) }}
        />
        <SortableDataTable rows={ROWS} columns={COLUMNS} rowKey="id" caption="Users of Briefcase" selectable itemName={{ one: "user", other: "users" }} defaultSort={{ key: "last", direction: "desc" }} />
      </Specimen>
      <Specimens>
        <Specimen title="CodeBlock (snippets)">
          <CodeBlock filename="Sign-in link" language="html" code={`<a href="https://account.teamofsilicons.com/authorize?app_id=briefcase&redirect_uri=https%3A%2F%2Fbriefcase.example%2Fcallback&state=…">\n  Sign in with Silicon Accounts\n</a>`} />
          <CodeBlock filename="Verify a proof" language="bash" code={`curl -u briefcase:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -d '{"proof_token":"sap_…"}' \\\n  https://account.teamofsilicons.com/v1/proofs/verify`} />
        </Specimen>
        <Specimen title="JsonViewer (webhook payload)">
          <JsonViewer data={PAYLOAD} rootName="event" defaultExpandDepth={2} maxHeight={300} label="Webhook payload" />
        </Specimen>
      </Specimens>
    </Wide>
  );
}
