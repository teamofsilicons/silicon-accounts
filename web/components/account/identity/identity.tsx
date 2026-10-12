"use client";

/**
 * The identity home ("/" signed in), per "Silicon Accounts Redesign Design Review":
 *
 * - the attention strip, only when something needs your decision (attention/attention-strip.tsx);
 * - the identity card. Its front is for recognition only: photo (drop a new one on it), display name (edit in place),
 *   id (change it; the old one stays reserved for 10 days), since when, and a stamp for every app you signed into.
 *   Turn it over for your emails and phone numbers, your date of birth (a Silicon's creation date), your uuid to copy
 *   for support, and a Silicon's custodian, webhook and STK. Your timezone lives in Settings;
 * - beside it, counts that lead into each pillar, as metric cards. Wayfinding only: no decisions are made there.
 */
import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, AtSign } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { CopyButton } from "@teamofsilicons/silicon-ui/copy-button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { InlineEdit } from "@teamofsilicons/silicon-ui/inline-edit";
import { MetricCard } from "@teamofsilicons/silicon-ui/metric-card";
import { TextMorph } from "@teamofsilicons/silicon-ui/text-morph";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { IdentityCard, IdentityField, StampRow, useIdentityCard, type StampProps } from "@/components/foundation/identity/identity-card";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { Me, MyApp } from "@/lib/api/types";
import { useRegisterCommands } from "@/lib/commands";
import { formatDate, formatPhone, kindNoun } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useRemovePhoto, useUpdateProfile, useUploadPhoto } from "@/lib/query/account";
import { useMe } from "@/lib/query/session";
import { AttentionStrip } from "../attention/attention-strip";
import { appLogo, asCarbon, asSilicon, describeError, reasonError, stkRotatedAt } from "../parts/common";
import { DobEditor } from "../parts/detail-editors";
import { IdChangeForm } from "../parts/id-change-form";
import { PhotoControl } from "../parts/photo-control";
import { useChangeOwnId, useEveryApp } from "../parts/queries";
import styles from "./identity.module.css";

const RESERVED_DAYS = 10;
/** Ids longer than this get the card's whole row, so they show in full instead of fading out at the column's edge. */
const LONG_ID = 12;

function validateName(next: string): string | null {
  if (!next) return "Enter a display name.";
  if (next.length > 100) return `A display name can be at most 100 characters (this one has ${next.length}).`;
  if (/[\u0000-\u001f\u007f]/.test(next)) return "Remove tabs, line breaks and other control characters.";
  return null;
}

export function Identity() {
  const me = useMe();
  const apps = useEveryApp();
  const { theme } = useTheme();
  const [changingId, setChangingId] = useState(false);
  const [reserved, setReserved] = useState<{ id: string; until: number } | null>(null);
  const idInput = useRef<HTMLInputElement>(null);
  const changeId = useChangeOwnId();

  useRegisterCommands(() => [
    { id: "identity.change-id", label: "Change your id", description: "Pick a new id; the old one stays reserved for you for 10 days", group: "Identity", icon: <AtSign size={16} strokeWidth={1.75} />, keywords: ["id", "handle", "username", "rename"], run: () => setChangingId(true) },
  ], []);

  // Apps with a logo of their own come first; the rest follow as their letter, in the order the service gave.
  const stamps: StampProps[] = (apps.data?.items ?? [])
    .filter(item => item.status === "active")
    .map(item => ({ name: item.app.name, logoUrl: appLogo(item.app, theme), seed: item.app.app_id, href: `${paths.apps}#app-${item.app.app_id}` }))
    .sort((a, b) => Number(!a.logoUrl) - Number(!b.logoUrl));

  const account = me.data;
  return (
    <Page>
      <PageHeader title="Your identity" description="One account for every app you use. Your id is yours to change." />
      {me.error && !account ? (
        <Alert tone="danger" title="Your account did not load">
          {describeError(me.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
        </Alert>
      ) : !account ? (
        <LayoutSkeleton />
      ) : (
        <>
        <AttentionStrip me={account} />
        <div className={styles.layout}>
          <IdentityCard
            label={`Identity card of ${account.id ?? account.display_name}`}
            front={(
              <Front
                me={account}
                stamps={stamps}
                appsLoading={apps.isPending}
                appsFailed={!apps.data && !!apps.error}
                onRetryApps={() => void apps.refetch()}
                reserved={reserved}
                onChangeId={() => setChangingId(true)}
              />
            )}
            back={<Back me={account} />}
          />
          <Glance me={account} apps={apps.data?.items} appsFailed={!apps.data && !!apps.error} />
          <Dialog open={changingId} onOpenChange={setChangingId}>
            <DialogContent
              title="Change your id"
              description={account.id ? `Your id is ${account.id} now.` : "Pick the id Carbons and Silicons will type to find you."}
              onOpenAutoFocus={event => {
                event.preventDefault();
                requestAnimationFrame(() => idInput.current?.focus());
              }}
            >
              <IdChangeForm
                prefix={account.kind === "carbon" ? "c:" : "si:"}
                currentId={account.id}
                uuid={account.uuid}
                subject="self"
                inputRef={idInput}
                submit={id => changeId.mutateAsync(id)}
                onChanged={(_, previous) => {
                  setChangingId(false);
                  if (previous) setReserved({ id: previous, until: Date.now() + RESERVED_DAYS * 86_400_000 });
                }}
                onCancel={() => setChangingId(false)}
              />
            </DialogContent>
          </Dialog>
        </div>
        </>
      )}
    </Page>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The card                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

interface FrontProps {
  me: Me;
  stamps: StampProps[];
  appsLoading: boolean;
  appsFailed: boolean;
  onRetryApps: () => void;
  reserved: { id: string; until: number } | null;
  onChangeId: () => void;
}

function Front({ me, stamps, appsLoading, appsFailed, onRetryApps, reserved, onChangeId }: FrontProps) {
  const card = useIdentityCard();
  const update = useUpdateProfile();
  const upload = useUploadPhoto();
  const removePhoto = useRemovePhoto();
  const id = me.id ?? "";
  const saveName = async (next: string) => {
    try {
      await update.mutateAsync({ display_name: next });
    } catch (error) {
      throw reasonError(error);
    }
  };
  return (
    <div className={styles.face}>
      {/* In the same place as the back's Back button, so the card turns over under the pointer and back again. */}
      <Button variant="secondary" size="sm" className={styles.turn} onClick={card.toggle}>
        Details
        <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <div className={styles.who}>
        <PhotoControl
          name={me.display_name}
          src={me.pfp_url}
          upload={file => upload.mutateAsync(file)}
          remove={() => removePhoto.mutateAsync()}
          audience={me.kind === "carbon" ? "Every app that can see your profile sees it." : "Every app this Silicon signs into sees it."}
        />
        <div className={styles.names}>
          <InlineEdit as="h2" variant="title" className={styles.name} label="Display name" value={me.display_name} onSave={saveName} validate={validateName} />
          <div className={styles.badges}>
            <Badge size="sm" tone={me.status === "active" ? "success" : "warning"}>{kindNoun(me.kind)}</Badge>
            {/* A Carbon's account age; for a Silicon the plain fact, its creation date (it has no birthday of its own). */}
            <span className={styles.since}>{me.kind === "silicon" ? "Created" : "Member since"} {formatDate(me.created_at)}</span>
          </div>
        </div>
      </div>
      <div className={styles.fields}>
        <div className={styles.field} data-wide={id.length > LONG_ID || undefined}>
          <IdentityField label="Id" value={id} copyLabel="Copy id">
            {/* A very long id fades out at the edge instead of running under the next field; the title has it all. */}
            <span className={styles.idValue} title={id || undefined}><TextMorph className={styles.idMorph}>{id || "No id yet"}</TextMorph></span>
          </IdentityField>
          <Button variant="ghost" size="sm" className={styles.fieldAction} onClick={onChangeId}>Change id</Button>
          {reserved ? <span className={styles.fieldNote}><span className="mono">{reserved.id}</span> is reserved for you until {formatDate(reserved.until)}.</span> : null}
        </div>
      </div>
      <div className={styles.foot}>
        {appsFailed ? (
          <span className={styles.stampsError} role="alert">
            <span>Your apps did not load, so their stamps are missing.</span>
            <Button variant="ghost" size="sm" onClick={onRetryApps}>Try again</Button>
          </span>
        ) : appsLoading ? (
          <span className={styles.stampsSkeleton} aria-hidden="true">
            {[0, 1, 2, 3].map(index => <SkeletonBlock key={index} width="40px" height="40px" radius="var(--radius-overlay)" index={index} />)}
          </span>
        ) : stamps.length ? (
          <StampRow apps={stamps} label="Apps you have signed into" />
        ) : (
          <span className={styles.noStamps}>Apps you sign into get a stamp here.</span>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Back({ me }: { me: Me }) {
  const card = useIdentityCard();
  const update = useUpdateProfile();
  const carbon = asCarbon(me);
  const silicon = asSilicon(me);
  return (
    <div className={styles.face}>
      <div className={styles.backHead}>
        <h2 className={styles.backTitle}>Details</h2>
      </div>
      <Button variant="secondary" size="sm" className={styles.turn} onClick={card.toggle}>
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        Back
      </Button>
      <dl className={styles.details}>
        {carbon ? (
          <>
            <Row label="Emails">
              {carbon.emails.length ? carbon.emails.map(email => (
                <span key={email.email} className={styles.contact}>
                  <span className={styles.contactText}>{email.email}</span>
                  {email.is_primary ? <Badge size="sm" tone="info">Primary</Badge> : null}
                </span>
              )) : <span className={styles.muted}>No email yet</span>}
            </Row>
            <Row label="Phone numbers">
              {carbon.phones.length ? carbon.phones.map(phone => (
                <span key={phone.phone} className={styles.contact}>
                  <span className={styles.contactText}>{formatPhone(phone.phone)}</span>
                  {phone.is_primary ? <Badge size="sm" tone="info">Primary</Badge> : null}
                </span>
              )) : <span className={styles.muted}>No phone number yet</span>}
            </Row>
          </>
        ) : null}
        {/* A Silicon's date of birth is the day its account was created: say that, not "date of birth". */}
        <Row label={carbon ? "Date of birth" : "Created"}>
          <span className={styles.valueLine}>
            <span>{formatDate(me.dob)}</span>
            {carbon ? <DobEditor value={me.dob} onSave={dob => update.mutateAsync({ dob })} /> : null}
          </span>
        </Row>
        <Row label="uuid">
          {/* For support and for apps: it never changes, but it is not who you are, so it lives on the back. */}
          <span className={styles.valueLine}>
            <span className={`mono ${styles.contactText}`}>{me.uuid}</span>
            <CopyButton value={me.uuid} label="Copy uuid for support" iconOnly variant="plain" />
          </span>
          <span className={styles.muted}>Never changes. Apps and support know you by it.</span>
        </Row>
        {silicon ? (
          <>
            <Row label="Custodian"><span className="mono">{silicon.custodian?.id ?? "Waiting for a custodian to accept"}</span></Row>
            <Row label="Webhook"><span className={styles.contactText}>{silicon.webhook_url ?? "Not set"}</span></Row>
            <Row label="STK rotated">{stkRotatedAt(silicon) ? formatDate(stkRotatedAt(silicon)) : "Never"}</Row>
          </>
        ) : null}
      </dl>
      {carbon ? (
        <Link href={paths.signInMethods} className={styles.backLink}>
          Add or remove emails and phone numbers
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Beside the card                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Beside the card: a metric card per pillar you can open (apps you are signed into, Silicons in your care, your ways in).
 * Wayfinding only; decisions are made in the attention strip, and the full history is on Activity.
 */
function Glance({ me, apps, appsFailed }: { me: Me; apps: MyApp[] | undefined; appsFailed: boolean }) {
  const carbon = asCarbon(me);
  const signedInto = apps?.filter(item => item.status === "active").length;
  const cards: Array<{ label: string; value: number | undefined; context: string; failed?: boolean; href: string }> = [
    { label: "Apps", value: signedInto, context: "Apps you are signed into", failed: appsFailed, href: paths.apps },
    ...(carbon
      ? [
        { label: "Silicons", value: carbon.custodian_of, context: "Silicons in your care", href: paths.silicons },
        { label: "Ways in", value: carbon.emails.length + carbon.phones.length, context: "Emails and phone numbers you sign in with", href: paths.signInMethods },
      ]
      : []),
  ];
  return (
    <aside className={styles.glance} aria-label="At a glance">
      {cards.map((card, index) => (
        <Link key={card.label} href={card.href} className={styles.glanceLink} aria-label={card.value === undefined ? card.context : `${card.context}: ${card.value}`}>
          {card.value !== undefined ? (
            <MetricCard label={card.label} value={card.value} context={card.context} />
          ) : card.failed ? (
            <Alert tone="warning" title={`${card.label} did not load`}>Open the page to try again.</Alert>
          ) : (
            <SkeletonBlock width="100%" height="128px" radius="var(--radius-container)" index={index} />
          )}
        </Link>
      ))}
    </aside>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Skeleton                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

function LayoutSkeleton() {
  return (
    <div className={styles.layout} aria-busy="true" aria-label="Loading your identity">
      <SkeletonBlock width="min(100%, 640px)" height="392px" radius="var(--radius-overlay)" />
      <div className={styles.glance}>
        {[0, 1, 2].map(index => <SkeletonBlock key={index} width="100%" height="128px" radius="var(--radius-container)" index={index + 1} />)}
      </div>
    </div>
  );
}
