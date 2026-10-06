/**
 * The ⌘K command palette: Arc's command-palette block in a modal layer. Commands come from the registry
 * (src/app/commands.ts): the shell's navigation, theme and account commands plus whatever the current page adds.
 */
import { Dialog as K } from "@kobalte/core/dialog";
import { CommandPalette } from "../../arc/command-palette/command-palette";
import { allCommands, closeCommandPalette, commandPaletteOpen, openCommandPalette } from "../commands";
import styles from "./shell.module.css";

export function CommandMenu() {
  return (
    <K open={commandPaletteOpen()} onOpenChange={open => (open ? openCommandPalette() : closeCommandPalette())} modal preventScroll>
      <K.Portal>
        <K.Overlay class={styles.paletteOverlay} />
        <div class={styles.palettePositioner}>
          <K.Content class={styles.palettePanel} aria-label="Search and jump">
            <K.Title class="sr-only">Search and jump</K.Title>
            <CommandPalette
              items={allCommands()}
              placeholder="Search pages and actions"
              label="Search pages and actions"
              autoFocus
              hideHotkey
              onClose={closeCommandPalette}
              onSelect={() => closeCommandPalette()}
            />
          </K.Content>
        </div>
      </K.Portal>
    </K>
  );
}
