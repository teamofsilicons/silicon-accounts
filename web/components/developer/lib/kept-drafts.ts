/**
 * Where a kept draft is. Leaving an app with unsaved changes (Back, the command palette, "Leave, keep the draft")
 * keeps its sign-in setup draft in this browser tab (lib/editor.ts); a notice on the page that comes next says so and
 * offers the way back. It stays until the Carbon returns to the app or closes it; reloading or closing the browser tab
 * asks first meanwhile (the editor registry's unload guard).
 */
import { notify } from "@/lib/notify";
import type { EditorView } from "./editor";

/** The open notice per app id. */
const notices = new Map<string, string>();

/** "Sign-in", "Branding" or "Sign-in and Branding": the tabs a draft changed ("" when none). */
export function draftSections(view: Pick<EditorView, "dirty">): string {
  return [view.dirty.signin ? "Sign-in" : "", view.dirty.branding ? "Branding" : ""].filter(Boolean).join(" and ");
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
