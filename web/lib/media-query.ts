/**
 * Subscribing to a media query (prefers-reduced-motion and the like) in every browser: MediaQueryList's
 * addEventListener arrived in Safari 14; older Safari only has the deprecated addListener. Server rendering and a
 * browser without matchMedia get `fallback`.
 */
export function mediaMatches(query: string, fallback = false): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return fallback;
  return window.matchMedia(query).matches;
}

export function subscribeMedia(query: string, change: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const list = window.matchMedia(query);
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }
  const legacy = list as MediaQueryList & { addListener?: (listener: () => void) => void; removeListener?: (listener: () => void) => void };
  legacy.addListener?.(change);
  return () => legacy.removeListener?.(change);
}
