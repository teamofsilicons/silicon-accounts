/**
 * One draft of an app's sign-in setup, shared by the Sign-in, Details, Flows and Pages tabs so switching tabs never
 * loses an edit. Each save group (lib/config.ts: signin, flow, pages) saves only the keys it owns, with
 * `expected_version`, so two people (or two browser tabs) never silently overwrite each other. Changing the requested
 * details keeps the draft flow in step (reconcileFlow), so the flow group always saves a valid document.
 *
 * Whenever a newer stored version shows up (a 409 `config_version_conflict` on save, or the app read again after a
 * webhook change, an import or a window focus), the draft moves onto it at once, leaf by leaf (the rule the server's
 * history uses): every leaf a tab changed and has not saved stays on top. What happens next depends on whose changes
 * touch what, per tab:
 *  - none of the other changes touches this tab's changes: they stay on top and the tab says what changed underneath
 *    (after a 409 they are saved on top at once, since that is what Save asked for);
 *  - both changed the same setting to different values: the tab holds a conflict and its Save waits until the Carbon
 *    picks "Save mine on top" or "Discard mine, load theirs". One tab's choice never decides for the other tab.
 * The base version never moves silently under unsaved changes (a review finding on the SolidJS build: a reload after a
 * webhook change turned someone else's newer save into a lost update).
 *
 * Text typed into a list field (a redirect URI, an origin, a domain) and not added yet is part of the draft too
 * (`typed`): it counts as unsaved, it stays when the tab changes, and a save first adds it (the field's own checks
 * decide) or, when it can't be added, waits with a problem naming it instead of saving without it.
 *
 * The editor is a small external store (subscribe + snapshot, read with `useEditor`). Editors live in a registry per
 * app for the life of the browser tab: leaving an app with unsaved changes keeps its draft, so a navigation that could
 * not ask first (the command palette, Back) never loses work, and while any kept or shown draft has unsaved changes,
 * reloading or closing the browser tab asks first. Clean editors are dropped on leave.
 */
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/api/http";
import type { AppDetail } from "@/lib/api/types";
import { NO_SECRETS, SECTIONS, SECTION_KEYS, normalizeConfig, reconcileFlow, secretsChanged, secretsStored, sectionOf, sectionPatch, type EditableConfig, type SecretsDraft, type SectionKey } from "./config";
import { clone, deepEqual, getPath, leafDiff, setIn, touches, under, union } from "./json";
import { brandingProblems, copyProblems, flowProblems, signinProblems } from "./validate";

/** Secrets are never read back, so a change to one on both sides always counts as a conflict. */
const SECRET_PATHS = new Set(["google.client_secret", "apple.private_key"]);

export interface ConflictInfo {
  /** The version this tab's changes were made on, and the stored version the draft now sits on. */
  fromVersion: number;
  toVersion: number;
  /** Leaf paths someone else changed in between (where they differ from this draft). */
  theirs: string[];
  /** Leaf paths this tab changed. */
  mine: string[];
  /** Paths both changed to different values: saving this tab keeps its own values there. */
  overlap: string[];
}

/** A newer version arrived under this tab's changes without touching them. */
export interface VersionNotice {
  fromVersion: number;
  toVersion: number;
  /** Leaf paths someone else changed. */
  theirs: string[];
  /** True once this tab's changes were saved on top of it. */
  saved: boolean;
}

export interface SectionState {
  pending: boolean;
  /** The last failure (validation, network, anything but a version conflict). */
  error: ApiError | undefined;
  /** Server field errors (422 details.fields) by path, cleared on the next edit. */
  serverFields: Record<string, string>;
  /** Someone else changed what this tab changed: saving waits for a choice. */
  conflict: ConflictInfo | null;
  notice: VersionNotice | null;
  savedAt: number | null;
  /** True after a save was attempted while local problems existed (shows every problem). */
  attempted: boolean;
}

export interface EditorState {
  /** The newest stored config this page knows (what the draft is based on). */
  base: EditableConfig;
  /** Its version: what the next save sends as `expected_version`. */
  version: number;
  /** Whether BYO secrets are stored. */
  stored: { google: boolean; apple: boolean };
  draft: EditableConfig;
  secrets: SecretsDraft;
  sections: Record<SectionKey, SectionState>;
  /** Paths edited since the last save or discard: their local problems show next to their fields. */
  touched: string[];
  /** Text typed into a list field and not added to it yet, by the list's path (`redirect_uris`). Never blank. */
  typed: Record<string, string>;
}

/** The state plus everything derived from it, recomputed once per change. */
export interface EditorView extends EditorState {
  /** Leaf paths changed and not saved, per tab. */
  changes: Record<SectionKey, string[]>;
  /** List paths holding typed text that is not added yet, per tab (unsaved too). */
  typedPaths: Record<SectionKey, string[]>;
  /** Changes, typed text included: changed leaves plus lists with text waiting to be added. */
  unsaved: Record<SectionKey, number>;
  dirty: Record<SectionKey, boolean>;
  anyDirty: boolean;
  /** Local problems (mirrors of the server checks) by path. */
  problems: Record<SectionKey, Record<string, string>>;
  /** What shows next to the fields: problems of touched fields (all of them after a save attempt) and server errors. */
  fieldErrors: Record<SectionKey, Record<string, string>>;
  /** The open conflict of a tab: null when there is none, or once none of its settings is still changed. */
  conflict: Record<SectionKey, ConflictInfo | null>;
}

const idle = (): SectionState => ({ pending: false, error: undefined, serverFields: {}, conflict: null, notice: null, savedAt: null, attempted: false });

/** The group a problem belongs to for "was it touched": a palette problem shows once any colour of that palette changed. */
function problemGroup(path: string): string {
  const palette = /^branding\.(light|dark)\./.exec(path);
  return palette ? `branding.${palette[1]}` : path.replace(/\[\d+\]$/, "");
}

/** Typed text quoted in a message, shortened when long. */
const quoted = (text: string) => {
  const trimmed = text.trim();
  return `“${[...trimmed].length > 60 ? `${[...trimmed].slice(0, 57).join("")}…` : trimmed}”`;
};

/**
 * Why a save waits for typed text: it was never added to its list. A save first asks the fields to add what is typed,
 * so what is left was refused (the field says why next to it).
 */
export function typedProblems(state: Pick<EditorState, "typed">, section: SectionKey): Record<string, string> {
  return Object.fromEntries(
    Object.entries(state.typed)
      .filter(([path]) => sectionOf(path) === section)
      .map(([path, text]) => [path, `${quoted(text)} is not in the list yet. Fix it and press Enter, or clear the field.`]),
  );
}

const perSection = <T>(make: (section: SectionKey) => T): Record<SectionKey, T> =>
  Object.fromEntries(SECTIONS.map(section => [section, make(section)])) as Record<SectionKey, T>;

function computeView(state: EditorState): EditorView {
  const changes = perSection(section => [
    ...SECTION_KEYS[section].flatMap(key => leafDiff(state.base[key], state.draft[key], key)),
    ...(section === "signin" ? secretsChanged(state.secrets, state.draft) : []),
  ]);
  const typedPaths = perSection<string[]>(() => []);
  for (const path of Object.keys(state.typed)) typedPaths[sectionOf(path)].push(path);
  const unsaved = perSection(section => changes[section].length + typedPaths[section].length);
  const local: Record<SectionKey, Record<string, string>> = {
    signin: signinProblems(state.draft, {
      googleSecret: state.secrets.googleSecret,
      googleSecretStored: state.stored.google,
      googleRemove: state.secrets.googleRemove,
      appleKey: state.secrets.appleKey,
      appleKeyStored: state.stored.apple,
      appleRemove: state.secrets.appleRemove,
    }),
    flow: flowProblems(state.draft),
    pages: { ...brandingProblems(state.draft.branding), ...copyProblems(state.draft.copy) },
  };
  // Typed text that never made it into its list is only unsaved while it is typed; once a save was tried, it is what
  // blocks the save (and its message shows next to the field).
  const problems = perSection(section => (state.sections[section].attempted ? { ...local[section], ...typedProblems(state, section) } : local[section]));
  const fieldErrors = {} as Record<SectionKey, Record<string, string>>;
  const conflict = {} as Record<SectionKey, ConflictInfo | null>;
  for (const section of SECTIONS) {
    const shown: Record<string, string> = {};
    const all = state.sections[section].attempted;
    for (const [path, message] of Object.entries(problems[section])) {
      const group = problemGroup(path);
      if (all || state.touched.some(edited => touches(edited, group))) shown[path] = message;
    }
    fieldErrors[section] = { ...shown, ...state.sections[section].serverFields };
    const open = state.sections[section].conflict;
    conflict[section] = open && open.overlap.some(path => changes[section].some(changed => touches(changed, path))) ? open : null;
  }
  return {
    ...state,
    changes,
    typedPaths,
    unsaved,
    dirty: perSection(section => unsaved[section] > 0),
    anyDirty: SECTIONS.some(section => unsaved[section] > 0),
    problems,
    fieldErrors,
    conflict,
  };
}

export interface EditorHooks {
  /** A newer stored app detail (after a save or a conflict read): put it in the query cache. */
  onStored: (detail: AppDetail) => void;
}

export class ConfigEditor {
  readonly appId: string;
  private view: EditorView;
  private listeners = new Set<() => void>();
  /** One Idempotency-Key per section and request body, kept for retries until it succeeds or the body changes. */
  private keys: Record<SectionKey, { signature: string; key: string } | null> = { signin: null, flow: null, pages: null };
  /** A newer app read that arrived while a save was in flight; adopted once the save settles. */
  private deferred: AppDetail | null = null;
  private hooks: EditorHooks = { onStored: () => undefined };

  constructor(appId: string, detail: AppDetail) {
    this.appId = appId;
    const base = normalizeConfig(detail.signin_config);
    this.view = computeView({
      base,
      version: detail.config_version,
      stored: secretsStored(detail.signin_config),
      draft: clone(base),
      secrets: { ...NO_SECRETS },
      sections: { signin: idle(), flow: idle(), pages: idle() },
      touched: [],
      typed: {},
    });
  }

  /** Where newer stored details go (the mounted page passes its query client). */
  connect(hooks: EditorHooks): void {
    this.hooks = hooks;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getView = (): EditorView => this.view;

  private get state(): EditorState {
    return this.view;
  }

  private commit(next: EditorState): void {
    const { base, version, stored, draft, secrets, sections, touched, typed } = next;
    this.view = computeView({ base, version, stored, draft, secrets, sections, touched, typed });
    for (const listener of this.listeners) listener();
  }

  private patchSection(section: SectionKey, patch: Partial<SectionState>): void {
    const state = this.state;
    this.commit({ ...state, sections: { ...state.sections, [section]: { ...state.sections[section], ...patch } } });
  }

  /** An edit makes the last server field errors (and a failed local check) of its section stale. */
  private afterEdit(state: EditorState, sections: SectionKey[]): EditorState {
    let next = state;
    for (const section of sections) {
      const current = next.sections[section];
      if (!Object.keys(current.serverFields).length && current.error?.code !== "validation_failed") continue;
      next = {
        ...next,
        sections: {
          ...next.sections,
          [section]: { ...current, serverFields: {}, ...(current.error?.code === "validation_failed" ? { error: undefined, attempted: false } : {}) },
        },
      };
    }
    return next;
  }

  /** Sets one value of the draft at a dotted path (`google.client_id`, `branding.light.primary`, `redirect_uris`). */
  edit(path: string, value: unknown): void {
    this.editMany({ [path]: value });
  }

  /**
   * Several values at once (one history step, one render). A change to the requested details takes the draft flow
   * along (reconcileFlow): new details join the last page, removed ones leave theirs.
   */
  editMany(values: Record<string, unknown>): void {
    const state = this.state;
    let draft = state.draft;
    for (const [path, value] of Object.entries(values)) draft = setIn(draft, path, value);
    const paths = Object.keys(values);
    if (paths.some(path => path === "required_fields" || path === "optional_fields") && !paths.includes("flow")) {
      const flow = reconcileFlow(draft.flow, draft);
      if (flow !== draft.flow) {
        draft = { ...draft, flow };
        paths.push("flow");
      }
    }
    this.commit(this.afterEdit({ ...state, draft, touched: union(state.touched, paths) }, [...new Set(paths.map(sectionOf))]));
  }

  /**
   * Text typed into the list field at `path` and not added yet ("" once it is added or cleared). It counts as an
   * unsaved change of the list's tab until then.
   */
  setTyped(path: string, text: string): void {
    const state = this.state;
    const current = state.typed[path] ?? "";
    const next = text.trim() ? text : "";
    if (current === next) return;
    const typed = { ...state.typed };
    if (next) typed[path] = next;
    else delete typed[path];
    this.commit(this.afterEdit({ ...state, typed }, [sectionOf(path)]));
  }

  /**
   * Changes the typed BYO secrets (write-only; never read back from the server), or opens and closes a stored
   * secret's replace field (`googleReplace`, `appleReplace`: not a change, and reset with the secrets on save and
   * Discard, so the field shows the stored state again).
   */
  setSecrets(patch: Partial<SecretsDraft>): void {
    const state = this.state;
    const touched = [
      ...("googleSecret" in patch || "googleRemove" in patch ? ["google.client_secret"] : []),
      ...("appleKey" in patch || "appleRemove" in patch ? ["apple.private_key"] : []),
    ];
    const next = { ...state, secrets: { ...state.secrets, ...patch }, touched: union(state.touched, touched) };
    // Only opening or closing a replace field edits nothing: the last server errors of the tab still stand.
    const edits = Object.keys(patch).some(key => key !== "googleReplace" && key !== "appleReplace");
    this.commit(edits ? this.afterEdit(next, ["signin"]) : next);
  }

  /** The new stored config, with the unsaved leaves of the sections not in `reset` re-applied on top. */
  private rebase(detail: AppDetail, reset: SectionKey[], overlay?: { section: SectionKey; sent: EditableConfig }): void {
    const state = this.state;
    const previous = state.base;
    const nextBase = normalizeConfig(detail.signin_config);
    let next = clone(nextBase);
    for (const section of SECTIONS) {
      if (reset.includes(section)) continue;
      for (const key of SECTION_KEYS[section]) {
        for (const path of leafDiff(previous[key], state.draft[key], key)) next = setIn(next, path, clone(getPath(state.draft, path)));
      }
    }
    // Edits made while a save was in flight stay, on top of what the server stored.
    if (overlay) {
      for (const key of SECTION_KEYS[overlay.section]) {
        for (const path of leafDiff(overlay.sent[key], state.draft[key], key)) next = setIn(next, path, clone(getPath(state.draft, path)));
      }
    }
    // Their details and my flow (or the other way round) may not fit together any more: the flow follows the details.
    const reconciled = reconcileFlow(next.flow, next);
    if (reconciled !== next.flow) next = { ...next, flow: reconciled };
    const resetKeys = reset.flatMap(section => SECTION_KEYS[section] as readonly string[]);
    const keepEdits = overlay ? SECTION_KEYS[overlay.section].flatMap(key => leafDiff(overlay.sent[key], state.draft[key], key)) : [];
    this.commit({
      ...state,
      base: nextBase,
      version: detail.config_version,
      stored: secretsStored(detail.signin_config),
      draft: next,
      secrets: reset.includes("signin") ? { ...NO_SECRETS } : state.secrets,
      touched: state.touched.filter(path => !resetKeys.some(key => under(path, key)) || keepEdits.some(edited => touches(edited, path))),
    });
  }

  /** Moves the draft onto a newer stored version and records, per tab, what someone else changed underneath. */
  private arrive(detail: AppDetail): void {
    const before = this.view;
    const fromVersion = before.version;
    const latest = normalizeConfig(detail.signin_config);
    const theirs = leafDiff(before.base, latest);
    const latestStored = secretsStored(detail.signin_config);
    if (latestStored.google !== before.stored.google) theirs.push("google.client_secret");
    if (latestStored.apple !== before.stored.apple) theirs.push("apple.private_key");
    // A setting the newer version holds exactly as this draft does is no news (for example this page's own save whose
    // answer was lost); read before the draft moves.
    const changedByThem = theirs.filter(path => SECRET_PATHS.has(path) || !deepEqual(getPath(latest, path), getPath(before.draft, path)));
    this.rebase(detail, []);
    const after = this.view;
    let sections = after.sections;
    for (const section of SECTIONS) {
      const mine = before.changes[section];
      const open = before.conflict[section];
      const notice = before.sections[section].notice;
      // Nothing of this tab is left unsaved (or never was): nothing to say.
      if (!mine.length || !after.changes[section].length) {
        sections = { ...sections, [section]: { ...sections[section], conflict: null, notice: null } };
        continue;
      }
      const overlap = mine.filter(path => changedByThem.some(other => touches(other, path)));
      if (overlap.length || open) {
        sections = {
          ...sections,
          [section]: {
            ...sections[section],
            notice: null,
            conflict: {
              fromVersion: open?.fromVersion ?? fromVersion,
              toVersion: detail.config_version,
              theirs: union(open?.theirs ?? [], changedByThem),
              mine: after.changes[section],
              overlap: union(open?.overlap ?? [], overlap),
            },
          },
        };
      } else if (changedByThem.length) {
        sections = {
          ...sections,
          [section]: {
            ...sections[section],
            notice: { fromVersion: notice?.fromVersion ?? fromVersion, toVersion: detail.config_version, theirs: union(notice?.theirs ?? [], changedByThem), saved: false },
          },
        };
      }
    }
    this.commit({ ...after, sections });
  }

  private keyFor(section: SectionKey, body: unknown): string {
    const signature = JSON.stringify(body);
    const current = this.keys[section];
    if (current && current.signature === signature) return current.key;
    const next = { signature, key: newIdempotencyKey() };
    this.keys[section] = next;
    return next.key;
  }

  private busy(): boolean {
    return SECTIONS.some(section => this.state.sections[section].pending);
  }

  private settle(): void {
    if (!this.deferred || this.busy()) return;
    const next = this.deferred;
    this.deferred = null;
    this.adopt(next);
  }

  /**
   * Saves a tab's changes. Resolves false when nothing was saved (problems, a conflict, a failure). Text typed into a
   * list field and not added is a problem here: the save bar first asks the fields to add it (commitTypedText), so
   * what is left could not be added and is never silently left out.
   */
  save = async (section: SectionKey, retried = false): Promise<boolean> => {
    const view = this.view;
    if (view.sections[section].pending) return false;
    if (view.conflict[section]) return false;
    const problems = { ...view.problems[section], ...typedProblems(view, section) };
    const count = Object.keys(problems).length;
    if (count) {
      this.patchSection(section, {
        attempted: true,
        error: new ApiError({
          status: 0,
          code: "validation_failed",
          message: `${count === 1 ? "One setting needs" : `${count} settings need`} fixing before this can be saved.`,
          hint: "Each problem is shown next to its setting.",
          details: { fields: problems },
        }),
      });
      return false;
    }
    const sent = clone(view.draft);
    const patch = sectionPatch(section, view.draft, view.base, view.secrets);
    if (!Object.keys(patch).length) return true;
    const body = { ...patch, expected_version: view.version };
    this.patchSection(section, { pending: true, error: undefined, serverFields: {}, attempted: false });
    let saved = false;
    let retry = false;
    try {
      const detail = await api.apps.updateSigninConfig(this.appId, body, { idempotencyKey: this.keyFor(section, body) });
      this.keys[section] = null;
      const notice = this.view.sections[section].notice;
      this.rebase(detail, [section], { section, sent });
      this.patchSection(section, { pending: false, savedAt: Date.now(), conflict: null, notice: retried && notice ? { ...notice, saved: true } : null });
      this.hooks.onStored(detail);
      saved = true;
    } catch (raw) {
      const error = ApiError.from(raw);
      if (error.code !== "config_version_conflict") {
        this.patchSection(section, { pending: false, error, serverFields: error.fields });
      } else {
        let latest: AppDetail | undefined;
        try {
          latest = await api.apps.get(this.appId);
        } catch {
          latest = undefined;
        }
        this.patchSection(section, { pending: false });
        if (!latest || latest.config_version <= this.view.version) {
          // The newer version could not be read: say so; Save tries again.
          this.patchSection(section, { error });
        } else {
          this.arrive(latest);
          this.hooks.onStored(latest);
          // Nothing of theirs touches this tab's changes: Save asked for them, so they go on top once more.
          retry = !retried && !this.view.conflict[section] && this.view.changes[section].length > 0;
        }
      }
    }
    if (retry) return this.save(section, true);
    this.settle();
    return saved;
  };

  /** Puts a tab back to the stored config. */
  discard = (section: SectionKey): void => {
    const state = this.state;
    let draft = state.draft;
    for (const key of SECTION_KEYS[section]) draft = { ...draft, [key]: clone(state.base[key]) };
    this.commit({
      ...state,
      draft,
      secrets: section === "signin" ? { ...NO_SECRETS } : state.secrets,
      touched: state.touched.filter(path => sectionOf(path) !== section),
      typed: Object.fromEntries(Object.entries(state.typed).filter(([path]) => sectionOf(path) !== section)),
      sections: { ...state.sections, [section]: { ...state.sections[section], error: undefined, serverFields: {}, conflict: null, notice: null, attempted: false } },
    });
  };

  /** Resolves a tab's conflict: save its changes on top of the newer version, or drop them and keep theirs. */
  resolveConflict = async (section: SectionKey, choice: "mine" | "theirs"): Promise<void> => {
    if (!this.state.sections[section].conflict) return;
    // The draft already sits on the newer version: theirs is the stored config, mine is the draft.
    if (choice === "theirs") {
      this.discard(section);
      return;
    }
    this.patchSection(section, { conflict: null, notice: null });
    await this.save(section);
  };

  dismissNotice = (section: SectionKey): void => this.patchSection(section, { notice: null });

  /** The app was read again: adopt a newer config version (see the module comment). Older reads are ignored. */
  adopt = (detail: AppDetail): void => {
    const state = this.state;
    if (this.busy()) {
      if (!this.deferred || detail.config_version >= this.deferred.config_version) this.deferred = detail;
      return;
    }
    // A read that started before this page's last save can finish after it: never go back to an older version.
    if (detail.config_version < state.version) return;
    if (detail.config_version === state.version) {
      const stored = secretsStored(detail.signin_config);
      if (stored.google !== state.stored.google || stored.apple !== state.stored.apple) this.commit({ ...state, stored });
      return;
    }
    this.arrive(detail);
  };

  /** Restores values from the version history into the draft (never saved by itself). */
  restore(values: Array<{ path: string; value: unknown }>): void {
    if (!values.length) return;
    this.editMany(Object.fromEntries(values.map(entry => [entry.path, entry.value === undefined ? null : clone(entry.value)])));
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Registry and React binding                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

const editors = new Map<string, ConfigEditor>();
/** The registry's subscription to each editor it holds (for the unload guard). */
const watching = new Map<ConfigEditor, () => void>();
let guarding = false;

function askBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Older browsers show the question only when returnValue is set.
  event.returnValue = "";
}

/**
 * Reloading or closing the browser tab asks first while any draft holds unsaved changes: the one on screen, or one
 * kept after leaving its app (from any page of the site, until it is saved, discarded or the tab is gone).
 */
function syncUnloadGuard(): void {
  if (typeof window === "undefined") return;
  const dirty = [...editors.values()].some(editor => editor.getView().anyDirty);
  if (dirty === guarding) return;
  guarding = dirty;
  if (dirty) window.addEventListener("beforeunload", askBeforeUnload);
  else window.removeEventListener("beforeunload", askBeforeUnload);
}

/** The editor of an app: the one kept from an earlier visit (with its unsaved draft), else a new one. */
export function obtainEditor(appId: string, detail: AppDetail): ConfigEditor {
  return editors.get(appId) ?? new ConfigEditor(appId, detail);
}

/** The app's page shows this editor (call it when the page mounts): it is the app's draft until the page goes away. */
export function retainEditor(editor: ConfigEditor): void {
  editors.set(editor.appId, editor);
  if (!watching.has(editor)) watching.set(editor, editor.subscribe(syncUnloadGuard));
  syncUnloadGuard();
}

/**
 * The app's page went away: keep its editor while it holds unsaved changes (or a save in flight), else drop it.
 * Returns true when it kept unsaved changes (the page then says where they are).
 */
export function releaseEditor(editor: ConfigEditor): boolean {
  const view = editor.getView();
  const busy = SECTIONS.some(section => view.sections[section].pending);
  if (view.anyDirty || busy) {
    editors.set(editor.appId, editor);
    return view.anyDirty;
  }
  if (editors.get(editor.appId) === editor) editors.delete(editor.appId);
  watching.get(editor)?.();
  watching.delete(editor);
  syncUnloadGuard();
  return false;
}

/** The editor's current view; re-renders on every change. */
export function useEditor(editor: ConfigEditor): EditorView {
  return useSyncExternalStore(editor.subscribe, editor.getView, editor.getView);
}

/** The messages for one field path and everything under it (`redirect_uris` also collects `redirect_uris[2]`). */
export function messagesUnder(fields: Record<string, string>, prefix: string): string[] {
  return Object.entries(fields).filter(([path]) => under(path, prefix)).map(([, message]) => message);
}

/** The first message for a path (or under it), or undefined. */
export function messageFor(fields: Record<string, string>, prefix: string): string | undefined {
  return messagesUnder(fields, prefix)[0];
}
