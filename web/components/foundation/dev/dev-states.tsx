"use client";

/**
 * The dev states panel (Anil, 2026-10-31), development only: a small round button at the account shell's lower right,
 * with a dot when any variable is set, opens a compact panel: each variable in lib/dev-states.ts (account, Silicon
 * requests, devices, Silicons, apps, network) as a small label over a one-row segmented control, presets that set a
 * whole scenario at once (Just joined), Reset in the header and "Show introduction again" at the foot. A change is kept
 * in this browser and the page reloads, so every block reads it fresh. "Inspect type" (or ⌥I) turns on the type
 * inspector (./type-inspector.tsx) and closes the panel, so the page is free to hover; it isn't kept across reloads.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Crosshair, FlaskConical } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@teamofsilicons/silicon-ui/popover";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { Switch } from "@teamofsilicons/silicon-ui/switch";
import { DEV_PRESETS, DEV_VARIABLES, devStatesInUse, readDevStates, writeDevStates, type DevStates } from "@/lib/dev-states";
import { TypeInspector } from "./type-inspector";
import styles from "./dev-states.module.css";

const subscribeNothing = () => () => undefined;
/** The introduction's dismissed flag (components/account/home-cards.tsx). */
const INTRO_KEY = "accounts.home.welcome-dismissed";

export function DevStatesPanel() {
  const saved = useSyncExternalStore(subscribeNothing, () => JSON.stringify(readDevStates()), () => "{}");
  const [open, setOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const stopInspecting = useCallback(() => setInspecting(false), []);

  // ⌥I toggles the inspector from anywhere: an open dialog blocks the flask button, and dialogs have type to inspect too.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!event.altKey || event.code !== "KeyI") return;
      event.preventDefault();
      setOpen(false);
      setInspecting(on => !on);
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, []);
  const states = JSON.parse(saved) as DevStates;
  const inUse = devStatesInUse(states);

  const apply = (next: DevStates) => {
    writeDevStates(next);
    window.location.reload();
  };
  const forgetIntro = () => {
    try {
      window.localStorage.removeItem(INTRO_KEY);
    } catch {
      // Storage blocked: nothing was remembered.
    }
  };
  const showIntro = () => {
    forgetIntro();
    window.location.reload();
  };
  const preset = (choice: (typeof DEV_PRESETS)[number]) => {
    if (choice.showIntro) forgetIntro();
    apply(choice.states);
  };

  return (
    <div className={styles.dock} data-type-inspect-exempt="">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="soft" size="sm" className={styles.trigger} aria-label={inUse ? `Dev states, ${inUse} set` : "Dev states"}>
            <FlaskConical size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        {inspecting ? <span className={styles.dot} aria-hidden="true"><Crosshair size={12} strokeWidth={2} /></span> : inUse ? <span className={styles.dot} aria-hidden="true">{inUse}</span> : null}
        <PopoverContent side="top" align="end" sideOffset={8} className={styles.panel} data-type-inspect-exempt="">
          <div className={styles.head}>
            <p className={styles.title}>Dev states</p>
            {inUse ? <Button variant="ghost" size="xs" onClick={() => apply({})}>Reset</Button> : <span className={styles.hint}>All real</span>}
          </div>
          <div className={styles.presets}>
            {DEV_PRESETS.map(choice => (
              <Button key={choice.key} variant="soft" size="xs" onClick={() => preset(choice)}>{choice.label}</Button>
            ))}
          </div>
          <div className={styles.fields}>
            {DEV_VARIABLES.map(variable => (
              <div key={variable.key} className={styles.field}>
                <span className={styles.label}>{variable.label}</span>
                <SegmentedControl
                  size="xs"
                  label={variable.label}
                  className={styles.control}
                  options={variable.options}
                  value={states[variable.key] ?? variable.options[0]?.value ?? "real"}
                  onValueChange={value => apply({ ...states, [variable.key]: value })}
                />
              </div>
            ))}
          </div>
          <div className={styles.inspect}>
            <Switch
              label="Inspect type (⌥I)"
              checked={inspecting}
              onCheckedChange={on => {
                setInspecting(on);
                if (on) setOpen(false);
              }}
            />
          </div>
          <div className={styles.foot}>
            <Button variant="ghost" size="xs" onClick={showIntro}>Show introduction again</Button>
          </div>
        </PopoverContent>
      </Popover>
      {inspecting ? <TypeInspector onExit={stopInspecting} /> : null}
    </div>
  );
}
