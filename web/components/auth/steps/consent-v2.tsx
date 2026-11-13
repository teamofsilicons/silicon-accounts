"use client";

/**
 * The consent step, second round (Anil, 2026-11-13: "clunky, the hierarchy isn't going well"). The hierarchy, for every
 * design below:
 *
 *   1. The decision is "continue to the app", so Continue is the strongest thing on the page.
 *   2. What the app always gets is not a choice: one plain sentence, never a row each with badges.
 *   3. The optional details are the only real choice, so they carry the page's interaction.
 *   4. Who you are is context: one small line with Switch, not a boxed card.
 *   5. The rest (Cancel, where to change it later, the app's address) is small, at the foot.
 *   6. "New" shows only on a return visit, where it means something.
 *
 * Four visually different designs, on Silicon UI and the site's tokens, compared in /__consent:
 *
 *   SentenceConsent  Google-like and calm: what's included as a success Alert, checkboxes for the extras.
 *   CardConsent      You as the app will see you: a Card with your photo, name and CarbonID; chips add details.
 *   OneTapConsent    Facebook-like: "Continue as Saket" first; the extras folded in an Accordion.
 *   BandConsent      A Card with both marks over the question; quiet Always and Your choice lists below.
 *
 * Silicon UI throughout: Alert, Card, Accordion, Checkbox, ChipGroup, Switch, Badge, Avatar, Button. The detail lists
 * are the one hand-built part: Silicon UI has no list-row component.
 */
import { useState, type ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import { Accordion } from "@teamofsilicons/silicon-ui/accordion";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Card } from "@teamofsilicons/silicon-ui/card";
import { Checkbox } from "@teamofsilicons/silicon-ui/checkbox";
import { ChipGroup } from "@teamofsilicons/silicon-ui/chip-group";
import { Switch } from "@teamofsilicons/silicon-ui/switch";
import type { ConsentField, ConsentProps } from "./consent-designs";
import styles from "./consent-v2.module.css";

/** The included details as words: "name, photo, CarbonID and email". */
function includedWords(fields: ConsentField[]): string {
  const names = ["name", "photo", "CarbonID", ...fields.filter(field => field.mode === "required").map(field => field.label.replace(/ address$/i, "").toLowerCase())];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

function useChoices(fields: ConsentField[]) {
  const optional = fields.filter(field => field.mode === "optional");
  const [on, setOn] = useState<string[]>(() => optional.filter(field => field.shared && field.value !== null).map(field => field.field));
  const returning = fields.some(field => !field.isNew);
  return { optional, on, setOn, toggle: (field: string, value: boolean) => setOn(list => (value ? [...new Set([...list, field])] : list.filter(item => item !== field))), returning };
}

/** "New" only on a return visit. */
const newMark = (field: ConsentField, returning: boolean) => (returning && field.isNew ? <Badge size="sm" tone="info">New</Badge> : null);

/** The small print at the foot, the same in every design. */
function Foot({ app, account, cancel = true }: { app: ConsentProps["app"]; account: ConsentProps["account"]; cancel?: boolean }) {
  return (
    <div className={styles.foot}>
      {cancel ? <Button variant="ghost" className={styles.wide}>Cancel</Button> : null}
      <p className={styles.fine}>
        You can change this any time in Connected Apps.{app.domain ? <> Your details go to <span className={styles.domain}>{app.domain}</span>.</> : null}
        {cancel ? null : <> Not {account.name.split(" ")[0]}? <Button variant="link" size="xs">Use Another Account</Button></>}
      </p>
    </div>
  );
}

/** You, in one small line: photo, name and CarbonID, and Switch. */
function WhoLine({ account }: { account: ConsentProps["account"] }) {
  return (
    <div className={styles.who}>
      <Avatar name={account.name} src={account.photo ?? undefined} size="sm" />
      <span className={styles.whoWords}><span className={styles.whoName}>{account.name}</span> <span className={styles.whoId}>{account.id}</span></span>
      <Button variant="link" size="xs">Switch</Button>
    </div>
  );
}

const Continue = ({ label = "Continue", onClick }: { label?: string; onClick: () => void }) => <Button size="lg" className={styles.wide} onClick={onClick}>{label}</Button>;

/* ------------------------------------------------------------------------------------------------------------------ */
/* 1  Sentence                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

export function SentenceConsent({ app, account, fields, onShare }: ConsentProps) {
  const { optional, on, toggle, returning } = useChoices(fields);
  return (
    <div className={styles.page}>
      <WhoLine account={account} />
      <h1 className={styles.title}>Continue to {app.name}</h1>
      <Alert tone="success" title={`${app.name} gets your ${includedWords(fields)}`}>It sees them when they change, too.</Alert>
      {optional.length ? (
        <fieldset className={styles.extras}>
          <legend className={styles.extrasTitle}>Also share, if you like</legend>
          {optional.map(field => field.value === null ? (
            <div key={field.field} className={styles.missing}><span>{field.label}: none yet</span><Button variant="link" size="xs"><Plus size={14} strokeWidth={2} aria-hidden="true" />Add</Button></div>
          ) : (
            <div key={field.field} className={styles.checkRow}>
              <Checkbox label={field.label} description={field.value} checked={on.includes(field.field)} onCheckedChange={value => toggle(field.field, value === true)} />
              {newMark(field, returning)}
            </div>
          ))}
        </fieldset>
      ) : null}
      <Continue onClick={() => onShare?.(on)} />
      <Foot app={app} account={account} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 2  Card: you as the app will see you                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export function CardConsent({ app, account, fields, onShare }: ConsentProps) {
  const { optional, on, setOn, returning } = useChoices(fields);
  const required = fields.filter(field => field.mode === "required");
  const shown = [...required, ...optional.filter(field => on.includes(field.field))];
  const pickable = optional.filter(field => field.value !== null);
  return (
    <div className={styles.page} data-center="">
      <p className={styles.eyebrow}>{app.name} will see you as</p>
      <div className={styles.cardSlot}><Card title={account.name} description={account.id} media={<span className={styles.cardMedia}><span className={styles.ring}><Avatar name={account.name} src={account.photo ?? undefined} size="lg" /></span></span>}>
        {shown.length ? <ul className={styles.cardFacts}>{shown.map(field => <li key={field.field}><span>{field.label.replace(/ address$/i, "")}</span><span>{field.value}</span></li>)}</ul> : null}
      </Card></div>
      {pickable.length ? (
        <div className={styles.chips}>
          <p className={styles.extrasTitle}>Add to what {app.name} sees{returning && pickable.some(field => field.isNew) ? " (some are new)" : ""}</p>
          <ChipGroup label={`Add to what ${app.name} sees`} multiple options={pickable.map(field => ({ value: field.field, label: field.label }))} value={on} onValueChange={setOn} />
        </div>
      ) : null}
      <Continue label={`Continue to ${app.name}`} onClick={() => onShare?.(on)} />
      <Foot app={app} account={account} cancel={false} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 3  One tap: continue first, extras folded                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

export function OneTapConsent({ app, account, fields, onShare }: ConsentProps) {
  const { optional, on, toggle, returning } = useChoices(fields);
  const first = account.name.split(" ")[0];
  return (
    <div className={styles.page}>
      <div className={styles.oneTapHead}>
        <span className={styles.ring}><Avatar name={account.name} src={account.photo ?? undefined} size="lg" /></span>
        <div>
          <h1 className={styles.title}>Continue as {first}?</h1>
          <p className={styles.lead}>{app.name} gets your {includedWords(fields)}.</p>
        </div>
      </div>
      <Continue label={`Continue as ${first}`} onClick={() => onShare?.(on)} />
      {optional.length ? (
        <Accordion items={[{
          title: `Share more with ${app.name}${on.length ? ` (${on.length} on)` : ""}`,
          content: (
            <ul className={styles.foldList}>
              {optional.map(field => (
                <li key={field.field}>
                  <span className={styles.foldWords}><span className={styles.foldLabel}>{field.label}{newMark(field, returning)}</span><span className={styles.foldValue}>{field.value ?? "None yet"}</span></span>
                  {field.value === null ? <Button variant="secondary" size="xs">Add</Button> : <Switch checked={on.includes(field.field)} onCheckedChange={value => toggle(field.field, value)} aria-label={`Share your ${field.label.toLowerCase()}`} />}
                </li>
              ))}
            </ul>
          ),
        }]} />
      ) : null}
      <Foot app={app} account={account} cancel={false} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 4  Band: the app's colour across the top                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export function BandConsent({ app, account, fields, onShare }: ConsentProps) {
  const { optional, on, toggle, returning } = useChoices(fields);
  const required = fields.filter(field => field.mode === "required");
  return (
    <div className={styles.page}>
      <Card title={`${app.name} would like to know you`} description={`Signed in as ${account.name} (${account.id})`} action={<Button variant="link" size="xs">Switch</Button>} media={
        <span className={styles.bandMarks} aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element -- app logos are arbitrary URLs. */}
          {app.logo ? <img data-sq="clip" className={styles.bandLogo} src={app.logo} alt="" /> : <span data-sq="clip" className={styles.bandLogo}>{app.name.slice(0, 1)}</span>}
          <span className={styles.bandPlus}>+</span>
          <span className={styles.ring}><Avatar name={account.name} src={account.photo ?? undefined} size="md" /></span>
        </span>
      } />
      <List title="Always" items={[{ key: "profile", label: "Name, photo and CarbonID", value: `${account.name} · ${account.id}` }, ...required.map(field => ({ key: field.field, label: field.label, value: field.value ?? "" }))]} />
      {optional.length ? (
        <List title="Your choice" items={optional.map(field => ({
          key: field.field, label: field.label, value: field.value ?? "None yet", mark: newMark(field, returning),
          end: field.value === null ? <Button variant="secondary" size="xs">Add</Button> : <Switch checked={on.includes(field.field)} onCheckedChange={value => toggle(field.field, value)} aria-label={`Share your ${field.label.toLowerCase()}`} />,
        }))} />
      ) : null}
      <Continue label="Share and Continue" onClick={() => onShare?.(on)} />
      <Foot app={app} account={account} />
    </div>
  );
}

function List({ title, items }: { title: string; items: Array<{ key: string; label: string; value: string; mark?: ReactNode; end?: ReactNode }> }) {
  return (
    <section className={styles.list} aria-label={title}>
      <h2 className={styles.listTitle}>{title}</h2>
      <ul>
        {items.map(item => (
          <li key={item.key}>
            <span className={styles.foldWords}><span className={styles.foldLabel}>{item.label}{item.mark}</span><span className={styles.foldValue}>{item.value}</span></span>
            {item.end ?? <Check size={16} strokeWidth={2} className={styles.listCheck} aria-label="Shared" />}
          </li>
        ))}
      </ul>
    </section>
  );
}
