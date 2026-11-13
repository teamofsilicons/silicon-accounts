"use client";

/**
 * /__request: the custodian request page rethought as a decision (components/account/silicons/request-view.tsx), with
 * sample requests: a Silicon's own request naming you by your CarbonID or by your email, one about to run out, one that
 * ran out, and a handover from another Carbon. Nothing here answers anything: Accept and Decline only say what would
 * happen.
 */
import { useState } from "react";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import type { AccountSummary, CustodianRequest } from "@/lib/api/types";
import { RequestView, type RequestAnswer } from "@/components/account/silicons/request-view";
import { ChoiceDesign, PassDesign, SheetDesign } from "@/components/account/silicons/request-designs";
import styles from "./request-lab.module.css";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12, 10, 0);
const iso = (offset: number) => new Date(NOW + offset).toISOString();

const silicon = (name: string, id: string, uuid: string): AccountSummary => ({ uuid, kind: "silicon", id, display_name: name, pfp_url: "", status: "pending_custodian" as AccountSummary["status"] });
const me: AccountSummary = { uuid: "sample-me", kind: "carbon", id: "c:anil", display_name: "Anil", pfp_url: "", status: "active" as AccountSummary["status"] };
const maya: AccountSummary = { uuid: "sample-maya", kind: "carbon", id: "c:maya", display_name: "Maya Rao", pfp_url: "", status: "active" as AccountSummary["status"] };

const SAMPLES: Record<string, { label: string; request: CustodianRequest }> = {
  own: { label: "Its own, by CarbonID", request: { id: "r1", kind: "initial", status: "pending" as CustodianRequest["status"], silicon: silicon("Research Silicon", "si:research", "sample-research"), from: null, to: me, created_at: iso(-2 * DAY), expires_at: iso(12 * DAY), decided_at: null } },
  email: { label: "Its own, by email", request: { id: "r2", kind: "initial", status: "pending" as CustodianRequest["status"], silicon: silicon("Scout", "si:scout", "sample-scout"), from: null, to: { email: "anil@example.test" }, created_at: iso(-5 * 3_600_000), expires_at: iso(14 * DAY - 5 * 3_600_000), decided_at: null } },
  soon: { label: "Running out", request: { id: "r3", kind: "initial", status: "pending" as CustodianRequest["status"], silicon: silicon("Juniper", "si:juniper", "sample-juniper"), from: null, to: me, created_at: iso(-13 * DAY - 6 * 3_600_000), expires_at: iso(18 * 3_600_000), decided_at: null } },
  out: { label: "Ran out", request: { id: "r4", kind: "initial", status: "expired" as CustodianRequest["status"], silicon: silicon("Relay", "si:relay", "sample-relay"), from: null, to: me, created_at: iso(-15 * DAY), expires_at: iso(-DAY), decided_at: null } },
  handover: { label: "A handover", request: { id: "r5", kind: "transfer", status: "pending" as CustodianRequest["status"], silicon: { ...silicon("Atlas", "si:atlas", "sample-atlas"), status: "active" as AccountSummary["status"] }, from: maya, to: me, created_at: iso(-DAY), expires_at: iso(13 * DAY), decided_at: null } },
};

const DESIGNS = [
  { key: "choice", name: "A  Choice", note: "A hero in the Silicon's own colours, its avatar arriving to you; then Accept and Decline as two cards side by side, each listing what it does with its button at its foot. You pick a card.", View: ChoiceDesign },
  { key: "pass", name: "B  Pass", note: "The Silicon's pass on the left (its avatar art, name, si:id and a torn stub with the request's facts) beside the question, the check, what accepting means and the buttons.", View: PassDesign },
  { key: "sheet", name: "C  Sheet", note: "A review sheet: the request's facts as a summary, and a sticky Your answer panel with the time left as a bar, what accepting means and the buttons.", View: SheetDesign },
] as const;

export function RequestLab() {
  const [sample, setSample] = useState("own");
  const [answered, setAnswered] = useState<RequestAnswer | null>(null);
  const { request } = SAMPLES[sample];
  const you = { name: "Anil" };
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>A request, as a decision</h1>
        <p className={styles.lede}>Three designs for /silicons/requests/[id], then the ordered list from before. The same facts in each: the question and the time left, the Silicon (and who hands it over), the check, what accepting and declining do, the answer. Sample requests; nothing is sent.</p>
        <SegmentedControl size="sm" label="Sample" options={Object.entries(SAMPLES).map(([value, entry]) => ({ value, label: entry.label }))} value={sample} onValueChange={value => { setSample(value); setAnswered(null); }} />
        {answered ? <p className={styles.answered} role="status">Would {answered}: {answered === "accept" ? "goes to the Silicon’s page" : "goes back to Silicons"}. (Sample: nothing was sent.)</p> : null}
      </header>
      {DESIGNS.map(({ key, name, note, View }) => (
        <section key={key} className={styles.design} aria-label={name}>
          <div>
            <h2 className={styles.name}>{name}</h2>
            <p className={styles.note}>{note}</p>
          </div>
          <div className={styles.stage}>
            <div className={styles.wide}><View key={sample} request={request} now={NOW} you={you} onAnswer={setAnswered} /></div>
          </div>
        </section>
      ))}
      <section className={styles.design} aria-label="D  Ordered list">
        <div>
          <h2 className={styles.name}>D  Ordered list</h2>
          <p className={styles.note}>The earlier pass: the same order as plain sections, at the page&rsquo;s narrow column.</p>
        </div>
        <div className={styles.stage}>
          <div className={styles.column}><RequestView key={sample} request={request} now={NOW} onAnswer={setAnswered} /></div>
        </div>
      </section>
    </main>
  );
}
