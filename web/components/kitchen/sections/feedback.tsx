"use client";

import { useState } from "react";
import { CircleCheck, Cpu } from "lucide-react";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { AnimatedCounter } from "@/components/silicon-ui/animated-counter/animated-counter";
import { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import { EmptyState } from "@/components/silicon-ui/empty-state/empty-state";
import { MetricCard } from "@/components/silicon-ui/metric-card/metric-card";
import { Progress } from "@/components/silicon-ui/progress/progress";
import { Skeleton } from "@/components/silicon-ui/skeleton/skeleton";
import { SlotText } from "@/components/silicon-ui/slot-text/slot-text";
import { TextMorph } from "@/components/silicon-ui/text-morph/text-morph";
import Toast from "@/components/silicon-ui/toast/toast";
import { ApiError } from "@/lib/api/errors";
import { notify } from "@/lib/notify";
import { Specimen, Specimens, kitchenStyles as styles } from "../specimen";

export function Feedback() {
  const [count, setCount] = useState(1284);
  const [follow, setFollow] = useState("Pending");
  const [progress, setProgress] = useState(62);
  const [alertOpen, setAlertOpen] = useState(true);
  const [toastOpen, setToastOpen] = useState(true);
  return (
    <Specimens>
      <Specimen title="TextMorph, SlotText and AnimatedCounter">
        <div className={styles.numbers}>
          <button type="button" className={styles.morphLabel} onClick={() => setFollow(current => (current === "Pending" ? "Accepted" : "Pending"))}><TextMorph>{follow}</TextMorph></button>
          <button type="button" className={styles.morphLabel} onClick={() => setCount(current => current + 137)}><SlotText value={count} /></button>
        </div>
        <AnimatedCounter value={count} label="Sign-ins this month" />
      </Specimen>
      <Specimen title="Badge: status always has a label">
        <div className={styles.row}>
          <Badge tone="success" icon={<CircleCheck size={13} strokeWidth={2} />}>Active</Badge>
          <Badge tone="warning">Pending custodian</Badge>
          <Badge tone="info">Transfer pending</Badge>
          <Badge tone="danger">Revoked</Badge>
          <Badge>Imported</Badge>
          <Badge size="sm" tone="info">Primary</Badge>
        </div>
      </Specimen>
      <Specimen title="Alert: next to its cause">
        <Alert tone="info" title="Codes are valid for 10 minutes">Ask for a new one if it expires.</Alert>
        <Alert tone="warning" title="si:scout has no webhook">It will not hear about custodian changes until you add one.</Alert>
        <Alert tone="danger" title="That code is not right">You have 9 attempts left before a one minute pause.</Alert>
        <Alert tone="success" title="Webhook delivered" open={alertOpen} onDismiss={() => { setAlertOpen(false); setTimeout(() => setAlertOpen(true), 1600); }}>The receiver answered 200 in 84 ms.</Alert>
      </Specimen>
      <Specimen title="Progress and Skeleton">
        <Progress label="Importing users" value={progress} showValue />
        <div className={styles.row}>
          <Button size="sm" variant="secondary" onClick={() => setProgress(value => Math.min(100, value + 19))}>Advance</Button>
          <Button size="sm" variant="ghost" onClick={() => setProgress(8)}>Reset</Button>
        </div>
        <Skeleton lines={3} avatar label="Loading apps" />
      </Specimen>
      <Specimen title="Toasts: results of background work (lib/notify)" single>
        <div className={styles.row}>
          <Button size="sm" variant="secondary" onClick={() => notify.success("Webhook secret rotated", "Update your receiver with the new whsec_ value.")}>Success</Button>
          <Button size="sm" variant="secondary" onClick={() => notify.info("Import queued", "48 rows will be processed in the background.")}>Info</Button>
          <Button size="sm" variant="secondary" onClick={() => notify.error(new ApiError({ status: 409, code: "id_taken", message: "c:saket is taken by another account.", hint: "Try c:saket-2 or another id." }), "Could not change your id")}>Error</Button>
          <Button size="sm" variant="secondary" onClick={() => {
            const id = notify.loading("Rotating the STK", "Signing si:scout out everywhere");
            setTimeout(() => notify.update(id, { type: "success", title: "STK rotated", description: "The old STK stopped working." }), 1400);
          }}>Loading, then done</Button>
        </div>
        <p className={styles.note}>A single toast, in place:</p>
        <Toast title="Copied" description="c:saket is on your clipboard." open={toastOpen} duration={0} onOpenChange={open => { setToastOpen(open); if (!open) setTimeout(() => setToastOpen(true), 1600); }} />
      </Specimen>
      <Specimen title="MetricCard (an app's overview)">
        <div className={styles.metrics}>
          <MetricCard label="Users" value={1284} context="Carbons and Silicons" change="+12%" />
          <MetricCard label="Active in 30 days" value={942} context="Signed in at least once" change="-3%" />
          <MetricCard label="Imported, not claimed" value={86} context="Finish setup on first sign-in" />
        </div>
      </Specimen>
      <Specimen title="EmptyState: why, and one next step">
        <EmptyState icon={<Cpu width={24} height={24} strokeWidth={1.5} />} title="No Silicons yet" description="Silicons you are custodian of appear here." action={<Button variant="secondary">Create a Silicon</Button>} />
      </Specimen>
    </Specimens>
  );
}
