import { createSignal, onCleanup } from "solid-js";

export type CopyFeedbackState = "idle" | "copied" | "error";

/** Copies text to the clipboard with a fallback for browsers without the async Clipboard API. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path (permissions, insecure context).
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    Object.assign(area.style, { position: "fixed", top: "-1000px", opacity: "0" });
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Shared clipboard state for actions that render their own button or menu (Arc useCopyFeedback). */
export function createCopyFeedback(duration = 1900) {
  const [state, setState] = createSignal<CopyFeedbackState>("idle");
  const [activeKey, setActiveKey] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    setState("idle");
    setActiveKey(null);
  };
  onCleanup(() => timer && clearTimeout(timer));
  const copy = async (value: string, key = "default") => {
    if (timer) clearTimeout(timer);
    setActiveKey(key);
    const ok = await copyText(value);
    setState(ok ? "copied" : "error");
    timer = setTimeout(reset, duration);
    return ok;
  };
  return { state, activeKey, copy, reset };
}
