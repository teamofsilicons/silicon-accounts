/**
 * Import: bring an app's existing users. A stepper walks through it: upload or paste a CSV or JSON file, check its
 * columns in the browser (unknown columns are named before anything is sent), choose the options, run a dry run or
 * the import, watch it progress, and read the report row by row. Each imported user is matched to the account that
 * already has their email or phone; otherwise a Carbon account is created that they finish on their first sign-in.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { ArrowLeft, Check, CircleAlert, CircleX, ClipboardPaste, Download, FileUp, Info, TriangleAlert } from "lucide-solid";
import { api, ApiError, createPagedList, request, seg, type ImportJob, type ImportOptions, type ImportOutcome, type ImportRowResult, type Page, type PageQuery } from "../../../api";
import { Alert } from "../../../arc/alert/alert";
import { AnimatedCounter } from "../../../arc/animated-counter/animated-counter";
import { Badge } from "../../../arc/badge/badge";
import { Button } from "../../../arc/button/button";
import { Combobox } from "../../../arc/combobox/combobox";
import { Drawer, DrawerContent } from "../../../arc/drawer/drawer";
import { FileDropzone } from "../../../arc/file-dropzone/file-dropzone";
import { JsonViewer } from "../../../arc/json-viewer/json-viewer";
import { PHONE_COUNTRIES, flagOf } from "../../../arc/phone-input/phone-input";
import { Progress } from "../../../arc/progress/progress";
import { SegmentedControl } from "../../../arc/segmented-control/segmented-control";
import { Skeleton } from "../../../arc/skeleton/skeleton";
import { Stepper } from "../../../arc/stepper/stepper";
import { Switch as Toggle } from "../../../arc/switch/switch";
import { Textarea } from "../../../arc/textarea/textarea";
import { useSquircle } from "../../../arc/lib/squircle";
import { SettingsGroup, SettingsRow, Surface } from "../../../app/layout/layout";
import { notifyError } from "../../../app/notify";
import { formatCount, formatRelative, plural } from "../../../lib/format";
import { useDeveloperApp } from "../lib/context";
import { COLUMN_HELP, parseFile, parseText, templateCsv, type ParsedImport } from "../lib/importfile";
import { actionKey } from "../lib/keys";
import { IMPORT_OUTCOME } from "../lib/labels";
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
  ...PHONE_COUNTRIES.map(country => ({ value: country.iso, label: `${flagOf(country.iso)} ${country.name}`, meta: `+${country.dial}`, keywords: [country.iso.toLowerCase(), country.name.toLowerCase(), country.dial] })),
];

/** `GET …/imports/{job_id}/rows` with the server's `level` and `code` filters (the shared client sends only `outcome`). */
function importRows(appId: string, jobId: string, query: PageQuery & { outcome?: ImportOutcome; level?: "error" | "warning" | "info"; code?: string }) {
  return request<Page<ImportRowResult>>(`/v1/apps/${seg(appId)}/imports/${seg(jobId)}/rows`, { query: { limit: query.limit, cursor: query.cursor ?? undefined, outcome: query.outcome, level: query.level, code: query.code } });
}

const isDone = (job: ImportJob | null | undefined) => job?.status === "completed" || job?.status === "failed";
const dryRunOf = (job: ImportJob) => !!(job.options?.dry_run ?? (job as ImportJob & { dry_run?: boolean }).dry_run);

/** Following a job survives a network blip, a restart or a rate limit; other failures (a 403, a 404) never heal. */
const retryable = (error: ApiError) => error.isNetwork || error.status === 408 || error.status === 429 || error.status >= 500;
const POLL_MS = 900;
const MAX_POLL_BACKOFF_MS = 15_000;

/** Each file read gets its own id: a dry run checks that very file, and a retry of its upload reuses its key. */
const fileIds = new WeakMap<ParsedImport, number>();
let lastFileId = 0;
const fileId = (file: ParsedImport) => {
  let id = fileIds.get(file);
  if (id === undefined) {
    id = ++lastFileId;
    fileIds.set(file, id);
  }
  return id;
};

function CountsStrip(props: { job: ImportJob }) {
  const items = () => [
    { label: "Created", value: props.job.counts.created },
    { label: "Matched", value: props.job.counts.matched },
    { label: "Updated", value: props.job.counts.updated },
    { label: "Skipped", value: props.job.counts.skipped },
    { label: "Errors", value: props.job.counts.error },
    { label: "Warnings", value: props.job.counts.warnings },
  ];
  return (
    <dl class={styles.strip}>
      <For each={items()}>
        {item => (
          <div class={styles.stripItem}>
            <dt>{item.label}</dt>
            <dd><AnimatedCounter value={item.value} size="inline" /></dd>
          </div>
        )}
      </For>
    </dl>
  );
}

function RowDetail(props: { row: ImportRowResult }) {
  return (
    <div class={styles.rowDetail}>
      <div class={styles.rowMessages}>
        <Show when={props.row.messages.length} fallback={<p class={styles.muted}>No messages: the row went through cleanly.</p>}>
          <For each={props.row.messages}>
            {message => (
              <div class={styles.message} data-level={message.level}>
                <span class={styles.messageIcon} aria-hidden="true">{message.level === "error" ? <CircleX size={16} stroke-width={1.75} /> : message.level === "warning" ? <TriangleAlert size={16} stroke-width={1.75} /> : <Info size={16} stroke-width={1.75} />}</span>
                <span class={styles.messageText}>
                  <span><code class={styles.code}>{message.code}</code><Show when={message.field}>{field => <span class={styles.messageField}> in {field()}</span>}</Show></span>
                  <span class={styles.messageBody}>{message.message}</span>
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>
      <JsonViewer data={props.row.input} rootName="input" defaultExpandDepth={2} maxHeight={260} label={`Input of row ${props.row.row_number}`} searchable={false} />
    </div>
  );
}

function Report(props: { appId: string; job: ImportJob; onImportForReal?: () => void; onNew: () => void }) {
  const [filter, setFilter] = createSignal<RowFilter>("all");
  const [open, setOpen] = createSignal<ImportRowResult | null>(null);
  const list = createPagedList(query => {
    const value = filter();
    const outcome = value === "all" || value === "warning" ? undefined : (value as ImportOutcome);
    return importRows(props.appId, props.job.id, { ...query, outcome, level: value === "warning" ? "warning" : undefined });
  }, { limit: 50, immediate: false });
  createEffect(on(filter, () => void list.reset()));
  const dry = () => dryRunOf(props.job);
  const failed = () => props.job.status === "failed";
  const summary = () => {
    const counts = props.job.counts;
    const written = counts.created + counts.matched + counts.updated;
    if (failed()) return `The import stopped after ${formatCount(props.job.processed_rows)} of ${formatCount(props.job.total_rows)} rows.`;
    if (dry()) return `Nothing was written. ${plural(written, "row")} would go through, ${plural(counts.error, "row")} would fail and ${formatCount(counts.skipped)} would be skipped.`;
    return `${plural(counts.created, "account")} created, ${formatCount(counts.matched)} matched to existing accounts, ${formatCount(counts.updated)} updated; ${plural(counts.error, "row")} failed and ${formatCount(counts.skipped)} ${counts.skipped === 1 ? "was" : "were"} skipped.`;
  };
  return (
    <div class={styles.report}>
      <Alert
        tone={failed() ? "danger" : dry() ? "info" : props.job.counts.error ? "warning" : "success"}
        title={failed() ? "The import failed" : dry() ? "Dry run finished" : "Import finished"}
        action={
          <>
            <Show when={dry() && props.onImportForReal}><Button size="sm" onClick={() => props.onImportForReal?.()}>Import for real</Button></Show>
            <Button size="sm" variant="secondary" onClick={() => props.onNew()}>Start another import</Button>
          </>
        }
      >
        <p class={styles.alertLine}>{summary()}</p>
        <Show when={props.job.error}>{error => <p class={styles.alertLine}>{error()}</p>}</Show>
        <Show when={dry() && !props.onImportForReal}><p class={styles.alertLine}>To import it for real, upload the file again.</p></Show>
      </Alert>
      <dl ref={el => useSquircle(el)} class={styles.totals}>
        <For each={[
          { label: "Created", value: props.job.counts.created, context: "New Carbon accounts; finished on first sign-in" },
          { label: "Matched", value: props.job.counts.matched, context: "Existing accounts, now members" },
          { label: "Updated", value: props.job.counts.updated, context: "Imported details refreshed" },
          { label: "Skipped", value: props.job.counts.skipped, context: "Repeats of an earlier row" },
          { label: "Errors", value: props.job.counts.error, context: "Rows not imported" },
          { label: "Warnings", value: props.job.counts.warnings, context: "Imported, with a note" },
        ]}>
          {item => (
            <div class={styles.total}>
              <dt>{item.label}</dt>
              <dd><span class={styles.totalValue}>{formatCount(item.value)}</span><span class={styles.totalContext}>{item.context}</span></dd>
            </div>
          )}
        </For>
      </dl>
      <section class={styles.rowsSection} aria-label="Rows">
        <div class={styles.rowsHead}>
          <h3 class={styles.rowsTitle}>Rows</h3>
          <SegmentedControl label="Show rows" size="sm" value={filter()} onValueChange={setFilter} options={ROW_FILTERS} />
        </div>
        <Show when={list.error()}>{error => <Alert tone="danger" title="The rows could not be loaded" action={<Button size="sm" variant="secondary" onClick={() => void list.reset()}>Try again</Button>}>{error().message} {error().hint}</Alert>}</Show>
        <Show when={!list.loading() || list.items().length} fallback={<Skeleton lines={5} label="Loading rows" />}>
          <div ref={el => useSquircle(el)} class={styles.rowsTable}>
            <Show when={list.items().length} fallback={<p class={styles.rowsEmpty}>{filter() === "all" ? "This import has no rows." : `No ${ROW_FILTERS.find(entry => entry.value === filter())?.label.toLowerCase()} in this import.`}</p>}>
              <table class={styles.table}>
                <caption class="sr-only">Rows of the import</caption>
                <thead><tr><th scope="col">Row</th><th scope="col">Outcome</th><th scope="col">Account</th><th scope="col">Messages</th></tr></thead>
                <tbody>
                  <For each={list.items()}>
                    {row => {
                      const outcome = () => IMPORT_OUTCOME[row.outcome] ?? { label: row.outcome, tone: "neutral" as const };
                      return (
                        <tr tabIndex={0} onClick={() => setOpen(row)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(row); } }}>
                          <td class={styles.num}>{row.row_number}</td>
                          <td><Badge size="sm" tone={outcome().tone}>{outcome().label}</Badge></td>
                          <td class={styles.mono}>{row.id ?? (dry() && row.outcome === "matched" ? "hidden in a dry run" : "–")}</td>
                          <td>
                            <Show when={row.messages.length} fallback={<span class={styles.muted}>None</span>}>
                              <ul class={styles.cellMessages} role="list">
                                <For each={row.messages.slice(0, 2)}>{message => <li data-level={message.level}><code class={styles.code}>{message.code}</code> {message.message}</li>}</For>
                                <Show when={row.messages.length > 2}><li class={styles.muted}>and {row.messages.length - 2} more</li></Show>
                              </ul>
                            </Show>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
          <Show when={list.hasMore()}><Button size="sm" variant="secondary" loading={list.loadingMore()} onClick={() => void list.loadMore()}>Load more rows</Button></Show>
        </Show>
      </section>
      <Drawer open={!!open()} onOpenChange={value => { if (!value) setOpen(null); }}>
        <Show when={open()}>
          {row => (
            <DrawerContent title={`Row ${row().row_number}`} description={`${IMPORT_OUTCOME[row().outcome]?.label ?? row().outcome}${row().id ? ` · ${row().id}` : ""}`} size="lg">
              <RowDetail row={row()} />
            </DrawerContent>
          )}
        </Show>
      </Drawer>
    </div>
  );
}

function RecentImports(props: { appId: string; onOpen: (job: ImportJob) => void }) {
  const list = createPagedList(query => api.apps.imports.list(props.appId, query), { limit: 10 });
  return (
    <section class={styles.recent} aria-label="Recent imports">
      <h3 class={styles.rowsTitle}>Recent imports</h3>
      <Show when={list.error()}>{error => <Alert tone="danger" title="Recent imports could not be loaded">{error().message} {error().hint}</Alert>}</Show>
      <Show when={!list.loading()} fallback={<Skeleton lines={3} label="Loading recent imports" />}>
        <Show when={list.items().length} fallback={<p class={styles.muted}>No imports yet. The first one shows up here, with its report.</p>}>
          <ul class={styles.recentList} role="list">
            <For each={list.items()}>
              {job => (
                <li>
                  <button type="button" ref={el => useSquircle(el)} class={styles.recentItem} onClick={() => props.onOpen(job)}>
                    <span class={styles.recentWhen}>{formatRelative(job.created_at)}<span class={styles.muted}> · {job.format.toUpperCase()} · {plural(job.total_rows, "row")}</span></span>
                    <span class={styles.recentCounts}>{formatCount(job.counts.created)} created · {formatCount(job.counts.matched)} matched · {formatCount(job.counts.error)} errors</span>
                    <span class={styles.recentBadges}>
                      <Show when={dryRunOf(job)}><Badge size="sm" tone="info">Dry run</Badge></Show>
                      <Badge size="sm" tone={job.status === "completed" ? "success" : job.status === "failed" ? "danger" : "neutral"}>{job.status === "completed" ? "Finished" : job.status === "failed" ? "Failed" : job.status === "running" ? "Running" : "Queued"}</Badge>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}

export default function ImportTab() {
  const ctx = useDeveloperApp();
  const [step, setStep] = createSignal(0);
  const [parsed, setParsed] = createSignal<ParsedImport | null>(null);
  const [reading, setReading] = createSignal(false);
  const [paste, setPaste] = createSignal(false);
  const [pasted, setPasted] = createSignal("");
  const [country, setCountry] = createSignal("none");
  const [ignoreUnknown, setIgnoreUnknown] = createSignal(false);
  const [updateExisting, setUpdateExisting] = createSignal(false);
  const [job, setJob] = createSignal<ImportJob | null>(null);
  const [submitting, setSubmitting] = createSignal<"dry" | "real" | null>(null);
  const [submitError, setSubmitError] = createSignal<ApiError | null>(null);
  const [pollError, setPollError] = createSignal<{ error: ApiError; final: boolean; retryIn: number } | null>(null);
  // The dry run of the file loaded now, with the options it ran with: the only run "Import for real" may repeat.
  const [checked, setChecked] = createSignal<{ jobId: string; file: ParsedImport; options: ImportOptions } | null>(null);
  // A retry of the same upload (same file, same options) reuses its key, so it never starts a second job.
  const uploadKey = actionKey();
  let stepRegion: HTMLDivElement | undefined;
  // Each step replaces the last; keyboard and screen reader focus moves to the new step instead of falling to the page.
  createEffect(on(step, () => queueMicrotask(() => {
    if (stepRegion && document.activeElement && !stepRegion.contains(document.activeElement) && document.activeElement !== document.body) return;
    stepRegion?.focus({ preventScroll: true });
  }), { defer: true }));

  const read = async (load: () => Promise<ParsedImport>) => {
    setReading(true);
    try {
      const result = await load();
      setParsed(result);
      setIgnoreUnknown(false);
      setSubmitError(null);
      setStep(1);
    } catch (error) {
      notifyError(error, "The file could not be read");
    } finally {
      setReading(false);
    }
  };

  /* Following a job: one poll at a time, until it finishes. The job id lives in the page context, so leaving the tab
     and coming back picks it up again; every pass checks it is still the one wanted before it schedules the next. */
  let timer = 0;
  let generation = 0;
  const stopFollowing = () => {
    generation++;
    window.clearTimeout(timer);
  };
  onCleanup(stopFollowing);
  const follow = (id: string, delay: number) => {
    stopFollowing();
    const mine = generation;
    const current = () => mine === generation && ctx.importJob() === id;
    setPollError(null);
    const tick = async (failures: number) => {
      if (!current()) return;
      let wait = POLL_MS;
      try {
        const next = await api.apps.imports.get(ctx.appId, id);
        if (!current()) return;
        setJob(next);
        setPollError(null);
        if (isDone(next)) {
          setStep(4);
          if (!dryRunOf(next)) void ctx.reload();
          return;
        }
        failures = 0;
      } catch (raw) {
        if (!current()) return;
        const error = ApiError.from(raw);
        if (!retryable(error)) {
          setPollError({ error, final: true, retryIn: 0 });
          return;
        }
        failures += 1;
        wait = Math.min(MAX_POLL_BACKOFF_MS, Math.max(POLL_MS * 2 ** failures, (error.retryAfter ?? 0) * 1000));
        setPollError({ error, final: false, retryIn: wait });
      }
      if (current()) timer = window.setTimeout(() => void tick(failures), wait);
    };
    timer = window.setTimeout(() => void tick(0), delay);
  };
  const watch = (value: ImportJob) => {
    stopFollowing();
    setJob(value);
    setPollError(null);
    ctx.setImportJob(value.id);
    if (isDone(value)) setStep(4);
    else {
      setStep(3);
      follow(value.id, 600);
    }
  };
  onMount(() => {
    const id = ctx.importJob();
    if (id) {
      setStep(3);
      follow(id, 0);
    }
  });

  const reset = () => {
    stopFollowing();
    setParsed(null);
    setChecked(null);
    setJob(null);
    setSubmitError(null);
    setPollError(null);
    setPasted("");
    setPaste(false);
    ctx.setImportJob(null);
    setStep(0);
  };

  /** An earlier run from Recent imports: its report only. The file loaded now (if any) is not what it checked. */
  const openRecent = (value: ImportJob) => {
    setParsed(null);
    setChecked(null);
    setSubmitError(null);
    setPasted("");
    setPaste(false);
    watch(value);
  };

  const options = (dry: boolean): ImportOptions => ({
    default_country: country() === "none" ? undefined : country(),
    ignore_unknown_columns: ignoreUnknown(),
    dry_run: dry,
    update_existing: updateExisting(),
  });

  /** Starts a job for `file` (the loaded one by default) with `opts` (the options chosen on the page by default). */
  const submit = async (dry: boolean, from?: { file: ParsedImport; options: ImportOptions }) => {
    const file = from?.file ?? parsed();
    if (!file || submitting()) return;
    const opts: ImportOptions = from ? { ...from.options, dry_run: dry } : options(dry);
    setSubmitting(dry ? "dry" : "real");
    setSubmitError(null);
    const idempotencyKey = uploadKey.for(`${fileId(file)} ${JSON.stringify(opts)}`);
    try {
      const created = file.format === "json"
        ? await api.apps.imports.startRows(ctx.appId, file.jsonRows ?? [], opts, { idempotencyKey })
        : await api.apps.imports.startCsv(ctx.appId, file.csv ?? "", opts, { idempotencyKey });
      uploadKey.done();
      setChecked(dry ? { jobId: created.id, file, options: opts } : null);
      watch(created);
    } catch (raw) {
      const error = ApiError.from(raw);
      setSubmitError(error);
      if (error.code === "unknown_columns") setStep(1);
    } finally {
      setSubmitting(null);
    }
  };

  /** "Import for real" on a dry run's report: only that dry run's own file and options, and only while it is loaded. */
  const importForReal = (report: ImportJob) => {
    const run = checked();
    if (!run || run.jobId !== report.id || run.file !== parsed()) return undefined;
    return () => {
      setStep(2);
      void submit(false, { file: run.file, options: run.options });
    };
  };

  const blocked = () => (parsed()?.problems.length ?? 0) > 0;
  const needsAck = () => (parsed()?.unknown.length ?? 0) > 0 && !ignoreUnknown();

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([templateCsv()], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${ctx.appId}-users-template.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const progress = createMemo(() => {
    const current = job();
    if (!current || !current.total_rows) return 0;
    return Math.round((current.processed_rows / current.total_rows) * 100);
  });

  return (
    <div class={styles.importTab}>
      <Stepper
        label="Import users"
        steps={STEPS}
        current={step()}
        onStepSelect={index => {
          if (index <= 2 && parsed() && step() <= 2) setStep(index);
          else if (index === 0 && step() === 4) reset();
        }}
        details="current"
        class={styles.stepper}
      />

      <div ref={stepRegion} class={styles.stepRegion} tabIndex={-1} aria-label={`Import step: ${STEPS[step()]?.label ?? ""}`}>
      <Switch>
        <Match when={step() === 0}>
          <Show when={parsed()}>
            {file => (
              <Surface class={styles.fileSummary}>
                <FileUp size={20} stroke-width={1.75} aria-hidden="true" class={styles.fileIcon} />
                <div class={styles.fileText}>
                  <strong>{file().source} is loaded</strong>
                  <span>{file().format.toUpperCase()} · {plural(file().rows, "row")}. Choose another file below to replace it.</span>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setStep(1)}>Continue with it</Button>
              </Surface>
            )}
          </Show>
          <div class={styles.upload}>
            <div class={styles.uploadMain}>
              <Show
                when={!paste()}
                fallback={
                  <div class={styles.pasteBox}>
                    <Textarea label="Paste CSV or JSON" mono rows={10} placeholder={"email,display_name,username\nada@example.com,Ada Okafor,ada"} value={pasted()} onInput={event => setPasted(event.currentTarget.value)} description="CSV needs a header row. JSON is an array of objects, or {&quot;rows&quot;: [...]}." />
                    <div class={styles.actions}>
                      <Button variant="ghost" onClick={() => setPaste(false)}><ArrowLeft size={16} stroke-width={1.75} aria-hidden="true" />Upload a file instead</Button>
                      <Button disabled={!pasted().trim()} loading={reading()} onClick={() => void read(async () => parseText(pasted()))}>Check columns</Button>
                    </div>
                  </div>
                }
              >
                <FileDropzone
                  label="Drop a CSV or JSON file"
                  description="Or choose one from your device. Up to 100,000 rows and 50 MB."
                  accept=".csv,.json,text/csv,application/json"
                  multiple={false}
                  maxFiles={1}
                  maxSize={50 * 1024 * 1024}
                  note="Only the columns on the right are kept."
                  onFilesChange={files => { const file = files[0]; if (file) void read(() => parseFile(file)); }}
                />
                <div class={styles.actions}>
                  <Button variant="secondary" onClick={() => setPaste(true)}><ClipboardPaste size={16} stroke-width={1.75} aria-hidden="true" />Paste instead</Button>
                  <Button variant="ghost" onClick={downloadTemplate}><Download size={16} stroke-width={1.75} aria-hidden="true" />Download a CSV template</Button>
                </div>
              </Show>
            </div>
            <aside ref={el => useSquircle(el)} class={styles.columnsHelp} aria-label="Columns an import can have">
              <h3 class={styles.helpTitle}>The only columns an import keeps</h3>
              <p class={styles.helpText}>An app's user base has the columns Silicon Accounts gives. Each row needs an email or phone.</p>
              <dl class={styles.columnList}>
                <For each={Object.entries(COLUMN_HELP)}>{([column, help]) => <div><dt><code>{column}</code></dt><dd>{help}</dd></div>}</For>
              </dl>
              <p class={styles.helpText}>Creating accounts by import never sends an email or SMS.</p>
            </aside>
          </div>
          <RecentImports appId={ctx.appId} onOpen={openRecent} />
        </Match>

        <Match when={step() === 1 && parsed()}>
          {file => (
            <div class={styles.check}>
              <Surface class={styles.fileSummary}>
                <FileUp size={20} stroke-width={1.75} aria-hidden="true" class={styles.fileIcon} />
                <div class={styles.fileText}>
                  <strong>{file().source}</strong>
                  <span>{file().format.toUpperCase()} · {plural(file().rows, "row")} · {plural(file().columns.length, "column")} · {file().bytes < 1024 ? plural(file().bytes, "byte") : file().bytes < 1024 * 1024 ? `${Math.round(file().bytes / 1024)} KB` : `${(file().bytes / 1024 / 1024).toFixed(1)} MB`}</span>
                </div>
                <Button size="sm" variant="ghost" onClick={reset}>Choose another file</Button>
              </Surface>

              <Show when={submitError()}>
                {error => <Alert tone="danger" title="Silicon Accounts refused the file">{error().message} {error().hint}</Alert>}
              </Show>
              <Show when={file().problems.length}>
                <Alert tone="danger" title={file().problems.length === 1 ? "This file can't be imported yet" : `${file().problems.length} things stop this import`}>
                  <ul class={styles.problems} role="list"><For each={file().problems}>{problem => <li>{problem}</li>}</For></ul>
                </Alert>
              </Show>
              <Show when={!file().problems.length && file().unknown.length}>
                <Alert
                  tone="warning"
                  title={`${plural(file().unknown.length, "column")} Silicon Accounts doesn't keep`}
                  action={<Show when={!ignoreUnknown()} fallback={<Button size="sm" variant="secondary" onClick={() => setIgnoreUnknown(false)}>Don't ignore them</Button>}><Button size="sm" onClick={() => setIgnoreUnknown(true)}>Ignore them and continue</Button></Show>}
                >
                  <p class={styles.alertLine}>{file().unknown.join(", ")}. An app's user base only has the columns we give, so these values are never stored.</p>
                  <p class={styles.alertLine}>{ignoreUnknown() ? "They will be ignored; each row with a value in them gets a warning." : "Remove or rename them, or ignore them: the rest of each row is imported and the row gets a warning."}</p>
                </Alert>
              </Show>

              <section class={styles.columnsSection} aria-label="Columns">
                <h3 class={styles.rowsTitle}>Columns</h3>
                <ul class={styles.columnChips} role="list">
                  <For each={file().columns}>
                    {column => (
                      <li ref={el => useSquircle(el)} class={styles.columnChip} data-status={column.status}>
                        <span class={styles.columnIcon} aria-hidden="true">{column.status === "ok" || column.status === "alias" ? <Check size={14} stroke-width={2} /> : column.status === "unnamed" ? <CircleAlert size={14} stroke-width={1.75} /> : <CircleX size={14} stroke-width={1.75} />}</span>
                        <code>{column.name}</code>
                        <Show when={column.status === "alias"}><span class={styles.columnNote}>as display_name</span></Show>
                        <Show when={column.status === "unknown"}><span class={styles.columnNote}>not kept</span></Show>
                        <Show when={column.status === "duplicate"}><span class={styles.columnNote}>twice</span></Show>
                        <Show when={column.status === "unnamed"}><span class={styles.columnNote}>no name</span></Show>
                      </li>
                    )}
                  </For>
                </ul>
              </section>

              <Show when={file().sample.length}>
                <section class={styles.columnsSection} aria-label="First rows">
                  <h3 class={styles.rowsTitle}>First rows, as they will be read</h3>
                  <div ref={el => useSquircle(el)} class={styles.rowsTable}>
                    <table class={styles.table}>
                      <caption class="sr-only">The first rows of the file</caption>
                      <thead><tr><For each={file().columns.filter(column => column.canonical && (column.status === "ok" || column.status === "alias"))}>{column => <th scope="col">{column.canonical}</th>}</For></tr></thead>
                      <tbody>
                        <For each={file().sample}>
                          {row => <tr><For each={file().columns.filter(column => column.canonical && (column.status === "ok" || column.status === "alias"))}>{column => <td class={styles.mono}>{row[column.canonical ?? ""] || <span class={styles.muted}>empty</span>}</td>}</For></tr>}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </section>
              </Show>

              <div class={styles.actions}>
                <Button variant="ghost" onClick={reset}><ArrowLeft size={16} stroke-width={1.75} aria-hidden="true" />Back</Button>
                <Button disabled={blocked() || needsAck()} onClick={() => setStep(2)}>Continue to options</Button>
              </div>
              <Show when={!blocked() && needsAck()}><p class={styles.hintRight}>Decide about the columns Silicon Accounts doesn't keep first.</p></Show>
            </div>
          )}
        </Match>

        <Match when={step() === 2 && parsed()}>
          {file => (
            <div class={styles.options}>
              <Combobox label="Default country for phone numbers" description="Used for numbers written without a country code, like (202) 555-0142." options={COUNTRY_OPTIONS} value={country()} onValueChange={setCountry} placeholder="Search a country" />
              <SettingsGroup label="Import options">
                <SettingsRow label="Update existing members" description="For rows that match an account already in this app, refresh the imported details and external id. The account's own data is never changed.">
                  {ids => <Toggle aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} checked={updateExisting()} onChange={setUpdateExisting} />}
                </SettingsRow>
                <Show when={file().unknown.length}>
                  <SettingsRow label="Ignore columns Silicon Accounts doesn't keep" description={`${file().unknown.join(", ")}: never stored; each affected row gets a warning.`}>
                    {ids => <Toggle aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} checked={ignoreUnknown()} onChange={setIgnoreUnknown} />}
                  </SettingsRow>
                </Show>
              </SettingsGroup>
              <Surface class={styles.howItWorks}>
                <p>Each row is matched to the account that already has one of its emails or phone numbers and joins {ctx.app().name}'s user base. With no match, a Carbon account is created; it is finished the first time they sign in with one of those emails or numbers.</p>
                <p>A dry run checks every row and writes nothing. Nobody gets an email or SMS either way.</p>
              </Surface>
              <Show when={submitError()}>
                {error => <Alert tone="danger" title="The import did not start" action={<Button size="sm" variant="secondary" onClick={() => setSubmitError(null)}>Dismiss</Button>}>{error().message} {error().hint}{error().retryAfter ? ` You can try again in ${error().retryAfter} s.` : ""}</Alert>}
              </Show>
              <div class={styles.actions}>
                <Button variant="ghost" onClick={() => setStep(1)}><ArrowLeft size={16} stroke-width={1.75} aria-hidden="true" />Back</Button>
                <span class={styles.grow} />
                <Button variant="secondary" loading={submitting() === "dry"} disabled={!!submitting()} onClick={() => void submit(true)}>Do a dry run</Button>
                <Button loading={submitting() === "real"} disabled={!!submitting()} onClick={() => void submit(false)}>Import {plural(file().rows, "row")}</Button>
              </div>
            </div>
          )}
        </Match>

        <Match when={step() === 3}>
          <Surface class={styles.run}>
            <Show when={job()} fallback={<Show when={!pollError()?.final}><Skeleton lines={3} label="Loading the import" /></Show>}>
              {current => (
                <>
                  <div class={styles.runHead}>
                    <strong>{dryRunOf(current()) ? "Dry run in progress" : `Importing ${plural(current().total_rows, "row")}`}</strong>
                    <span class={styles.muted}>Started {current().started_at ? formatRelative(current().started_at) : "in a moment"} · {current().format.toUpperCase()}</span>
                  </div>
                  <Progress label={current().status === "queued" ? "Queued: waiting for the import worker" : `${formatCount(current().processed_rows)} of ${formatCount(current().total_rows)} rows`} value={progress()} indeterminate={current().status === "queued"} showValue />
                  <CountsStrip job={current()} />
                  <p class={styles.muted}>Rows are processed 500 at a time. You can leave this tab; the import keeps running and its report stays under Recent imports.</p>
                </>
              )}
            </Show>
            <Show when={pollError()}>
              {problem => (
                <Show
                  when={problem().final}
                  fallback={<Alert tone="warning" title="Lost track of the import for a moment">{problem().error.message} Trying again in {Math.max(1, Math.round(problem().retryIn / 1000))} s; the import itself keeps running.</Alert>}
                >
                  <Alert
                    tone="danger"
                    title="This import can't be followed"
                    action={
                      <>
                        <Show when={ctx.importJob()}>{id => <Button size="sm" variant="secondary" onClick={() => follow(id(), 0)}>Try again</Button>}</Show>
                        <Button size="sm" variant="ghost" onClick={reset}>Start another import</Button>
                      </>
                    }
                  >
                    {problem().error.message} {problem().error.hint}
                  </Alert>
                </Show>
              )}
            </Show>
          </Surface>
        </Match>

        <Match when={step() === 4 && job()}>
          {current => <Report appId={ctx.appId} job={current()} onImportForReal={importForReal(current())} onNew={reset} />}
        </Match>
      </Switch>
      </div>
      <span class="sr-only" aria-live="polite">{step() === 4 && job() ? (job()?.status === "failed" ? "The import failed." : dryRunOf(job() as ImportJob) ? "The dry run finished." : "The import finished.") : ""}</span>
    </div>
  );
}

