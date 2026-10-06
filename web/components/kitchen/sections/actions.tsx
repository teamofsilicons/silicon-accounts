"use client";

import { useState } from "react";
import { ArrowRight, Copy, KeyRound, LogOut, Pencil, Settings, Trash2 } from "lucide-react";
import { ActionButton } from "@/components/arc/action-button/action-button";
import { Button } from "@/components/arc/button/button";
import { ConfirmMorph } from "@/components/arc/confirm-morph/confirm-morph";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { DropdownMenu } from "@/components/arc/dropdown-menu/dropdown-menu";
import { HoldToConfirm } from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { ThemeSwitch } from "@/components/arc/theme-switch/theme-switch";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import { ButtonLink } from "@/components/foundation/button-link";
import { useTheme } from "@/components/foundation/theme/use-theme";
import { Specimen, Specimens, kitchenStyles as styles } from "../specimen";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const icon = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

export function Actions() {
  const [label, setLabel] = useState("Save changes");
  const [confirmed, setConfirmed] = useState(false);
  const { theme, change } = useTheme();
  return (
    <Specimens>
      <Specimen title="Button: one primary per surface">
        <div className={styles.row}>
          <Button onClick={() => setLabel(current => (current === "Save changes" ? "Saved" : "Save changes"))}>{label}</Button>
          <Button variant="secondary">Add an email</Button>
          <Button variant="ghost">Cancel</Button>
        </div>
        <div className={styles.row}>
          <Button variant="danger">Remove access</Button>
          <Button loading>Saving</Button>
          <Button variant="secondary" disabled>Not yet</Button>
        </div>
        <div className={styles.row}>
          <Button size="sm" variant="secondary">Small</Button>
          <Button size="lg">Create a Silicon<ArrowRight {...icon} /></Button>
          <ButtonLink href="#actions" variant="ghost">A link that looks like a button</ButtonLink>
        </div>
      </Specimen>
      <Specimen title="ActionButton and CopyButton">
        <div className={styles.row}>
          <ActionButton label="Save profile" pendingLabel="Saving" successLabel="Saved" onAction={() => wait(900)} />
        </div>
        <div className={styles.row}>
          <CopyButton value="c:saket" label="Copy id" />
          <CopyButton value="a8K" label="Copy uuid" iconOnly />
          <CopyButton value="stk-3f9a1c0b7e24" label="Copy STK" variant="plain" />
        </div>
      </Specimen>
      <Specimen title="ConfirmMorph and HoldToConfirm: destructive actions">
        <div className={styles.row}>
          <ConfirmMorph label="Remove access" prompt="Remove Briefcase's access?" confirmLabel="Remove" pendingLabel="Removing" doneLabel="Removed" icon={<Trash2 {...icon} />} onConfirm={() => wait(900)} />
        </div>
        <div className={styles.row}>
          <ConfirmMorph label="Revoke proof" tone="neutral" confirmLabel="Revoke" doneLabel="Revoked" onConfirm={() => wait(800).then(() => Promise.reject(new Error("The proof was already revoked.")))} />
        </div>
        <div className={styles.row}>
          <HoldToConfirm label="Hold to rotate the STK" confirmedLabel="Rotated" tone="danger" confirmed={confirmed} icon={<KeyRound size={18} strokeWidth={1.75} aria-hidden />} onConfirm={() => { setConfirmed(true); setTimeout(() => setConfirmed(false), 2400); }} />
        </div>
      </Specimen>
      <Specimen title="DropdownMenu, Tooltip and Popover">
        <div className={styles.row}>
          <DropdownMenu
            label="Manage"
            items={[
              { label: "Edit details", icon: <Pencil {...icon} /> },
              { label: "Copy si:id", icon: <Copy {...icon} /> },
              { label: "Settings", icon: <Settings {...icon} /> },
              { label: "Delete Silicon", icon: <Trash2 {...icon} />, destructive: true, separatorBefore: true },
            ]}
          />
          <Tooltip content="Signs this browser out">
            <Button variant="secondary" aria-label="Sign out"><LogOut {...icon} /></Button>
          </Tooltip>
          <Popover>
            <PopoverTrigger asChild><Button variant="secondary">What is a uuid?</Button></PopoverTrigger>
            <PopoverContent>
              <p className={styles.prose}>Your uuid never changes. Apps store it; your c:id is only what people see, and you can change it.</p>
            </PopoverContent>
          </Popover>
        </div>
      </Specimen>
      {/* Single: the switch marks itself with the page theme (data-theme), which would repaint a dark pane light. */}
      <Specimen title="ThemeSwitch: the eclipse spreads from the switch" single>
        <div className={styles.row}>
          <ThemeSwitch theme={theme} variant="eclipse" onThemeChange={(next, _variant, trigger) => change(next, trigger)} />
          <ThemeSwitch theme={theme} variant="eclipse" iconOnly onThemeChange={(next, _variant, trigger) => change(next, trigger)} />
        </div>
      </Specimen>
    </Specimens>
  );
}
