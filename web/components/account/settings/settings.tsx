"use client";

/**
 * /settings: your local time (the timezone every date on the site is shown in) and deleting the account. Where you are
 * signed in moved to the Security pillar (/sign-in-methods, components/account/security/sessions.tsx). A Carbon who is custodian of a
 * Silicon cannot delete their account until every Silicon has another custodian or is deleted, because a Silicon
 * always has exactly one.
 */
import { useState } from "react";
import { ArrowRight, Clock, Trash2 } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { HoldToConfirm } from "@teamofsilicons/silicon-ui/hold-to-confirm";
import { ButtonLink } from "@/components/foundation/button-link";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader, Section } from "@/components/foundation/layout/layout";
import { ApiError } from "@/lib/api/errors";
import type { AccountSummary } from "@/lib/api/types";
import { plural } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useDeleteAccount, useUpdateProfile } from "@/lib/query/account";
import { useMe } from "@/lib/query/session";
import { timezoneLabel, utcOffset } from "@/lib/timezones";
import { asCarbon, asSilicon, describeError } from "../parts/common";
import { TimezoneEditor } from "../parts/detail-editors";
import { useEverySilicon, useSetMeView } from "../parts/queries";
import styles from "./settings.module.css";

/**
 * The account is gone. DELETE /v1/me already ended every session of it and cleared this browser's session cookie, so
 * there is nothing left to sign out: POST /v1/session/signout could only answer 401, which the browser logs as a failed
 * request. Leave for the signed-out landing page with a full load, so nothing about the account stays in memory (the
 * page renders signed out on the server, since the request carries no session cookie).
 */
function leaveDeletedAccount(): void {
  window.location.replace(paths.home);
}

export function Settings() {
  const me = useMe();
  const updateProfile = useUpdateProfile();

  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);

  return (
    <Page width="narrow">
      <PageHeader title="Settings" description="Your local time and your account." />

      <Section title="Local time" description="Dates and times on this site, such as your activity, are shown in this timezone.">
        {me.data ? (
          <div data-sq="surface" className={styles.group}>
            <div className={styles.row}>
              <div className={styles.rowMain}>
                <Clock size={20} strokeWidth={1.75} aria-hidden="true" />
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>{timezoneLabel(me.data.timezone)}</span>
                  <span className={styles.rowMeta}>UTC{utcOffset(me.data.timezone)} · {me.data.timezone}</span>
                </span>
              </div>
              <TimezoneEditor value={me.data.timezone} onSave={timezone => updateProfile.mutateAsync({ timezone })} />
            </div>
          </div>
        ) : me.error ? null : (
          <SkeletonBlock width="100%" height="72px" radius="var(--radius-container)" />
        )}
      </Section>

      <Section title="Where you are signed in" description="Browsers, terminals and the developer platform signed in to this account are now on Security.">
        <div>
          <ButtonLink href={paths.signInMethods} variant="secondary" size="sm">
            See where you are signed in
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </ButtonLink>
        </div>
      </Section>

      <Section title="Delete your account">
        {me.error && !me.data ? (
          <Alert tone="danger" title="Your account did not load">
            {describeError(me.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
          </Alert>
        ) : silicon ? (
          <div data-sq="surface" className={styles.danger}>
            <p className={styles.dangerText}>
              A Silicon&apos;s account is deleted by its custodian. Ask {silicon.custodian?.id ?? "your custodian"} to delete {silicon.id ?? "this Silicon"} on their Silicons page or with <code className={styles.code}>silicon-accounts silicon delete</code>.
            </p>
          </div>
        ) : carbon ? (
          <DeleteAccount id={carbon.id ?? carbon.uuid} custodianOf={carbon.custodian_of} onDeleted={leaveDeletedAccount} />
        ) : (
          <SkeletonBlock width="100%" height="180px" radius="var(--radius-surface)" />
        )}
      </Section>
    </Page>
  );
}

/** `onDeleted` runs once "Deleted" has shown in place; the session is already gone by then (never sign it out). */
function DeleteAccount({ id, custodianOf, onDeleted }: { id: string; custodianOf: number; onDeleted: () => void }) {
  const [phase, setPhase] = useState<"idle" | "pending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<AccountSummary[] | null>(null);
  const silicons = useEverySilicon();
  const remove = useDeleteAccount();
  const view = useSetMeView();
  const listed: AccountSummary[] = (silicons.data?.items ?? []).map(item => ({ uuid: item.uuid, kind: "silicon", id: item.id, display_name: item.display_name, pfp_url: item.pfp_url, status: item.status }));
  const blocking = blockers ?? (custodianOf > 0 ? listed : []);
  const blocked = custodianOf > 0 || (blockers?.length ?? 0) > 0;

  const deleteAccount = async () => {
    setPhase("pending");
    setError(null);
    try {
      await remove.mutateAsync(id);
      setPhase("done");
      window.setTimeout(onDeleted, 900);
    } catch (raw) {
      setPhase("idle");
      const failure = ApiError.from(raw);
      if (failure.code === "custodian_of_silicons" && Array.isArray(failure.details.silicons)) {
        setBlockers(failure.details.silicons as AccountSummary[]);
        void view.refresh();
      }
      setError(describeError(failure));
    }
  };

  return (
    <div data-sq="surface" className={styles.danger}>
      {blocked ? (
        <div className={styles.blocked}>
          <p className={styles.dangerText}>
            You look after {plural(blocking.length || custodianOf, "Silicon")}. Every Silicon always has exactly one custodian, so hand each one to
            another Carbon, or delete it, before you delete your account.
          </p>
          {blocking.length ? (
            <ul className={styles.blockers} role="list">
              {blocking.map(item => (
                <li key={item.uuid} className={styles.blocker}>
                  <Avatar name={item.display_name} src={item.pfp_url} size="sm" />
                  <span className={styles.blockerName}>{item.display_name}</span>
                  <span className="mono">{item.id ?? item.uuid}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <ButtonLink href={paths.silicons} variant="secondary" size="sm" className={styles.blockedLink}>
            Hand over or delete your Silicons
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </ButtonLink>
        </div>
      ) : (
        <p className={styles.dangerText}>
          Your account ends for good. Every app you signed into is told and loses access, your sessions and user verifications end, your
          emails and phone numbers are freed, and <span className="mono">{id}</span> stays reserved for 10 days before anyone
          can take it. This cannot be undone.
        </p>
      )}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.dangerAction}>
        <HoldToConfirm
          label="Hold to delete your account"
          confirmedLabel={phase === "pending" ? "Deleting" : "Deleted"}
          confirmed={phase !== "idle"}
          duration={2000}
          tone="danger"
          disabled={blocked}
          icon={<Trash2 size={18} strokeWidth={1.75} />}
          onConfirm={() => void deleteAccount()}
        />
        {blocked ? <span className={styles.disabledNote}>Unavailable while you are custodian of a Silicon.</span> : null}
      </div>
    </div>
  );
}
