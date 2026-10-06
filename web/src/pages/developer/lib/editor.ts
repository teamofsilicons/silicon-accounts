/**
 * One draft of an app's sign-in config, shared by the Sign-in and Branding tabs so switching tabs never loses an edit.
 * Each tab saves only the keys it owns, with `expected_version`, so two people (or two tabs) cannot silently overwrite
 * each other.
 *
 * Whenever a newer stored version shows up (a 409 `config_version_conflict` on save, or the app read again after a
 * webhook change or an import), the draft moves onto it at once, leaf by leaf (the same rule the server's history
 * uses): every leaf a tab changed and has not saved stays on top. What happens next depends on whose changes touch
 * what, per tab:
 *  - none of the other changes touches this tab's changes: they stay on top and the tab says what changed underneath
 *    (after a 409 they are saved on top at once, since that is what Save asked for);
 *  - both changed the same setting to different values: the tab holds a conflict and its Save waits until the Carbon
 *    picks "Save mine on top" or "Discard mine, load theirs". One tab's choice never decides for the other tab.
 */
import { batch, createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store";
import { api, ApiError, type AppDetail } from "../../../api";
import { NO_SECRETS, SECTION_KEYS, normalizeConfig, secretsChanged, secretsStored, sectionPatch, type EditableConfig, type SecretsDraft, type SectionKey } from "./config";
import { actionKey } from "./keys";
import { clone, deepEqual, getPath, leafDiff, setPath, under } from "./paths";
import { brandingProblems, signinProblems } from "./validate";

const SECTIONS = ["signin", "branding"] as const;
/** Secrets are never read back, so changing one on both sides always counts as a conflict. */
const SECRET_PATHS = new Set(["google.client_secret", "apple.private_key"]);

const touches = (a: string, b: string) => under(a, b) || under(b, a);
const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

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
  /** Someone else changed what this tab changed: saving waits for a choice (see `ConfigEditor.conflict`). */
  conflict: ConflictInfo | null;
  notice: VersionNotice | null;
  savedAt: number | null;
  /** True after a save was attempted while local problems existed (shows them prominently). */
  attempted: boolean;
}

const idle = (): SectionState => ({ pending: false, error: undefined, serverFields: {}, conflict: null, notice: null, savedAt: null, attempted: false });

export interface ConfigEditor {
  draft: EditableConfig;
  setDraft: SetStoreFunction<EditableConfig>;
  secrets: SecretsDraft;
  setSecrets: SetStoreFunction<SecretsDraft>;
  /** The newest stored config this page knows (what the draft is based on). */
  base: Accessor<EditableConfig>;
  /** Its version: what the next save sends as `expected_version`. */
  version: Accessor<number>;
  /** Whether BYO secrets are stored. */
  stored: Accessor<{ google: boolean; apple: boolean }>;
  /** Leaf paths changed and not saved, per tab. */
  changes: (section: SectionKey) => string[];
  dirty: (section: SectionKey) => boolean;
  anyDirty: Accessor<boolean>;
  /** Local problems (mirrors of the server checks) by path. */
  problems: (section: SectionKey) => Record<string, string>;
  /** Local problems and the last server field errors, by path. */
  fieldErrors: (section: SectionKey) => Record<string, string>;
  /** The open version conflict of a tab: null when there is none, or once none of its settings is still changed. */
  conflict: (section: SectionKey) => ConflictInfo | null;
  state: Record<SectionKey, SectionState>;
  /** Saves a tab's changes. Resolves false when nothing was saved (problems, a conflict, a failure). */
  save: (section: SectionKey) => Promise<boolean>;
  discard: (section: SectionKey) => void;
  /** Resolves a tab's conflict: save its changes on top of the newer version, or drop them and keep theirs. */
  resolveConflict: (section: SectionKey, choice: "mine" | "theirs") => Promise<void>;
  dismissNotice: (section: SectionKey) => void;
  /** The app was read again: adopt a newer config version (see the module comment). Older reads are ignored. */
  adopt: (detail: AppDetail) => void;
}

export function createConfigEditor(options: { appId: string; initial: AppDetail; onStored: (detail: AppDetail) => void }): ConfigEditor {
  const [base, setBase] = createSignal<EditableConfig>(normalizeConfig(options.initial.signin_config));
  const [version, setVersion] = createSignal(options.initial.config_version);
  const [stored, setStored] = createSignal(secretsStored(options.initial.signin_config));
  const [draft, setDraft] = createStore<EditableConfig>(clone(base()));
  const [secrets, setSecrets] = createStore<SecretsDraft>({ ...NO_SECRETS });
  const [state, setState] = createStore<Record<SectionKey, SectionState>>({ signin: idle(), branding: idle() });
  // A retry of the same save (same body, same expected_version) reuses its key: if the first one went through and only
  // its answer was lost, the server replays it instead of answering with a conflict against this page's own save.
  const keys = { signin: actionKey(), branding: actionKey() };
  // A newer app read that arrived while a save was in flight; adopted once the save settles.
  let deferred: AppDetail | null = null;

  const changeMemos: Record<SectionKey, Accessor<string[]>> = {
    signin: createMemo(() => [...SECTION_KEYS.signin.flatMap(key => leafDiff(base()[key], draft[key], key)), ...secretsChanged(secrets, draft)]),
    branding: createMemo(() => leafDiff(base().branding, draft.branding, "branding")),
  };
  const problemMemos: Record<SectionKey, Accessor<Record<string, string>>> = {
    signin: createMemo(() => signinProblems(draft, {
      googleSecret: secrets.googleSecret,
      googleSecretStored: stored().google,
      googleRemove: secrets.googleRemove,
      appleKey: secrets.appleKey,
      appleKeyStored: stored().apple,
      appleRemove: secrets.appleRemove,
    })),
    branding: createMemo(() => brandingProblems(draft.branding)),
  };
  const openConflict = (section: SectionKey): ConflictInfo | null => {
    const conflict = state[section].conflict;
    if (!conflict) return null;
    const mine = changeMemos[section]();
    return conflict.overlap.some(path => mine.some(changed => touches(changed, path))) ? conflict : null;
  };
  const conflictMemos: Record<SectionKey, Accessor<ConflictInfo | null>> = {
    signin: createMemo(() => openConflict("signin")),
    branding: createMemo(() => openConflict("branding")),
  };

  // A validation failure describes what was sent (or tried); once that part changes again it no longer applies. Field
  // problems that remain still show next to their fields and in the save bar.
  for (const section of SECTIONS) {
    createEffect(on(changeMemos[section], () => {
      if (Object.keys(state[section].serverFields).length) setState(section, "serverFields", {});
      if (state[section].error?.code === "validation_failed") setState(section, { error: undefined, attempted: false });
    }, { defer: true }));
  }

  /** The new stored config, with unsaved leaves of the sections not in `reset` re-applied on top. */
  const rebase = (detail: AppDetail, reset: SectionKey[], overlay?: { section: SectionKey; sent: EditableConfig }) => {
    const previous = base();
    const nextBase = normalizeConfig(detail.signin_config);
    const next = clone(nextBase) as unknown as Record<string, unknown>;
    for (const section of SECTIONS) {
      if (reset.includes(section)) continue;
      for (const key of SECTION_KEYS[section]) {
        for (const path of leafDiff(previous[key], draft[key], key)) setPath(next, path, clone(getPath(draft, path)));
      }
    }
    // Edits made while a save was in flight stay, on top of what the server stored.
    if (overlay) {
      for (const key of SECTION_KEYS[overlay.section]) {
        for (const path of leafDiff(overlay.sent[key], draft[key], key)) setPath(next, path, clone(getPath(draft, path)));
      }
    }
    batch(() => {
      setBase(nextBase);
      setVersion(detail.config_version);
      setStored(secretsStored(detail.signin_config));
      setDraft(reconcile(next as unknown as EditableConfig));
      if (reset.includes("signin")) setSecrets({ ...NO_SECRETS });
    });
  };

  /** Moves the draft onto a newer stored version and records, per tab, what someone else changed underneath. */
  const arrive = (detail: AppDetail) => {
    const fromVersion = version();
    const latest = normalizeConfig(detail.signin_config);
    const theirs = leafDiff(base(), latest);
    const latestStored = secretsStored(detail.signin_config);
    if (latestStored.google !== stored().google) theirs.push("google.client_secret");
    if (latestStored.apple !== stored().apple) theirs.push("apple.private_key");
    // A setting the newer version holds exactly as this draft does is no news (for example this page's own save whose
    // answer was lost); read before the draft moves.
    const changedByThem = theirs.filter(path => SECRET_PATHS.has(path) || !deepEqual(getPath(latest, path), getPath(draft, path)));
    const before = {
      signin: { mine: changeMemos.signin(), open: conflictMemos.signin(), notice: state.signin.notice },
      branding: { mine: changeMemos.branding(), open: conflictMemos.branding(), notice: state.branding.notice },
    };
    rebase(detail, []);
    batch(() => {
      for (const section of SECTIONS) {
        const { mine, open, notice } = before[section];
        // Nothing of this tab is left unsaved (or never was): nothing to say.
        if (!mine.length || !changeMemos[section]().length) {
          setState(section, { conflict: null, notice: null });
          continue;
        }
        const overlap = mine.filter(path => changedByThem.some(other => touches(other, path)));
        if (overlap.length || open) {
          setState(section, {
            notice: null,
            conflict: {
              fromVersion: open?.fromVersion ?? fromVersion,
              toVersion: detail.config_version,
              theirs: union(open?.theirs ?? [], changedByThem),
              mine: changeMemos[section](),
              overlap: union(open?.overlap ?? [], overlap),
            },
          });
        } else if (changedByThem.length) {
          setState(section, {
            notice: {
              fromVersion: notice?.fromVersion ?? fromVersion,
              toVersion: detail.config_version,
              theirs: union(notice?.theirs ?? [], changedByThem),
              saved: false,
            },
          });
        }
      }
    });
  };

  const settle = () => {
    if (!deferred || state.signin.pending || state.branding.pending) return;
    const next = deferred;
    deferred = null;
    adopt(next);
  };

  const save = async (section: SectionKey, retried = false): Promise<boolean> => {
    if (state[section].pending) return false;
    if (conflictMemos[section]()) return false;
    const problems = problemMemos[section]();
    if (Object.keys(problems).length) {
      const count = Object.keys(problems).length;
      setState(section, {
        attempted: true,
        error: new ApiError({
          status: 0,
          code: "validation_failed",
          message: `${count === 1 ? "One field needs" : `${count} fields need`} fixing before this can be saved.`,
          hint: "Each problem is shown next to its field.",
          details: { fields: problems },
        }),
      });
      return false;
    }
    const sent = clone(draft);
    const patch = sectionPatch(section, draft, base(), secrets);
    if (!Object.keys(patch).length) return true;
    const body = { ...patch, expected_version: version() };
    setState(section, { pending: true, error: undefined, serverFields: {}, attempted: false });
    let saved = false;
    let retry = false;
    try {
      const detail = await api.apps.updateSigninConfig(options.appId, body, { idempotencyKey: keys[section].for(JSON.stringify(body)) });
      keys[section].done();
      rebase(detail, [section], { section, sent });
      const notice = state[section].notice;
      setState(section, { pending: false, savedAt: Date.now(), conflict: null, notice: retried && notice ? { ...notice, saved: true } : null });
      options.onStored(detail);
      saved = true;
    } catch (raw) {
      const error = ApiError.from(raw);
      if (error.code !== "config_version_conflict") {
        setState(section, { pending: false, error, serverFields: error.fields });
      } else {
        let latest: AppDetail | undefined;
        try {
          latest = await api.apps.get(options.appId);
        } catch {
          latest = undefined;
        }
        setState(section, { pending: false });
        if (!latest || latest.config_version <= version()) {
          // The newer version could not be read: say so; Save tries again.
          setState(section, { error });
        } else {
          arrive(latest);
          options.onStored(latest);
          // Nothing of theirs touches this tab's changes: Save asked for them, so they go on top once more.
          retry = !retried && !conflictMemos[section]() && changeMemos[section]().length > 0;
        }
      }
    }
    if (retry) return save(section, true);
    settle();
    return saved;
  };

  const discard = (section: SectionKey) => {
    const stored = base();
    batch(() => {
      for (const key of SECTION_KEYS[section]) (setDraft as (key: string, value: unknown) => void)(key, clone(stored[key]));
      if (section === "signin") setSecrets({ ...NO_SECRETS });
      setState(section, { error: undefined, serverFields: {}, conflict: null, notice: null, attempted: false });
    });
  };

  const resolveConflict = async (section: SectionKey, choice: "mine" | "theirs") => {
    if (!state[section].conflict) return;
    // The draft already sits on the newer version: theirs is the stored config, mine is the draft.
    if (choice === "theirs") {
      discard(section);
      return;
    }
    setState(section, { conflict: null, notice: null });
    await save(section);
  };

  const adopt = (detail: AppDetail) => {
    if (state.signin.pending || state.branding.pending) {
      if (!deferred || detail.config_version >= deferred.config_version) deferred = detail;
      return;
    }
    // A read that started before this page's last save can finish after it: never go back to an older version.
    if (detail.config_version < version()) return;
    if (detail.config_version === version()) {
      setStored(secretsStored(detail.signin_config));
      return;
    }
    arrive(detail);
  };

  return {
    draft,
    setDraft,
    secrets,
    setSecrets,
    base,
    version,
    stored,
    changes: section => changeMemos[section](),
    dirty: section => changeMemos[section]().length > 0,
    anyDirty: () => changeMemos.signin().length > 0 || changeMemos.branding().length > 0,
    problems: section => problemMemos[section](),
    fieldErrors: section => ({ ...problemMemos[section](), ...state[section].serverFields }),
    conflict: section => conflictMemos[section](),
    state,
    save: section => save(section),
    discard,
    resolveConflict,
    dismissNotice: section => setState(section, "notice", null),
    adopt,
  };
}

/** The messages for one field path and everything under it (`redirect_uris` also collects `redirect_uris[2]`). */
export function messagesUnder(fields: Record<string, string>, prefix: string): string[] {
  return Object.entries(fields).filter(([path]) => under(path, prefix)).map(([, message]) => message);
}

/** The first message for a path (or under it), or null. */
export function messageFor(fields: Record<string, string>, prefix: string): string | null {
  return messagesUnder(fields, prefix)[0] ?? null;
}
