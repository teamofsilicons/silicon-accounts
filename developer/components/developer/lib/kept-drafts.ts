/**
 * Where a kept draft is. Leaving an app with unsaved changes (Back, the command palette, "Leave, keep the draft")
 * keeps its sign-in setup draft in this browser tab (lib/editor.ts); a notice on the page that comes next says so and
 * offers the way back. It stays until the Carbon returns to the app or closes it; reloading or closing the browser tab
 * asks first meanwhile (the editor registry's unload guard).
 */
import { notify } from "@/lib/notify";
import { SECTIONS, SECTION_LABEL } from "./config";
import type { EditorView } from "./editor";

/** The open notice per app id. */
const notices = new Map<string, string>();

/** "Sign-in", "Pages" or "Sign-in and Pages": the save groups a draft changed ("" when none). */
export function draftSections(view: Pick<EditorView, "dirty">): string {
  const names = SECTIONS.filter(section => view.dirty[section]).map(section => SECTION_LABEL[section]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
}

/** Says that the app's draft is kept, with "Return" to go back to it. */
export function announceKeptDraft(appId: string, draft: { name: string; sections: string; open: () => void }): void {
  forgetKeptDraft(appId);
  const id = notify.info(`Unsaved draft of ${draft.name}`, `Your ${draft.sections} changes are kept in this browser tab until you save or discard them.`);
  notify.update(id, {
    duration: Infinity,
    action: {
      label: "Return",
      onClick: () => {
        notices.delete(appId);
        draft.open();
      },
    },
  });
  notices.set(appId, id);
}

/** The Carbon is back at the app (or the draft is gone): the notice leaves. */
export function forgetKeptDraft(appId: string): void {
  const id = notices.get(appId);
  if (!id) return;
  notices.delete(appId);
  notify.dismiss(id);
}
