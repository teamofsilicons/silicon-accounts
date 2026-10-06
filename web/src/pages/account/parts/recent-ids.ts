/**
 * The si:ids this tab saw a custodian change away from, per Silicon. A changed id stays reserved for its previous owner
 * for 10 days, and the custodian may take it back for the Silicon. `GET /v1/ids/available` answers with the
 * custodian's session, so it reports the Silicon's reservation as "reserved" (someone else's) rather than
 * "reclaimable"; remembering the ids changed here lets the drawer say for certain that an id was this Silicon's.
 * Ids changed elsewhere (another tab, the CLI) are not known here, and the drawer still offers to take them back,
 * letting the service decide. Kept in memory only; it describes this tab's own actions.
 */
import { createRoot, createSignal } from "solid-js";

const store = createRoot(() => {
  const [previous, setPrevious] = createSignal<Record<string, string[]>>({});
  return { previous, setPrevious };
});

/** Records that the Silicon `uuid` changed from `from` to `to` (a take-back removes `to` from its old ids). */
export function rememberIdChange(uuid: string, from: string | null, to: string): void {
  store.setPrevious(all => {
    const ids = (all[uuid] ?? []).filter(id => id !== to.toLowerCase());
    if (from && !ids.includes(from.toLowerCase())) ids.push(from.toLowerCase());
    return { ...all, [uuid]: ids };
  });
}

/** True when this tab changed the Silicon `uuid` away from `id` (so the reservation on it is the Silicon's own). */
export function wasIdOf(uuid: string, id: string): boolean {
  return (store.previous()[uuid] ?? []).includes(id.toLowerCase());
}
