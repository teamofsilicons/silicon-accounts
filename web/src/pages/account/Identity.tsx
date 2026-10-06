/**
 * Identity home (/ when signed in, and /identity): the identity card. Owned by the web-account builder; this first
 * version shows the card shell with the signed-in account so the shell can be reviewed.
 */
import { For, Show, Suspense } from "solid-js";
import { ArrowLeft, ArrowRight } from "lucide-solid";
import { Avatar } from "../../arc/avatar/avatar";
import { Badge } from "../../arc/badge/badge";
import { AnimatedCounter } from "../../arc/animated-counter/animated-counter";
import { Button } from "../../arc/button/button";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { createApiResource, api, type CarbonMe, type Me } from "../../api";
import { IdentityCard, IdentityField, LiveClock, StampRow, useIdentityCard } from "../../app/identity/IdentityCard";
import { Page, PageHeader } from "../../app/layout/layout";
import { paths } from "../../app/navigation";
import { me } from "../../app/session";
import { formatDate, formatPhone, kindNoun } from "../../lib/format";
import styles from "./identity.module.css";

export default function Identity() {
  const [apps] = createApiResource(() => api.me.apps.list({ limit: 50 }));
  return (
    <Page>
      <PageHeader title="Your identity" description="One account for every app you use. Apps store your uuid; your id is yours to change." />
      <div class={styles.layout}>
        <Suspense fallback={<CardSkeleton />}>
          <Show when={me()} fallback={<CardSkeleton />}>
            {account => (
              <IdentityCard
                label={`Identity card of ${account().id ?? account().display_name}`}
                front={<Front account={account()} stamps={(apps()?.items ?? []).filter(item => item.status === "active").map(item => ({ name: item.app.name, logoUrl: item.app.logo_url, seed: item.app.app_id }))} />}
                back={<Back account={account()} />}
              />
            )}
          </Show>
        </Suspense>
        <Glance apps={apps()?.items.filter(item => item.status === "active").length} account={me()} />
      </div>
    </Page>
  );
}

function Front(props: { account: Me; stamps: Array<{ name: string; logoUrl: string | null; seed: string }> }) {
  const card = useIdentityCard();
  return (
    <div class={styles.front}>
      <div class={styles.who}>
        <Avatar name={props.account.display_name} src={props.account.pfp_url} kind={props.account.kind} size="xxl" />
        <div class={styles.names}>
          <h2 class={styles.name}>{props.account.display_name}</h2>
          <div class={styles.badges}>
            <Badge tone={props.account.status === "active" ? "success" : "warning"} dot>{kindNoun(props.account.kind)}</Badge>
            <span class={styles.since}>since {formatDate(props.account.created_at)}</span>
          </div>
        </div>
      </div>
      <div class={styles.fields}>
        <IdentityField label="Id" value={props.account.id} mono copyLabel="Copy id" />
        <IdentityField label="uuid" value={props.account.uuid} mono copyLabel="Copy uuid" />
        <IdentityField label="Local time" value={props.account.timezone}>
          <LiveClock timeZone={props.account.timezone} />
        </IdentityField>
      </div>
      <div class={styles.foot}>
        <StampRow apps={props.stamps} label="Apps you have signed into" />
        <Button variant="secondary" size="sm" onClick={card.toggle}>Details<ArrowRight size={16} stroke-width={1.75} aria-hidden="true" /></Button>
      </div>
    </div>
  );
}

function Back(props: { account: Me }) {
  const card = useIdentityCard();
  const carbon = () => (props.account.kind === "carbon" ? (props.account as CarbonMe) : null);
  return (
    <div class={styles.back}>
      <div class={styles.backHead}>
        <h2 class={styles.backTitle}>Details</h2>
        <Button variant="ghost" size="sm" onClick={card.toggle}><ArrowLeft size={16} stroke-width={1.75} aria-hidden="true" />Back</Button>
      </div>
      <dl class={styles.details}>
        <Show when={carbon()}>
          {account => (
            <>
              <div><dt>Emails</dt><dd><For each={account().emails} fallback={<span class={styles.muted}>None yet</span>}>{email => <span class={styles.contact}>{email.email}<Show when={email.is_primary}><Badge size="sm" tone="info">Primary</Badge></Show></span>}</For></dd></div>
              <div><dt>Phones</dt><dd><For each={account().phones} fallback={<span class={styles.muted}>None yet</span>}>{phone => <span class={styles.contact}>{formatPhone(phone.phone)}<Show when={phone.is_primary}><Badge size="sm" tone="info">Primary</Badge></Show></span>}</For></dd></div>
            </>
          )}
        </Show>
        <div><dt>Date of birth</dt><dd>{formatDate(props.account.dob)}</dd></div>
        <div><dt>Timezone</dt><dd>{props.account.timezone}</dd></div>
      </dl>
    </div>
  );
}

/** A quiet column of counts beside the card, each a door into its section. */
function Glance(props: { apps: number | undefined; account: Me | undefined }) {
  const carbon = () => (props.account?.kind === "carbon" ? (props.account as CarbonMe) : null);
  const rows = () => [
    { label: "Apps you are signed into", value: props.apps, href: paths.apps },
    { label: "Silicons in your care", value: carbon()?.custodian_of, href: paths.silicons },
    { label: "Emails and phone numbers", value: carbon() ? carbon()!.emails.length + carbon()!.phones.length : undefined, href: paths.signInMethods },
  ];
  return (
    <aside class={styles.glance} aria-label="At a glance">
      <For each={rows()}>
        {row => (
          <a href={row.href} class={styles.glanceRow}>
            <span class={styles.glanceValue}><Show when={row.value !== undefined} fallback={<SkeletonBlock width="2ch" height="28px" radius="6px" />}><AnimatedCounter value={row.value ?? 0} size="inline" /></Show></span>
            <span class={styles.glanceLabel}>{row.label}</span>
            <ArrowRight class={styles.glanceArrow} size={16} stroke-width={1.75} aria-hidden="true" />
          </a>
        )}
      </For>
    </aside>
  );
}

function CardSkeleton() {
  return <SkeletonBlock width="min(100%, 640px)" height="360px" radius="var(--radius-surface)" />;
}
