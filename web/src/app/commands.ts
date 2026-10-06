/**
 * The ⌘K command palette's registry. The shell registers navigation, theme and account commands; any page can add
 * its own while it is mounted:
 *
 *   registerCommands(() => [{ id: "silicons.create", label: "Create a Silicon", group: "Silicons", run: openCreate }]);
 *
 * Commands registered from a component are removed when it unmounts.
 */
import { createRoot, createSignal, getOwner, onCleanup, type Accessor } from "solid-js";
import type { CommandItem } from "../arc/command-palette/command-palette";

export type ShellCommand = CommandItem;

const state = createRoot(() => {
  const [sources, setSources] = createSignal<Array<{ id: number; read: Accessor<ShellCommand[]> }>>([]);
  const [open, setOpen] = createSignal(false);
  return { sources, setSources, open, setOpen };
});

let nextId = 0;

/**
 * Adds commands for as long as the calling component lives (or until the returned function is called). Pass an
 * accessor to keep labels and availability reactive.
 */
export function registerCommands(commands: ShellCommand[] | Accessor<ShellCommand[]>): () => void {
  const id = ++nextId;
  const read: Accessor<ShellCommand[]> = typeof commands === "function" ? commands : () => commands;
  state.setSources(list => [...list, { id, read }]);
  const dispose = () => state.setSources(list => list.filter(entry => entry.id !== id));
  if (getOwner()) onCleanup(dispose);
  return dispose;
}

/** Every registered command, later registrations first within a group so page commands lead. */
export function allCommands(): ShellCommand[] {
  const seen = new Set<string>();
  const out: ShellCommand[] = [];
  for (const source of [...state.sources()].reverse()) {
    for (const command of source.read()) {
      if (seen.has(command.id)) continue;
      seen.add(command.id);
      out.push(command);
    }
  }
  return out;
}

export const commandPaletteOpen: Accessor<boolean> = state.open;
export const openCommandPalette = (): void => {
  state.setOpen(true);
};
export const closeCommandPalette = (): void => {
  state.setOpen(false);
};
export const toggleCommandPalette = (): void => {
  state.setOpen(value => !value);
};
