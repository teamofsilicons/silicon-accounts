"use client";

/**
 * The identity home ("/" signed in): your identity as an object. The card carries your photo (drop a new one on it),
 * your display name (edit it in place), your id (change it; the old one stays reserved for you for 10 days), your
 * uuid, the time where you are, and a stamp for every app you have signed into. Turn it over for your emails, phone
 * numbers and date of birth. Beside it: requests waiting for you, counts that open each section, and your latest
 * activity.
 */
import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, AtSign, Inbox } from "lucide-react";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { AnimatedCounter } from "@/components/silicon-ui/animated-counter/animated-counter";
import { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { InlineEdit } from "@/components/silicon-ui/inline-edit/inline-edit";
import { TextMorph } from "@/components/silicon-ui/text-morph/text-morph";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { IdentityCard, IdentityField, LiveClock, StampRow, useIdentityCard, type StampProps } from "@/components/foundation/identity/identity-card";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { useTheme } from "@/components/foundation/theme/use-theme";
import { api } from "@/lib/api/endpoints";
import type { Me, MyApp } from "@/lib/api/types";
import { useRegisterCommands } from "@/lib/commands";
import { formatDate, formatPhone, formatRelative, kindNoun, plural } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useRemovePhoto, useUpdateProfile, useUploadPhoto } from "@/lib/query/account";
import { useMe } from "@/lib/query/session";
import { timezoneLabel, utcOffset } from "@/lib/timezones";
import { appLogo, asCarbon, asSilicon, describeError, readableTimes, reasonError, stkRotatedAt, useNow } from "../parts/common";
import { DobEditor, TimezoneEditor } from "../parts/detail-editors";
import { IdChangeForm } from "../parts/id-change-form";
import { PhotoControl } from "../parts/photo-control";
import { useChangeOwnId, useEveryApp, useEveryCustodianRequest } from "../parts/queries";
import partStyles from "../parts/parts.module.css";
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

  const stamps: StampProps[] = (apps.data?.items ?? [])
    .filter(item => item.status === "active")
    .map(item => ({ name: item.app.name, logoUrl: appLogo(item.app, theme), seed: item.app.app_id, href: `${paths.apps}#app-${item.app.app_id}` }));

  const account = me.data;
  return (
    <Page>
      <PageHeader title="Your identity" description="One account for every app you use. Apps keep your uuid; your id is yours to change." />
      {me.error && !account ? (
        <Alert tone="danger" title="Your account did not load">
          {describeError(me.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
        </Alert>
      ) : !account ? (
        <LayoutSkeleton />
      ) : (
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
            <span className={styles.since}>since {formatDate(me.created_at)}</span>
          </div>
        </div>
      </div>
      <div className={styles.fields}>
        <div className={styles.field} data-wide={id.length > LONG_ID || undefined}>
          <IdentityField label="Id" value={id} copyLabel="Copy id">
            {/* A very long id fades out at the edge instead of running under the next field; the title has it all. */}
            <span className={styles.idValue} title={id || undefined}><TextMorph className={styles.idMorph}>{id || "No id yet"}</TextMorph></span>
          </IdentityField>
          <button data-sq="surface" type="button" className={partStyles.textAction} onClick={onChangeId}>Change id</button>
          {reserved ? <span className={styles.fieldNote}><span className="mono">{reserved.id}</span> is reserved for you until {formatDate(reserved.until)}.</span> : null}
        </div>
        <div className={styles.field}>
          <IdentityField label="uuid" value={me.uuid} mono copyLabel="Copy uuid" />
          <span className={styles.fieldNote}>Never changes. Apps know you by it.</span>
        </div>
        <div className={styles.field}>
          <IdentityField label="Local time" value={me.timezone}>
            {/* The zone under the time wraps on narrow cards, but never inside its offset. */}
            <span className={styles.clock}>
              <LiveClock timeZone={me.timezone} showZone={false} />
              <span className={styles.zone}>{timezoneLabel(me.timezone)} · <span className={styles.offset}>UTC{utcOffset(me.timezone)}</span></span>
            </span>
          </IdentityField>
          <TimezoneEditor value={me.timezone} onSave={timezone => update.mutateAsync({ timezone })} />
        </div>
      </div>
      <div className={styles.foot}>
        {appsFailed ? (
          <span className={styles.stampsError} role="alert">
            <span>Your apps did not load, so their stamps are missing.</span>
            <button data-sq="surface" type="button" className={partStyles.textAction} onClick={onRetryApps}>Try again</button>
          </span>
        ) : appsLoading ? (
          <span className={styles.stampsSkeleton} aria-hidden="true">
            {[0, 1, 2, 3].map(index => <SkeletonBlock key={index} width="40px" height="40px" radius="12px" index={index} />)}
          </span>
        ) : stamps.length ? (
          <StampRow apps={stamps} label="Apps you have signed into" />
        ) : (
          <span className={styles.noStamps}>Apps you sign into get a stamp here.</span>
        )}
        <Button variant="secondary" size="sm" onClick={card.toggle}>
          Details
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </Button>
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
        <Button variant="ghost" size="sm" onClick={card.toggle}>
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Back
        </Button>
      </div>
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
        <Row label="Date of birth">
          <span className={styles.valueLine}>
            <span>{formatDate(me.dob)}</span>
            {carbon ? <DobEditor value={me.dob} onSave={dob => update.mutateAsync({ dob })} /> : null}
          </span>
          {silicon ? <span className={styles.muted}>A Silicon&apos;s date of birth is the day its account was created, so it never changes.</span> : null}
        </Row>
        <Row label="Timezone">
          <span>{timezoneLabel(me.timezone)} · <span className={styles.offset}>UTC{utcOffset(me.timezone)}</span></span>
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

/** A quiet column beside the card: requests waiting for you, counts that open each section, and recent activity. */
function Glance({ me, apps, appsFailed }: { me: Me; apps: MyApp[] | undefined; appsFailed: boolean }) {
  const now = useNow(30_000);
  const carbon = asCarbon(me);
  const requests = useEveryCustodianRequest();
  const recent = useQuery({
    queryKey: ["me", "history", "recent"],
    queryFn: () => api.me.history({ limit: 4 }).then(page => page.items),
  });
  const waiting = requests.data?.items.length ?? 0;
  const requestsFailed = !requests.data && !!requests.error;
  const rows: Array<{ label: string; value: number | undefined; failed?: boolean; href: string }> = [
    { label: "Apps you are signed into", value: apps?.filter(item => item.status === "active").length, failed: appsFailed, href: paths.apps },
    ...(carbon
      ? [
        { label: "Silicons in your care", value: carbon.custodian_of, href: paths.silicons },
        { label: "Emails and phone numbers", value: carbon.emails.length + carbon.phones.length, href: paths.signInMethods },
      ]
      : []),
  ];
  return (
    <aside className={styles.glance} aria-label="At a glance">
      {carbon && (waiting > 0 || requestsFailed) ? (
        <Link href={paths.silicons} data-sq="surface" className={styles.waiting}>
          <Inbox size={20} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles.waitingText}>
            {requestsFailed ? (
              <>
                <span className={styles.waitingTitle}>Custodian requests did not load</span>
                <span className={styles.waitingMeta}>A Silicon may be waiting for you. Open the Silicons page to see your requests.</span>
              </>
            ) : (
              <>
                <span className={styles.waitingTitle}>{plural(waiting, "custodian request")} waiting for you</span>
                <span className={styles.waitingMeta}>Accept or decline them on the Silicons page.</span>
              </>
            )}
          </span>
          <ArrowRight className={styles.glanceArrow} size={16} strokeWidth={1.75} aria-hidden="true" />
        </Link>
      ) : null}
      <div className={styles.counts}>
        {rows.map((row, index) => (
          <Link key={row.label} href={row.href} className={styles.glanceRow}>
            <span className={styles.glanceValue}>
              {row.value !== undefined ? <AnimatedCounter value={row.value} />
                : row.failed ? <><span aria-hidden="true">?</span><span className="sr-only">Did not load.</span></>
                  : <SkeletonBlock width="2ch" height="28px" radius="6px" index={index} />}
            </span>
            <span className={styles.glanceLabel}>
              {row.label}
              {row.failed && row.value === undefined ? <span className={styles.glanceFailed}>Did not load. Open the page to try again.</span> : null}
            </span>
            <ArrowRight className={styles.glanceArrow} size={16} strokeWidth={1.75} aria-hidden="true" />
          </Link>
        ))}
      </div>
      <section className={styles.recent} aria-labelledby="identity-recent">
        <div className={styles.recentHead}>
          <h2 id="identity-recent" className={styles.recentTitle}>Recent activity</h2>
          <Link href={paths.activity} className={styles.recentAll}>All activity</Link>
        </div>
        {recent.error && !recent.data ? (
          <p className={styles.muted}>Recent activity did not load. Open Activity to try again.</p>
        ) : !recent.data ? (
          <div className={styles.recentList}>
            {[0, 1, 2].map(index => <SkeletonBlock key={index} width="100%" height="40px" radius="10px" index={index} />)}
          </div>
        ) : recent.data.length === 0 ? (
          <p className={styles.muted}>Nothing yet. Sign-ins and changes to your account show up here.</p>
        ) : (
          <ol className={styles.recentList} role="list">
            {recent.data.slice(0, 4).map(item => (
              <li key={item.id} className={styles.recentItem}>
                <span className={styles.recentText}>{readableTimes(item.title)}</span>
                <time className={styles.recentTime} dateTime={item.at}>{formatRelative(item.at, now)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Skeleton                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

function LayoutSkeleton() {
  return (
    <div className={styles.layout} aria-busy="true" aria-label="Loading your identity">
      <SkeletonBlock width="min(100%, 640px)" height="392px" radius="var(--radius-surface)" />
      <div className={styles.glance}>
        {[0, 1, 2].map(index => <SkeletonBlock key={index} width="100%" height="56px" radius="12px" index={index + 1} />)}
      </div>
    </div>
  );
}
