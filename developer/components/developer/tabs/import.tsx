"use client";

/**
 * Import: bring an app's existing users. A stepper walks through it: upload or paste a CSV or JSON file, check its
 * columns in the browser (columns Silicon Accounts doesn't keep are named before anything is sent), choose the options,
 * run a dry run or the import, watch it progress, and read the report row by row. Each imported user is matched to the
 * account that already has their email or phone; otherwise a Carbon account is created that they finish on their first
 * sign-in.
 *
 * "Import for real" after a dry run repeats exactly that dry run: the same file (still loaded) with the options it ran
 * with; a report opened from Recent imports never offers it (a review finding on the SolidJS build: it imported
 * whatever file was loaded, with the current toggles).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, CircleAlert, CircleX, ClipboardPaste, Download, FileUp, Info, TriangleAlert, X } from "lucide-react";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { AnimatedCounter } from "@/components/silicon-ui/animated-counter/animated-counter";
import { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import { Combobox } from "@/components/silicon-ui/combobox/combobox";
import { Drawer, DrawerContent } from "@/components/silicon-ui/drawer/drawer";
import { FileDropzone } from "@/components/silicon-ui/file-dropzone/file-dropzone";
import { JsonViewer } from "@/components/silicon-ui/json-viewer/json-viewer";
import { PHONE_COUNTRIES, flagOf } from "@/components/silicon-ui/phone-input/phone-input";
import { Progress } from "@/components/silicon-ui/progress/progress";
import SegmentedControl from "@/components/silicon-ui/segmented-control/segmented-control";
import { Skeleton } from "@/components/silicon-ui/skeleton/skeleton";
import { Stepper } from "@/components/silicon-ui/stepper/stepper";
import { Switch } from "@/components/silicon-ui/switch/switch";
import { Textarea } from "@/components/silicon-ui/textarea/textarea";
import { SettingsGroup, SettingsRow, Surface } from "@/components/foundation/layout/layout";
import { api } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import type { ImportJob, ImportOptions, ImportOutcome, ImportRow, ImportRowResult } from "@/lib/api/types";
import { formatCount, formatRelative, plural } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { useIdempotencyKey } from "@/lib/query/idempotency";
import { useImports } from "@/lib/query/developer";
import { queryKeys } from "@/lib/query/keys";
import { useDeveloperApp } from "../lib/context";
import { COLUMN_HELP, parseFile, parseText, templateCsv, type ParsedImport } from "../lib/importfile";
import { importOutcome } from "../lib/labels";
import { retryableFailure, useImportJob, useImportRowList } from "../lib/queries";
import styles from "./import.module.css";

const STEPS = [
  { id: "upload", label: "Upload", description: "CSV or JSON" },
  { id: "check", label: "Check columns" },
  { id: "options", label: "Options" },
  { id: "run", label: "Run" },
  { id: "report", label: "Report" },
];

type RowFilter = "all" | "error" | "warning" | "skipped" | "created" | "matched" | "updated";
const ROW_FILTERS: Array<{ value: RowFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "error", label: "Errors" },
  { value: "warning", label: "Warnings" },
  { value: "skipped", label: "Skipped" },
  { value: "created", label: "Created" },
  { value: "matched", label: "Matched" },
  { value: "updated", label: "Updated" },
];

const COUNTRY_OPTIONS = [
  { value: "none", label: "None: numbers include their country code", keywords: ["none", "international"] },
  ...PHONE_COUNTRIES.map(country => ({ value: country.iso, label: `${flagOf(country.iso)} ${country.name} (+${country.dial})`, keywords: [country.iso.toLowerCase(), country.name.toLowerCase(), country.dial] })),
];

const isDone = (job: ImportJob | undefined) => job?.status === "completed" || job?.status === "failed";
const dryRunOf = (job: ImportJob) => !!(job.options?.dry_run ?? job.dry_run);
const sizeLabel = (bytes: number) => (bytes < 1024 ? plural(bytes, "byte") : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Each file read gets its own id: a dry run checks that very file, and a retry of its upload reuses its key. */
const fileIds = new WeakMap<ParsedImport, number>();
let lastFileId = 0;
function fileId(file: ParsedImport): number {
  let id = fileIds.get(file);
  if (id === undefined) {
    id = ++lastFileId;
    fileIds.set(file, id);
  }
  return id;
}

interface StartInput {
  file: ParsedImport;
  options: ImportOptions;
}

function CountsStrip({ job }: { job: ImportJob }) {
  const items = [
    { label: "Created", value: job.counts.created },
    { label: "Matched", value: job.counts.matched },
    { label: "Updated", value: job.counts.updated },
    { label: "Skipped", value: job.counts.skipped },
    { label: "Errors", value: job.counts.error },
    { label: "Warnings", value: job.counts.warnings },
  ];
  return (
    <dl className={styles.strip}>
      {items.map(item => (
        <div key={item.label} className={styles.stripItem}>
          <dt>{item.label}</dt>
          <dd><AnimatedCounter value={item.value} /></dd>
        </div>
      ))}
    </dl>
  );
}

function MessageIcon({ level }: { level: string }) {
  if (level === "error") return <CircleX size={16} strokeWidth={1.75} />;
  if (level === "warning") return <TriangleAlert size={16} strokeWidth={1.75} />;
  return <Info size={16} strokeWidth={1.75} />;
}

function RowDetail({ row }: { row: ImportRowResult }) {
  return (
    <div className={styles.rowDetail}>
      <div className={styles.rowMessages}>
        {row.messages.length ? row.messages.map((message, index) => (
          <div key={`${message.code}-${index}`} className={styles.message} data-level={message.level}>
            <span className={styles.messageIcon} aria-hidden="true"><MessageIcon level={message.level} /></span>
            <span className={styles.messageText}>
              <span><code className={styles.code}>{message.code}</code>{message.field ? <span className={styles.messageField}> in {message.field}</span> : null}</span>
              <span className={styles.messageBody}>{message.message}</span>
            </span>
          </div>
        )) : <p className={styles.muted}>No messages: the row went through cleanly.</p>}
      </div>
      <JsonViewer data={row.input} rootName="input" defaultExpandDepth={2} maxHeight={260} label={`Input of row ${row.row_number}`} searchable={false} />
    </div>
  );
}

function Report({ appId, job, onImportForReal, onNew }: { appId: string; job: ImportJob; onImportForReal?: () => void; onNew: () => void }) {
  const [filter, setFilter] = useState<RowFilter>("all");
  const [code, setCode] = useState<string | null>(null);
  const [opened, setOpened] = useState<ImportRowResult | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const outcome = filter === "all" || filter === "warning" ? undefined : (filter as ImportOutcome);
  const list = useImportRowList(appId, job.id, { outcome, level: filter === "warning" ? "warning" : undefined, code: code ?? undefined });
  const rows = useMemo(() => list.data?.pages.flatMap(page => page.items) ?? [], [list.data]);
  const dry = dryRunOf(job);
  const failed = job.status === "failed";
  const counts = job.counts;
  const written = counts.created + counts.matched + counts.updated;
  const summary = failed
    ? `The import stopped after ${formatCount(job.processed_rows)} of ${plural(job.total_rows, "row")}.`
    : dry
      ? `Nothing was written. ${plural(written, "row")} would go through, ${plural(counts.error, "row")} would fail and ${formatCount(counts.skipped)} would be skipped.`
      : `${plural(counts.created, "account")} created, ${formatCount(counts.matched)} matched to existing accounts, ${formatCount(counts.updated)} updated; ${plural(counts.error, "row")} failed and ${formatCount(counts.skipped)} ${counts.skipped === 1 ? "was" : "were"} skipped.`;
  const openRow = (row: ImportRowResult) => {
    setOpened(row);
    setDrawerOpen(true);
  };
  const filterLabel = ROW_FILTERS.find(entry => entry.value === filter)?.label.toLowerCase();

  return (
    <div className={styles.report}>
      <Alert tone={failed ? "danger" : dry ? "info" : counts.error ? "warning" : "success"} title={failed ? "The import failed" : dry ? "Dry run finished" : "Import finished"}>
        <span className={styles.alertLine}>{summary}</span>
        {job.error ? <span className={styles.alertLine}>{job.error}</span> : null}
        {dry && !onImportForReal ? <span className={styles.alertLine}>To import it for real, upload the file again: this report is not the file loaded now.</span> : null}
        <span className={styles.alertActions}>
          {dry && onImportForReal ? <Button size="sm" onClick={onImportForReal}>Import for real</Button> : null}
          <Button size="sm" variant="secondary" onClick={onNew}>Start another import</Button>
        </span>
      </Alert>
      <dl data-sq="surface" className={styles.totals}>
        {[
          { label: "Created", value: counts.created, context: "New Carbon accounts; finished on first sign-in" },
          { label: "Matched", value: counts.matched, context: "Existing accounts, now members" },
          { label: "Updated", value: counts.updated, context: "Imported details refreshed" },
          { label: "Skipped", value: counts.skipped, context: "Repeats of an earlier row" },
          { label: "Errors", value: counts.error, context: "Rows not imported" },
          { label: "Warnings", value: counts.warnings, context: "Imported, with a note" },
        ].map(item => (
          <div key={item.label} className={styles.total}>
            <dt>{item.label}</dt>
            <dd><span className={styles.totalValue}>{formatCount(item.value)}</span><span className={styles.totalContext}>{item.context}</span></dd>
          </div>
        ))}
      </dl>
      <section className={styles.rowsSection} aria-label="Rows">
        <div className={styles.rowsHead}>
          <h3 className={styles.rowsTitle}>Rows</h3>
          <div className={styles.rowFilters}>
            <SegmentedControl label="Show rows" value={filter} onValueChange={value => setFilter(value as RowFilter)} options={ROW_FILTERS} />
            {code ? (
              <span data-sq="surface" className={styles.codeChip}>
                Only <code className={styles.code}>{code}</code>
                <button type="button" data-sq="surface" aria-label={`Show rows with any message, not only ${code}`} onClick={() => setCode(null)}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
              </span>
            ) : null}
          </div>
        </div>
        {list.error ? (
          <Alert tone="danger" title="The rows could not be loaded">
            {list.error.message} {list.error.hint}
            <span className={styles.alertActions}><Button size="sm" variant="secondary" onClick={() => void list.refetch()}>Try again</Button></span>
          </Alert>
        ) : null}
        {list.isPending ? <Skeleton lines={5} label="Loading rows" /> : (
          <>
            <div data-sq="surface" className={styles.rowsTable} aria-busy={list.isPlaceholderData || undefined}>
              {rows.length ? (
                <table className={styles.table}>
                  <caption className="sr-only">Rows of the import</caption>
                  <thead><tr><th scope="col">Row</th><th scope="col">Outcome</th><th scope="col">Account</th><th scope="col">Messages</th></tr></thead>
                  <tbody>
                    {rows.map(row => {
                      const result = importOutcome(row.outcome);
                      return (
                        <tr key={row.row_number}>
                          <td className={styles.num}><button type="button" className={styles.rowOpen} onClick={() => openRow(row)} aria-label={`Open row ${row.row_number}`}>{row.row_number}</button></td>
                          <td><Badge size="sm" tone={result.tone}>{result.label}</Badge></td>
                          <td className={`${styles.mono} ${styles.accountCell}`}>{row.id ?? (dry && row.outcome === "matched" ? "hidden in a dry run" : "No account")}</td>
                          <td>
                            {row.messages.length ? (
                              <ul className={styles.cellMessages} role="list">
                                {row.messages.slice(0, 2).map((message, index) => (
                                  <li key={`${message.code}-${index}`} data-level={message.level}>
                                    <button type="button" className={styles.codeButton} onClick={() => setCode(message.code)} aria-label={`Show only rows with ${message.code}`}><code className={styles.code}>{message.code}</code></button> {message.message}
                                  </li>
                                ))}
                                {row.messages.length > 2 ? <li className={styles.muted}>and {row.messages.length - 2} more</li> : null}
                              </ul>
                            ) : <span className={styles.muted}>None</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className={styles.rowsEmpty}>{filter === "all" && !code ? "This import has no rows." : `No ${filter === "all" ? "rows" : filterLabel}${code ? ` with ${code}` : ""} in this import.`}</p>
              )}
            </div>
            {list.hasNextPage ? <Button size="sm" variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more rows</Button> : null}
          </>
        )}
      </section>
      <Drawer open={drawerOpen && !!opened} onOpenChange={setDrawerOpen}>
        {opened ? (
          <DrawerContent title={`Row ${opened.row_number}`} description={`${importOutcome(opened.outcome).label}${opened.id ? ` · ${opened.id}` : ""}`} className={styles.wideDrawer}>
            <RowDetail row={opened} />
          </DrawerContent>
        ) : null}
      </Drawer>
    </div>
  );
}

function RecentImports({ appId, onOpen }: { appId: string; onOpen: (job: ImportJob) => void }) {
  const imports = useImports(appId);
  const jobs = imports.data?.items.slice(0, 10) ?? [];
  return (
    <section className={styles.recent} aria-label="Recent imports">
      <h3 className={styles.rowsTitle}>Recent imports</h3>
      {imports.error ? <Alert tone="danger" title="Recent imports could not be loaded">{imports.error.message} {imports.error.hint}</Alert> : null}
      {imports.isPending ? <Skeleton lines={3} label="Loading recent imports" /> : jobs.length ? (
        <ul className={styles.recentList} role="list">
          {jobs.map(job => (
            <li key={job.id}>
              <button type="button" data-sq="surface" className={styles.recentItem} onClick={() => onOpen(job)}>
                <span className={styles.recentWhen}>{formatRelative(job.created_at)}<span className={styles.muted}> · {job.format.toUpperCase()} · {plural(job.total_rows, "row")}</span></span>
                <span className={styles.recentCounts}>{formatCount(job.counts.created)} created · {formatCount(job.counts.matched)} matched · {plural(job.counts.error, "error")}</span>
                <span className={styles.recentBadges}>
                  {dryRunOf(job) ? <Badge size="sm" tone="info">Dry run</Badge> : null}
                  <Badge size="sm" tone={job.status === "completed" ? "success" : job.status === "failed" ? "danger" : "neutral"}>{job.status === "completed" ? "Finished" : job.status === "failed" ? "Failed" : job.status === "running" ? "Running" : "Queued"}</Badge>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : !imports.error ? <p className={styles.muted}>No imports yet. The first one shows up here, with its report.</p> : null}
    </section>
  );
}

export function ImportTab() {
  const ctx = useDeveloperApp();
  const client = useQueryClient();
  const { appId, importJob, setImportJob, reload } = ctx;
  const [wizardStep, setWizardStep] = useState(0);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [reading, setReading] = useState(false);
  const [paste, setPaste] = useState(false);
  const [pasted, setPasted] = useState("");
  const [country, setCountry] = useState("none");
  const [ignoreUnknown, setIgnoreUnknown] = useState(false);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [dropzoneKey, setDropzoneKey] = useState(0);
  // The dry run of the file loaded now, with the options it ran with: the only run "Import for real" may repeat.
  const [checked, setChecked] = useState<{ jobId: string; file: ParsedImport; options: ImportOptions } | null>(null);
  const stepRegion = useRef<HTMLDivElement>(null);

  const followed = useImportJob(appId, importJob);
  const job = followed.data && followed.data.id === importJob ? followed.data : undefined;
  const step = importJob ? (job && isDone(job) ? 4 : 3) : wizardStep;
  const pollError = followed.error ? ApiError.from(followed.error) : null;

  // A real import that finished while followed here changes the app's numbers: read them again. Any finished run (a dry
  // run too) refreshes Recent imports in the background, so "Start another import" shows it at once, with its outcome.
  const watching = useRef<string | null>(null);
  useEffect(() => {
    if (!job) return;
    if (!isDone(job)) watching.current = job.id;
    else if (watching.current === job.id) {
      watching.current = null;
      void client.invalidateQueries({ queryKey: queryKeys.app.imports(appId), exact: true, refetchType: "all" });
      if (!dryRunOf(job)) void reload();
    }
  }, [job, reload, client, appId]);

  // Each step replaces the last; keyboard and screen reader focus moves to the new step instead of falling to the page.
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    const region = stepRegion.current;
    const active = document.activeElement;
    if (!region || (active && active !== document.body && !region.contains(active))) return;
    region.focus({ preventScroll: true });
  }, [step]);

  // A retry of the same upload (same file read, same options) reuses its key, so it never starts a second job. The key
  // follows the file's identity, not its bytes: signing a 50 MB file on every press would stall the page.
  const keys = useIdempotencyKey();
  const start = useMutation({
    mutationFn: ({ file, options }: StartInput) => {
      const idempotencyKey = keys.for({ file: fileId(file), options });
      return file.format === "json"
        ? api.apps.imports.startRows(appId, (file.jsonRows ?? []) as ImportRow[], options, { idempotencyKey })
        : api.apps.imports.startCsv(appId, file.csv ?? "", options, { idempotencyKey });
    },
    onSuccess: () => keys.reset(),
    meta: { toast: false },
  });

  const read = async (load: () => Promise<ParsedImport>) => {
    setReading(true);
    try {
      const result = await load();
      setParsed(result);
      setChecked(null);
      setIgnoreUnknown(false);
      start.reset();
      setWizardStep(1);
    } catch (error) {
      notifyError(error, "The file could not be read");
    } finally {
      setReading(false);
    }
  };

  const reset = () => {
    setParsed(null);
    setChecked(null);
    setPasted("");
    setPaste(false);
    start.reset();
    setImportJob(null);
    setWizardStep(0);
    setDropzoneKey(key => key + 1);
  };

  /** An earlier run from Recent imports: its report only. The file loaded now (if any) is not what it checked. */
  const openRecent = (value: ImportJob) => {
    setParsed(null);
    setChecked(null);
    setPasted("");
    setPaste(false);
    start.reset();
    client.setQueryData(queryKeys.app.import(appId, value.id), value);
    setImportJob(value.id);
  };

  const options = (dry: boolean): ImportOptions => ({
    default_country: country === "none" ? undefined : country,
    ignore_unknown_columns: ignoreUnknown,
    dry_run: dry,
    update_existing: updateExisting,
  });

  /** Starts a job for `file` with `opts`. The same file and options keep one Idempotency-Key until it starts. */
  const submit = async (file: ParsedImport, opts: ImportOptions) => {
    if (start.isPending) return;
    try {
      const created = await start.mutateAsync({ file, options: opts });
      setChecked(opts.dry_run ? { jobId: created.id, file, options: opts } : null);
      client.setQueryData(queryKeys.app.import(appId, created.id), created);
      void client.invalidateQueries({ queryKey: queryKeys.app.imports(appId) });
      setImportJob(created.id);
    } catch (raw) {
      if (ApiError.from(raw).code === "unknown_columns") setWizardStep(1);
    }
  };

  const importForReal = job && checked && checked.jobId === job.id && checked.file === parsed && parsed
    ? () => {
      const run = checked;
      setImportJob(null);
      setWizardStep(2);
      void submit(run.file, { ...run.options, dry_run: false });
    }
    : undefined;

  const blocked = (parsed?.problems.length ?? 0) > 0;
  const needsAck = (parsed?.unknown.length ?? 0) > 0 && !ignoreUnknown;
  const submitError = start.error;
  const submitting = start.isPending ? (start.variables?.options.dry_run ? "dry" : "real") : null;

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([templateCsv()], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${appId}-users-template.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const progress = job && job.total_rows ? Math.round((job.processed_rows / job.total_rows) * 100) : 0;
  const errorAlert = (title: string, error: ApiError, extra?: ReactNode) => (
    <Alert tone="danger" title={title}>
      {error.message} {error.hint}{error.retryAfter ? ` You can try again in ${error.retryAfter} s.` : ""}
      {extra}
    </Alert>
  );

  let content: ReactNode = null;
  if (step === 0) {
    content = (
      <>
        {parsed ? (
          <Surface className={styles.fileSummary}>
            <FileUp size={20} strokeWidth={1.75} aria-hidden="true" className={styles.fileIcon} />
            <div className={styles.fileText}>
              <strong>{parsed.source} is loaded</strong>
              <span>{parsed.format.toUpperCase()} · {plural(parsed.rows, "row")}. Choose another file below to replace it.</span>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setWizardStep(1)}>Continue with it</Button>
          </Surface>
        ) : null}
        <div className={styles.upload}>
          <div className={styles.uploadMain}>
            {paste ? (
              <div className={styles.pasteBox}>
                <Textarea
                  label="Paste CSV or JSON"
                  className={styles.mono}
                  rows={10}
                  placeholder={"email,display_name,username\nada@example.com,Ada Okafor,ada"}
                  value={pasted}
                  onChange={event => setPasted(event.currentTarget.value)}
                  description="CSV needs a header row. JSON is an array of objects, or {&quot;rows&quot;: [...]}."
                />
                <div className={styles.actions}>
                  <Button variant="ghost" onClick={() => setPaste(false)}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />Upload a file instead</Button>
                  <Button disabled={!pasted.trim()} loading={reading} onClick={() => void read(async () => parseText(pasted))}>Check columns</Button>
                </div>
              </div>
            ) : (
              <>
                <div className={styles.dropzoneFrame}>
                  <FileDropzone
                    key={dropzoneKey}
                    label="Drop a CSV or JSON file"
                    description="Or choose one from your device. Up to 100,000 rows and 50 MB."
                    accept=".csv,.json,text/csv,application/json"
                    multiple={false}
                    maxFiles={1}
                    maxSize={50 * 1024 * 1024}
                    note="Only the columns listed here are kept."
                    onFilesChange={files => {
                      const file = files[0];
                      if (file) void read(() => parseFile(file));
                    }}
                  />
                </div>
                <div className={styles.actions}>
                  <Button variant="secondary" onClick={() => setPaste(true)}><ClipboardPaste size={16} strokeWidth={1.75} aria-hidden="true" />Paste instead</Button>
                  <Button variant="ghost" onClick={downloadTemplate}><Download size={16} strokeWidth={1.75} aria-hidden="true" />Download a CSV template</Button>
                </div>
              </>
            )}
          </div>
          <aside data-sq="surface" className={styles.columnsHelp} aria-label="Columns an import can have">
            <h3 className={styles.helpTitle}>The only columns an import keeps</h3>
            <p className={styles.helpText}>An app&apos;s user base has the columns Silicon Accounts gives. Each row needs an email or phone.</p>
            <dl className={styles.columnList}>
              {Object.entries(COLUMN_HELP).map(([column, help]) => <div key={column}><dt><code>{column}</code></dt><dd>{help}</dd></div>)}
            </dl>
            <p className={styles.helpText}>Creating accounts by import never sends an email or SMS.</p>
          </aside>
        </div>
        <RecentImports appId={appId} onOpen={openRecent} />
      </>
    );
  } else if (step === 1 && parsed) {
    const kept = parsed.columns.filter(column => column.canonical && (column.status === "ok" || column.status === "alias"));
    content = (
      <div className={styles.check}>
        <Surface className={styles.fileSummary}>
          <FileUp size={20} strokeWidth={1.75} aria-hidden="true" className={styles.fileIcon} />
          <div className={styles.fileText}>
            <strong>{parsed.source}</strong>
            <span>{parsed.format.toUpperCase()} · {plural(parsed.rows, "row")} · {plural(parsed.columns.length, "column")} · {sizeLabel(parsed.bytes)}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={reset}>Choose another file</Button>
        </Surface>
        {submitError ? errorAlert("Silicon Accounts refused the file", submitError) : null}
        {parsed.problems.length ? (
          <Alert tone="danger" title={parsed.problems.length === 1 ? "This file can't be imported yet" : `${parsed.problems.length} things stop this import`}>
            <span className={styles.problems}>{parsed.problems.map(problem => <span key={problem}>{problem}</span>)}</span>
          </Alert>
        ) : null}
        {!parsed.problems.length && parsed.unknown.length ? (
          <Alert tone="warning" title={`${plural(parsed.unknown.length, "column")} Silicon Accounts doesn't keep`}>
            <span className={styles.alertLine}>{parsed.unknown.join(", ")}. An app&apos;s user base only has the columns Silicon Accounts gives, so these values are never stored.</span>
            <span className={styles.alertLine}>{ignoreUnknown ? "They will be ignored; each row with a value in them gets a warning." : "Remove or rename them, or ignore them: the rest of each row is imported and the row gets a warning."}</span>
            <span className={styles.alertActions}>
              {ignoreUnknown
                ? <Button size="sm" variant="secondary" onClick={() => setIgnoreUnknown(false)}>Stop ignoring them</Button>
                : <Button size="sm" onClick={() => setIgnoreUnknown(true)}>Ignore them and continue</Button>}
            </span>
          </Alert>
        ) : null}
        <section className={styles.columnsSection} aria-label="Columns">
          <h3 className={styles.rowsTitle}>Columns</h3>
          <ul className={styles.columnChips} role="list">
            {parsed.columns.map((column, index) => (
              <li key={`${column.name}-${index}`} data-sq="surface" className={styles.columnChip} data-status={column.status}>
                <span className={styles.columnIcon} aria-hidden="true">
                  {column.status === "ok" || column.status === "alias" ? <Check size={14} strokeWidth={2} /> : column.status === "unnamed" ? <CircleAlert size={14} strokeWidth={1.75} /> : <CircleX size={14} strokeWidth={1.75} />}
                </span>
                <code>{column.name}</code>
                {column.status === "alias" ? <span className={styles.columnNote}>as display_name</span> : null}
                {column.status === "unknown" ? <span className={styles.columnNote}>not kept</span> : null}
                {column.status === "duplicate" ? <span className={styles.columnNote}>twice</span> : null}
                {column.status === "unnamed" ? <span className={styles.columnNote}>no name</span> : null}
              </li>
            ))}
          </ul>
        </section>
        {parsed.sample.length ? (
          <section className={styles.columnsSection} aria-label="First rows">
            <h3 className={styles.rowsTitle}>First rows, as they will be read</h3>
            <div data-sq="surface" className={styles.rowsTable}>
              <table className={styles.table}>
                <caption className="sr-only">The first rows of the file</caption>
                <thead><tr>{kept.map(column => <th key={column.canonical} scope="col">{column.canonical}</th>)}</tr></thead>
                <tbody>
                  {parsed.sample.map((row, index) => (
                    <tr key={index}>{kept.map(column => <td key={column.canonical} className={styles.mono}>{row[column.canonical ?? ""] || <span className={styles.muted}>empty</span>}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
        <div className={styles.actions}>
          <Button variant="ghost" onClick={reset}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />Back</Button>
          <Button disabled={blocked || needsAck} onClick={() => setWizardStep(2)}>Continue to options</Button>
        </div>
        {!blocked && needsAck ? <p className={styles.hintRight}>Decide about the columns Silicon Accounts doesn&apos;t keep first.</p> : null}
      </div>
    );
  } else if (step === 2 && parsed) {
    content = (
      <div className={styles.options}>
        <Combobox label="Default country for phone numbers" description="Used for numbers written without a country code, like (202) 555-0142." options={COUNTRY_OPTIONS} value={country} onValueChange={value => setCountry(value || "none")} placeholder="Search a country" />
        <SettingsGroup label="Import options">
          <SettingsRow label="Update existing members" description="For rows that match an account already in this app, refresh the imported details and external id. The account's own data is never changed.">
            {ids => <Switch aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} checked={updateExisting} onCheckedChange={setUpdateExisting} />}
          </SettingsRow>
          {parsed.unknown.length ? (
            <SettingsRow label="Ignore columns Silicon Accounts doesn't keep" description={`${parsed.unknown.join(", ")}: never stored; each affected row gets a warning.`}>
              {ids => <Switch aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} checked={ignoreUnknown} onCheckedChange={setIgnoreUnknown} />}
            </SettingsRow>
          ) : null}
        </SettingsGroup>
        <Surface className={styles.howItWorks}>
          <p>Each row is matched to the account that already has one of its emails or phone numbers and joins {ctx.app.name}&apos;s user base. With no match, a Carbon account is created; it is finished the first time they sign in with one of those emails or numbers.</p>
          <p>A dry run checks every row and writes nothing. Nobody gets an email or SMS either way.</p>
        </Surface>
        {submitError ? errorAlert("The import did not start", submitError, <span className={styles.alertActions}><Button size="sm" variant="secondary" onClick={() => start.reset()}>Dismiss</Button></span>) : null}
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => setWizardStep(1)}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />Back</Button>
          <span className={styles.grow} />
          <Button variant="secondary" loading={submitting === "dry"} disabled={!!submitting} onClick={() => void submit(parsed, options(true))}>Do a dry run</Button>
          <Button loading={submitting === "real"} disabled={!!submitting} onClick={() => void submit(parsed, options(false))}>{`Import ${plural(parsed.rows, "row")}`}</Button>
        </div>
      </div>
    );
  } else if (step === 3) {
    const final = pollError ? !retryableFailure(pollError) : false;
    content = (
      <Surface className={styles.run}>
        {job ? (
          <>
            <div className={styles.runHead}>
              <strong>{dryRunOf(job) ? "Dry run in progress" : `Importing ${plural(job.total_rows, "row")}`}</strong>
              <span className={styles.muted}>Started {job.started_at ? formatRelative(job.started_at) : "in a moment"} · {job.format.toUpperCase()}</span>
            </div>
            <Progress label={job.status === "queued" ? "Queued: waiting for the import worker" : `${formatCount(job.processed_rows)} of ${plural(job.total_rows, "row")}`} value={progress} showValue />
            <CountsStrip job={job} />
            <p className={styles.muted}>Rows are processed 500 at a time. You can leave this tab; the import keeps running and its report stays under Recent imports.</p>
          </>
        ) : !final ? <Skeleton lines={3} label="Loading the import" /> : null}
        {pollError ? (final ? (
          <Alert tone="danger" title="This import can't be followed">
            {pollError.message} {pollError.hint}
            <span className={styles.alertActions}>
              <Button size="sm" variant="secondary" onClick={() => void followed.refetch()}>Try again</Button>
              <Button size="sm" variant="ghost" onClick={reset}>Start another import</Button>
            </span>
          </Alert>
        ) : (
          <Alert tone="warning" title="Lost track of the import for a moment">{`${pollError.message} Trying again shortly; the import itself keeps running.`}</Alert>
        )) : null}
      </Surface>
    );
  } else if (step === 4 && job) {
    content = <Report appId={appId} job={job} onImportForReal={importForReal} onNew={reset} />;
  }

  return (
    <div className={styles.importTab}>
      <Stepper
        label="Import users"
        steps={STEPS}
        current={step}
        onStepSelect={index => {
          if (index <= 2 && parsed && step <= 2) setWizardStep(index);
          else if (index === 0 && step === 4) reset();
        }}
        details="current"
        className={styles.stepper}
      />
      <div ref={stepRegion} className={styles.stepRegion} tabIndex={-1} aria-label={`Import step: ${STEPS[step]?.label ?? ""}`}>
        {content}
      </div>
      <span className="sr-only" aria-live="polite">{step === 4 && job ? (job.status === "failed" ? "The import failed." : dryRunOf(job) ? "The dry run finished." : "The import finished.") : ""}</span>
    </div>
  );
}
