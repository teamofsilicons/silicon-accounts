"use client";

/**
 * Personal info (/personal): the signed-in account's identity card. What needs a decision and the way into each section
 * are on Home (overview/overview.tsx).
 *
 * - The identity card, laid out as a form: every mark on it is a field. The front is for recognition: who issued it,
 *   which kind of account it is, the holder's custody relationship, whether it is valid, the photo (drop a new one on
 *   it), name (edit in place), id (change it; the old one stays reserved for 10 days), when it was issued and a stamp
 *   for every app you signed into (a Silicon's creation date is its Issued date). Turn it over for your emails, phone
 *   numbers and date of birth, the card number (your uuid, to copy for support) and a Silicon's webhook and STK. Your
 *   timezone lives in Settings.
 */
import { useRef, useState } from "react";
import { AtSign } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { InlineEdit } from "@teamofsilicons/silicon-ui/inline-edit";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { IdentityCard, type StampProps } from "@/components/foundation/identity/identity-card";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { Me } from "@/lib/api/types";
import { useRegisterCommands } from "@/lib/commands";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useRemovePhoto, useUpdateProfile, useUploadPhoto } from "@/lib/query/account";
import { useMe } from "@/lib/query/session";
import { appLogo, describeError, reasonError } from "../parts/common";
import { DobEditor } from "../parts/detail-editors";
import { IdChangeForm } from "../parts/id-change-form";
import { PhotoControl } from "../parts/photo-control";
import { useChangeOwnId, useEveryApp } from "../parts/queries";
import { BackFace, FrontFace } from "./faces";
import styles from "./identity.module.css";

const RESERVED_DAYS = 10;

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
      <PageHeader title="Personal info" description="How Carbons, Silicons and apps see you. Your id is yours to change." />
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
/* The card: the faces (faces.tsx) with this account's live controls                                                  */
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
  const update = useUpdateProfile();
  const upload = useUploadPhoto();
  const removePhoto = useRemovePhoto();
  const saveName = async (next: string) => {
    try {
      await update.mutateAsync({ display_name: next });
    } catch (error) {
      throw reasonError(error);
    }
  };
  return (
    <FrontFace
      me={me}
      stamps={stamps}
      appsLoading={appsLoading}
      appsFailed={appsFailed}
      onRetryApps={onRetryApps}
      photo={(
        <PhotoControl
          name={me.display_name}
          src={me.pfp_url}
          size={120}
          upload={file => upload.mutateAsync(file)}
          remove={() => removePhoto.mutateAsync()}
          audience={me.kind === "carbon" ? "Every app that can see your profile sees it." : "Every app this Silicon signs into sees it."}
        />
      )}
      name={<InlineEdit as="p" variant="title" className={styles.name} label="Display name" value={me.display_name} onSave={saveName} validate={validateName} />}
      idNote={reserved ? <><span className="mono">{reserved.id}</span> is reserved for you until {formatDate(reserved.until)}.</> : null}
      idAction={<Button variant="ghost" size="sm" className={styles.rowAction} onClick={onChangeId}>Change id</Button>}
    />
  );
}

function Back({ me }: { me: Me }) {
  const update = useUpdateProfile();
  return <BackFace me={me} manageLink dobAction={<DobEditor value={me.dob} onSave={dob => update.mutateAsync({ dob })} />} />;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Skeleton                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

function LayoutSkeleton() {
  return (
    <div className={styles.layout} aria-busy="true" aria-label="Loading your personal info">
      <SkeletonBlock width="min(100%, 640px)" height="392px" radius="var(--radius-overlay)" />
    </div>
  );
}
