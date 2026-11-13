"use client";

/**
 * The consent step on the site's own design (Anil, 2026-11-13: "use the design we've developed until now"), compared in
 * /__consent beside the first three tries (consent-designs.tsx). Built only from parts the site already has:
 *
 *   - the sign-in steps' parts (flow/parts.tsx): StepHeading (h1 and the soft line under it, as "Sign in to Briefcase"),
 *     AccountRow (the bordered row with your photo, name and CarbonID, and its action, as sign-up's "Not You?"), and the
 *     steps' full-width actions (flow.module.css);
 *   - the account pages' rows (account/parts/rows.tsx), drawn exactly as Connected Apps' "What it can see about you":
 *     a grey icon tile, the detail's name over its value, and at the end "Always" (a neutral Badge), "Required", a
 *     Switch for the Carbon's choice, or Add for a detail the account doesn't have. What you agree to here looks like
 *     what you later manage there.
 *   - copy on the dialog rules: the description says who sees it and where it can be changed; values are strong;
 *     buttons in title case; Cancel as ghost.
 *
 *   OneListConsent      "Share with Briefcase": one list, the profile first.
 *   TwoSectionsConsent  "Share with Briefcase": "Briefcase always sees" and "You choose" as two sections (h2), like
 *                       Security's and Personal info's sections.
 */
import { useState, type ReactNode } from "react";
import { Cake, Clock, Mail, Phone, UserRound } from "lucide-react";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Switch } from "@teamofsilicons/silicon-ui/switch";
import { Row, Section, Tile } from "@/components/account/parts/rows";
import type { AccountSummary } from "@/lib/api/types";
import { AccountRow, StepHeading } from "../flow/parts";
import type { ConsentField, ConsentProps } from "./consent-designs";
import flow from "../flow/flow.module.css";
import styles from "./consent-aligned.module.css";

/** The same icons Connected Apps and Data & privacy use for each detail. */
const ICON: Record<string, ReactNode> = {
  email: <Mail size={16} strokeWidth={2} />,
  phone: <Phone size={16} strokeWidth={2} />,
  dob: <Cake size={16} strokeWidth={2} />,
  timezone: <Clock size={16} strokeWidth={2} />,
};

function useChoices(fields: ConsentField[]) {
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(fields.map(field => [field.field, field.mode === "required" || field.shared])));
  return { on, set: (field: string, value: boolean) => setOn(current => ({ ...current, [field]: value })), shared: fields.filter(field => on[field.field] && field.value !== null) };
}

const asSummary = (account: ConsentProps["account"]): AccountSummary => ({ uuid: account.id, kind: "carbon", id: account.id, display_name: account.name, pfp_url: account.photo ?? "", status: "active" as AccountSummary["status"] });

function ProfileRow({ account }: { account: ConsentProps["account"] }) {
  return (
    <Row lead={<Tile><UserRound size={16} strokeWidth={2} /></Tile>} title="Name, photo and CarbonID" detail={<>{account.name} · {account.id}</>}>
      <Badge size="sm" tone="neutral">Always</Badge>
    </Row>
  );
}

/** A detail as Connected Apps lists it, with what the Carbon can do about it at the end. */
function DetailRow({ field, app, on, set }: { field: ConsentField; app: string; on: boolean; set: (value: boolean) => void }) {
  const missing = field.value === null;
  const detail = missing ? "Not added yet" : field.value;
  return (
    <Row lead={<Tile>{ICON[field.field] ?? <UserRound size={16} strokeWidth={2} />}</Tile>} title={<span className={styles.title}>{field.label}{field.isNew && !missing ? <Badge size="sm" tone="info">New</Badge> : null}</span>} detail={detail}>
      {missing ? <Button variant="secondary" size="xs">Add</Button>
        : field.mode === "required" ? <Badge size="sm" tone="neutral">Required</Badge>
        : <Switch checked={on} onCheckedChange={set} aria-label={`Share your ${field.label.toLowerCase()} with ${app}`} />}
    </Row>
  );
}

function Heading({ app }: { app: ConsentProps["app"] }) {
  return <StepHeading title={`Share with ${app.name}`} description={<>{app.name} sees these now and when they change. You can change this any time in <strong>Connected Apps</strong>.</>} />;
}

function Actions({ app, shared, onShare }: { app: ConsentProps["app"]; shared: ConsentField[]; onShare?: ConsentProps["onShare"] }) {
  return (
    <div className={flow.actions}>
      <Button className={flow.wide} onClick={() => onShare?.(shared.map(field => field.field))}>Share and Continue</Button>
      <Button variant="ghost" className={flow.wide}>Cancel</Button>
      {app.domain ? <p className={styles.where}>Your details go to <strong>{app.domain}</strong></p> : null}
    </div>
  );
}

/* D  One list ------------------------------------------------------------------------------------------------------ */

export function OneListConsent({ app, account, fields, onShare }: ConsentProps) {
  const { on, set, shared } = useChoices(fields);
  return (
    <div className={styles.step}>
      <Heading app={app} />
      <AccountRow account={asSummary(account)} action={<Button variant="link" size="sm">Switch Account</Button>} />
      <Section id="consent-sees" label={`What ${app.name} can see`}>
        <ProfileRow account={account} />
        {fields.map(field => <DetailRow key={field.field} field={field} app={app.name} on={!!on[field.field]} set={value => set(field.field, value)} />)}
      </Section>
      <Actions app={app} shared={shared} onShare={onShare} />
    </div>
  );
}

/* E  Two sections -------------------------------------------------------------------------------------------------- */

export function TwoSectionsConsent({ app, account, fields, onShare }: ConsentProps) {
  const { on, set, shared } = useChoices(fields);
  const always = fields.filter(field => field.mode === "required");
  const choice = fields.filter(field => field.mode === "optional");
  return (
    <div className={styles.step}>
      <Heading app={app} />
      <AccountRow account={asSummary(account)} action={<Button variant="link" size="sm">Switch Account</Button>} />
      <Section id="consent-always" title={`${app.name} always sees`}>
        <ProfileRow account={account} />
        {always.map(field => <DetailRow key={field.field} field={field} app={app.name} on set={() => undefined} />)}
      </Section>
      {choice.length ? (
        <Section id="consent-choose" title="You choose" description="Off unless you switch it on.">
          {choice.map(field => <DetailRow key={field.field} field={field} app={app.name} on={!!on[field.field]} set={value => set(field.field, value)} />)}
        </Section>
      ) : null}
      <Actions app={app} shared={shared} onShare={onShare} />
    </div>
  );
}
