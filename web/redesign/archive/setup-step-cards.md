# Finish setting up, step cards (archived 2026-10-31)

Home's Needs you block (components/account/home-needs.tsx) showed the checkup (components/account/parts/checkup.ts) as "Finish setting up": each step left as a small white card side by side (icon tile, title, short line, its action at the foot), the steps done as ticked lines under them, and "N of 4 left" with a short bar beside the title. Anil set it aside on 2026-10-31: setup isn't what Home should push now; the unused-device check moved into Needs you. To bring it back, restore the Checklist component and its styles from these files.

## home-needs.tsx

```tsx
"use client";

/**
 * Home's Needs you, under the greeting (Anil, 2026-10-30, picked in /__needs; designed for Home 2026-10-31):
 *
 * - Needs you: what is waiting on the Carbon, one row each (a Silicon asking them to be its custodian, with Decline and
 *   Review; a Carbon handing them a Silicon, with Review), shown only when something waits;
 * - Finish setting up: the prototype's security checkup (components/account/parts/checkup.ts), each step left as its
 *   own small white card with its action, the steps done as ticked lines under them, a bar counting them; gone once
 *   all four are done;
 * - "You're all set" when nothing waits and setup is done.
 *
 * Both are the introduction's soft grey tile, with white rows (Needs you) or white step cards (Finish setting up).
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { Progress } from "@teamofsilicons/silicon-ui/progress";
import { ButtonLink } from "@/components/foundation/button-link";
import type { CustodianRequest } from "@/lib/api/types";
import { paths } from "@/lib/navigation";
import { useDeclineCustodianRequest } from "@/lib/query/silicons";
import { useMe } from "@/lib/query/session";
import { NEEDS_YOU_ID } from "./parts/anchors";
import { STEP_ICON, checkupSteps, keepSession, readKept, subscribeKept, type Step } from "./parts/checkup";
import { asCarbon, describeError, msUntil, personLabel, spanText, useNow } from "./parts/common";
import { useEveryCustodianRequest, useEverySession, useSignOutSession } from "./parts/queries";
import { SiliconMark } from "./parts/silicon-mark";
import { RequestDeck } from "./silicons/request-deck";
import styles from "./home-needs.module.css";

const siliconName = (request: CustodianRequest) => request.silicon.display_name || request.silicon.id || "A Silicon";

export function HomeNeeds() {
  const me = useMe();
  const carbon = asCarbon(me.data);
  const requests = useEveryCustodianRequest();
  const sessions = useEverySession();
  const now = useNow(30_000);
  const kept = useSyncExternalStore(subscribeKept, readKept, () => "");
  if (!carbon) return null;

  // The requests are part of the answer: wait for them rather than say "all set" too early.
  if (!requests.data && !requests.error) return null;
  const waiting = requests.data?.items ?? [];
  const failed = !!requests.error && !requests.data;
  const steps = checkupSteps(carbon, sessions.data?.items, now, kept);
  const stepsLeft = steps.filter(step => !step.done).length;

  if (!waiting.length && !failed && !stepsLeft) {
    return (
      <p id={NEEDS_YOU_ID} data-sq="surface" className={styles.allClear} role="status">
        <Check size={16} strokeWidth={2} aria-hidden="true" />
        You&apos;re all set
        <span className={styles.allClearNote}>· nothing needs you right now</span>
      </p>
    );
  }

  return (
    <div id={NEEDS_YOU_ID} className={styles.group} tabIndex={-1}>
      {waiting.length || failed ? <Requests waiting={waiting} failed={failed} error={requests.error} retry={() => void requests.refetch()} now={now} /> : null}
      {stepsLeft ? <Checklist steps={steps} /> : null}
    </div>
  );
}

/* Needs you ------------------------------------------------------------------------------------------------------- */

function Requests({ waiting, failed, error, retry, now }: { waiting: CustodianRequest[]; failed: boolean; error: unknown; retry: () => void; now: number }) {
  const decline = useDeclineCustodianRequest();
  const [reviewing, setReviewing] = useState<CustodianRequest | null>(null);
  const [declining, setDeclining] = useState<CustodianRequest | null>(null);
  const count = waiting.length + (failed ? 1 : 0);
  const timeLeft = (request: CustodianRequest) => {
    const left = msUntil(request.expires_at, now);
    return left > 0 ? `${spanText(left)} left` : "Ends today";
  };

  return (
    <section data-sq="surface" className={styles.tile} aria-labelledby={`${NEEDS_YOU_ID}-title`}>
      <div className={styles.head}>
        <h2 id={`${NEEDS_YOU_ID}-title`} className={styles.title}>Needs you</h2>
        <Badge size="sm" tone="warning">{count}</Badge>
      </div>
      <ul data-sq="clip" className={styles.rows}>
        {failed ? (
          <Row lead={<span data-sq="surface" className={styles.icon} aria-hidden="true"><X size={16} strokeWidth={1.75} /></span>} title="Requests waiting for you did not load" detail={describeError(error)}>
            <Button variant="secondary" size="sm" onClick={retry}>Try again</Button>
          </Row>
        ) : null}
        {waiting.map(request => request.kind === "transfer" ? (
          <Row key={request.id} lead={<SiliconMark seed={request.silicon.uuid} size={36} />} title={`${personLabel(request.from)} is handing ${siliconName(request)} to you`} detail={timeLeft(request)}>
            <Button variant="primary" size="sm" onClick={() => setReviewing(request)}>Review</Button>
          </Row>
        ) : (
          <Row key={request.id} lead={<SiliconMark seed={request.silicon.uuid} size={36} pending />} title={`${siliconName(request)} wants you to look after it`} detail={timeLeft(request)}>
            <Button variant="secondary" size="sm" onClick={() => setDeclining(request)}>Decline</Button>
            <Button variant="primary" size="sm" onClick={() => setReviewing(request)}>Review</Button>
          </Row>
        ))}
      </ul>
      <Dialog open={!!reviewing} onOpenChange={open => { if (!open) setReviewing(null); }}>
        {reviewing ? (
          <DialogContent title={reviewing.kind === "transfer" ? `${personLabel(reviewing.from)} is handing ${siliconName(reviewing)} to you` : `${siliconName(reviewing)} wants you to look after it`} description="Each request lasts 14 days. A declined Silicon's account is released; a declined transfer changes nothing.">
            <RequestDeck requests={[reviewing]} now={now} onEmptied={() => setReviewing(null)} />
          </DialogContent>
        ) : null}
      </Dialog>
      <Dialog open={!!declining} onOpenChange={open => { if (!open) setDeclining(null); }}>
        {declining ? (
          <DialogContent title={`Decline ${siliconName(declining)}?`}>
            <p className={styles.dialogText}>
              It can&apos;t sign in anywhere, its account is removed, and <span className={styles.mono}>{declining.silicon.id ?? declining.silicon.uuid}</span> is free for anyone at once.
            </p>
            <div className={styles.dialogActions}>
              <Button variant="secondary" onClick={() => setDeclining(null)}>Cancel</Button>
              <Button variant="danger" loading={decline.isPending} onClick={() => void decline.mutateAsync(declining.id).then(() => setDeclining(null), () => undefined)}>Decline</Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}

/* Finish setting up ----------------------------------------------------------------------------------------------- */

function Checklist({ steps }: { steps: Step[] }) {
  const signOut = useSignOutSession();
  const left = steps.filter(step => !step.done);
  const done = steps.filter(step => step.done);
  return (
    <section data-sq="surface" className={styles.tile} aria-labelledby="home-setup-title">
      <div className={styles.head}>
        <h2 id="home-setup-title" className={styles.title}>Finish setting up</h2>
        <span className={styles.count}>{left.length} of {steps.length} left</span>
        {/* No label: the title and the count beside it say it, so the bar adds no words of its own. */}
        <Progress className={styles.bar} value={done.length} max={steps.length} />
      </div>
      <ul className={styles.steps}>
        {left.map(step => {
          const Icon = STEP_ICON[step.key];
          return (
            <li key={step.key} data-sq="surface" className={styles.step}>
              <span data-sq="surface" className={styles.icon} aria-hidden="true"><Icon size={16} strokeWidth={1.75} /></span>
              <span className={styles.text}>
                <span className={styles.rowTitle}>{step.title}</span>
                <span className={styles.stepDetail}>{step.detail}</span>
              </span>
              <span className={styles.stepActions}>
                {step.key === "devices" && step.stale ? (
                  <>
                    <Button variant="secondary" size="sm" loading={signOut.isPending} onClick={() => step.stale && void signOut.mutateAsync(step.stale.id).catch(() => undefined)}>Sign out</Button>
                    <Button variant="ghost" size="sm" onClick={() => step.stale && keepSession(step.stale.id)}>Keep</Button>
                  </>
                ) : (
                  <ButtonLink href={paths.signInMethods} variant="secondary" size="sm">{step.key === "provider" ? "Connect" : "Add"}</ButtonLink>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {done.length ? (
        <ul className={styles.done}>
          {done.map(step => (
            <li key={step.key} className={styles.doneItem}>
              <Check className={styles.doneTick} size={14} strokeWidth={2.25} aria-hidden="true" />
              <span className="sr-only">Done: </span>
              <span className={styles.doneTitle}>{step.title}</span>
              <span className={styles.doneDetail}>{step.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Row({ lead, title, detail, children }: { lead: ReactNode; title: string; detail: string; children: ReactNode }) {
  return (
    <li className={styles.row}>
      {lead}
      <span className={styles.text}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowDetail}>{detail}</span>
      </span>
      <span className={styles.actions}>{children}</span>
    </li>
  );
}
```

## home-needs.module.css

```css
/* Home's Needs you and Finish setting up. Each is the introduction's soft grey tile (the canvas grey, no edge, the
   container squircle, 16px inside) with its title row at the top. Needs you's rows are one white list: a 36px Silicon
   mark, a medium title over a secondary line, and the actions at the end. 36px under the greeting, like the
   introduction. */
.group { display: grid; gap: var(--space-inset); margin-top: var(--space-group); outline: none; }

.tile { --sq-r: var(--radius-container); --sq-fill: var(--canvas); display: grid; gap: var(--space-inset); padding: var(--space-inset); background: var(--sq-fill); }
.head { display: flex; align-items: center; gap: var(--space-related); }
.title { margin: 0; color: var(--foreground); font-size: var(--text-base); font-weight: 500; line-height: var(--leading-body); }
.count { margin-inline-start: auto; color: var(--text-muted); font-size: var(--text-sm); }
.bar { width: 96px; flex: none; }

/* The rows: one white list with hairlines between rows. */
.rows { --sq-r: var(--radius-control); display: grid; margin: 0; padding: 0; overflow: hidden; background: var(--surface); box-shadow: var(--shadow-resting); list-style: none; }
.row { display: flex; min-width: 0; align-items: center; gap: var(--space-group); padding: var(--space-group) var(--space-inset); }
.row + .row { border-top: 1px solid var(--border-subtle); }
.text { display: grid; min-width: 0; flex: 1; gap: var(--space-hair); }
.rowTitle { color: var(--foreground); font-size: var(--text-sm); font-weight: 500; line-height: var(--leading-body); }
.rowDetail { overflow: hidden; color: var(--text-secondary); font-size: var(--text-sm); line-height: var(--leading-body); text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; flex: none; align-items: center; gap: var(--space-related); }

/* Icon tiles: grey with the step's icon (a request's failure, a step left). */
.icon { --sq-r: var(--radius-control); --sq-fill: var(--surface-muted); display: grid; width: 36px; height: 36px; flex: none; place-items: center; background: var(--sq-fill); color: var(--text-secondary); }

/* Finish setting up: each step left is a small white card (faint edge, resting shadow), side by side: its icon tile,
   its title over a short line, and its action at the foot. The steps done follow as ticked lines. */
.steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(176px, 1fr)); gap: var(--space-group); margin: 0; padding: 0; list-style: none; }
.step { --sq-r: var(--radius-container); --sq-fill: var(--surface); --sq-stroke: var(--border-subtle); display: flex; min-width: 0; flex-direction: column; align-items: flex-start; gap: var(--space-group); padding: var(--space-inset); border: 1px solid var(--sq-stroke); background: var(--sq-fill); box-shadow: var(--shadow-resting); }
.stepDetail { color: var(--text-secondary); font-size: var(--text-xs); line-height: var(--leading-body); }
.stepActions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-related); margin-top: auto; }
.done { display: grid; gap: var(--space-tight); margin: 0; padding: 0; list-style: none; }
.doneItem { display: flex; min-width: 0; align-items: center; gap: var(--space-related); font-size: var(--text-sm); }
.doneTick { flex: none; color: var(--success); }
.doneTitle { flex: none; color: var(--text-secondary); }
.doneDetail { min-width: 0; overflow: hidden; color: var(--text-muted); text-overflow: ellipsis; white-space: nowrap; }

/* "You're all set": a slim green strip. */
.allClear { --sq-r: var(--radius-container); --sq-fill: color-mix(in oklab, var(--success) 10%, var(--surface)); display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-related); margin: var(--space-group) 0 0; padding: var(--space-group) var(--space-inset); background: var(--sq-fill); color: var(--success); font-size: var(--text-sm); font-weight: 500; }
.allClearNote { color: var(--text-secondary); font-weight: 400; }

.dialogText { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: var(--leading-body); }
.dialogActions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-related); margin-top: var(--space-section); }
.mono { font-family: var(--font-mono); letter-spacing: 0; }

@media (max-width: 639px) {
  .row { flex-wrap: wrap; }
  .actions { width: 100%; justify-content: flex-end; }
}
```
