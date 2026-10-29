"use client";

/**
 * The identity card's two faces, laid out as a form (see identity.tsx). They draw an account and leave the editable
 * parts to the caller through slots (the photo, the name, the id's action, the date of birth's editor), so they load
 * nothing themselves: the home passes live controls, and the public landing page passes a sample with none
 * (sample.tsx), outside any QueryClient.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { CopyButton } from "@teamofsilicons/silicon-ui/copy-button";
import { TextMorph } from "@teamofsilicons/silicon-ui/text-morph";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { StampRow, useIdentityCard, type StampProps } from "@/components/foundation/identity/identity-card";
import type { AccountStatus, Me } from "@/lib/api/types";
import { formatDate, formatPhone, kindNoun, plural } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { asCarbon, asSilicon, stkRotatedAt } from "../parts/common";
import styles from "./identity.module.css";

/** What the card says about the account's standing, and the tone it is printed in. */
const STATUS: Record<AccountStatus, { label: string; tone: "valid" | "pending" | "ended" }> = {
  active: { label: "Valid", tone: "valid" },
  pending_custodian: { label: "Waiting for custodian", tone: "pending" },
  unclaimed: { label: "Unclaimed", tone: "pending" },
  deleted: { label: "Deleted", tone: "ended" },
};

/** One line about the holder's custody relationship: whom a Silicon answers to, or how many Silicons a Carbon keeps. */
function holderLine(me: Me): string | null {
  const silicon = asSilicon(me);
  if (silicon) {
    const custodian = silicon.custodian?.id ?? silicon.custodian?.display_name;
    return custodian ? `In the care of ${custodian}.` : "Waiting for a custodian to accept.";
  }
  const carbon = asCarbon(me);
  return carbon && carbon.custodian_of > 0 ? `The holder looks after ${plural(carbon.custodian_of, "Silicon")}.` : null;
}

/** A labelled field on a ruled line, as on a printed form. */
function Field({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>
        {children}
        {note ? <span className={styles.note}>{note}</span> : null}
      </dd>
    </div>
  );
}

function Issuer({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.issuer}>
      <span className={styles.label}>Silicon Accounts</span>
      <h2 className={styles.cardType}>{title}</h2>
      {children}
    </div>
  );
}

export interface FrontFaceProps {
  me: Me;
  /** The portrait: the photo control on the home, a plain avatar elsewhere. */
  photo: ReactNode;
  /** The display name: edit in place on the home, plain text elsewhere. */
  name: ReactNode;
  stamps: StampProps[];
  appsLoading?: boolean;
  appsFailed?: boolean;
  onRetryApps?: () => void;
  /** Under the id, such as the id kept reserved after a change. */
  idNote?: ReactNode;
  /** Beside the id, such as Change id. */
  idAction?: ReactNode;
}

export function FrontFace({ me, photo, name, stamps, appsLoading = false, appsFailed = false, onRetryApps, idNote, idAction }: FrontFaceProps) {
  const card = useIdentityCard();
  const id = me.id ?? "";
  const status = STATUS[me.status] ?? STATUS.active;
  const holder = holderLine(me);
  return (
    <div className={styles.face}>
      <div className={styles.sheet}>
        <Issuer title={`${kindNoun(me.kind)} identity card`}>
          {holder ? <p className={styles.holder}>{holder}</p> : null}
        </Issuer>
        <p className={styles.status}>
          <span className={styles.label}>Status</span>
          <span className={styles.statusValue} data-tone={status.tone}>{status.label}</span>
        </p>
        {/* The crop marks frame the drop target: drop an image anywhere inside them. */}
        <div className={styles.photo}>
          <span className={styles.crop} aria-hidden="true" />
          {photo}
        </div>
        <dl className={styles.form}>
          <Field label="Name">{name}</Field>
          <Field label="Id" note={idNote}>
            <span className={styles.valueLine}>
              {/* A very long id fades out at the edge instead of running under the button; the title has it all. */}
              <span className={styles.idValue} title={id || undefined}><TextMorph className={styles.idMorph}>{id || "No id yet"}</TextMorph></span>
              {id ? <CopyButton value={id} label="Copy id" iconOnly variant="plain" /> : null}
              {idAction}
            </span>
          </Field>
          <Field label="Issued">{formatDate(me.created_at)}</Field>
        </dl>
      </div>
      <div className={styles.foot}>
        <div className={styles.signedInto}>
          <span className={styles.label}>Signed into</span>
          {appsFailed ? (
            <span className={styles.stampsError} role="alert">
              <span>Your apps did not load, so their stamps are missing.</span>
              {onRetryApps ? <Button variant="ghost" size="sm" onClick={onRetryApps}>Try again</Button> : null}
            </span>
          ) : appsLoading ? (
            <span className={styles.stampsSkeleton} aria-hidden="true">
              {[0, 1, 2, 3].map(index => <SkeletonBlock key={index} width="40px" height="40px" radius="var(--radius-overlay)" index={index} />)}
            </span>
          ) : stamps.length ? (
            <StampRow apps={stamps} label="Apps you have signed into" />
          ) : (
            <span className={styles.muted}>No apps yet. Each app you sign into adds its stamp here.</span>
          )}
        </div>
        {/* In the same corner as the back's Back button, so the card turns over under the pointer and back again. */}
        <Button variant="secondary" size="sm" className={styles.turn} onClick={card.toggle}>
          Details
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export interface BackFaceProps {
  me: Me;
  /** Beside a Carbon's date of birth, such as its editor. */
  dobAction?: ReactNode;
  /** The way to Security to manage emails and phones (Carbons, on the home). */
  manageLink?: boolean;
}

export function BackFace({ me, dobAction, manageLink = false }: BackFaceProps) {
  const card = useIdentityCard();
  const carbon = asCarbon(me);
  const silicon = asSilicon(me);
  const rotated = silicon ? stkRotatedAt(silicon) : null;
  return (
    <div className={styles.face}>
      <Issuer title="Card details" />
      <dl className={styles.form}>
        {carbon ? (
          <>
            <Field label="Emails">
              {carbon.emails.length ? carbon.emails.map(email => (
                <span key={email.email} className={styles.contact}>
                  <span className={styles.contactText}>{email.email}</span>
                  {email.is_primary ? <Badge size="sm" tone="info">Primary</Badge> : null}
                </span>
              )) : <span className={styles.muted}>No email yet</span>}
            </Field>
            <Field label="Phones">
              {carbon.phones.length ? carbon.phones.map(phone => (
                <span key={phone.phone} className={styles.contact}>
                  <span className={styles.contactText}>{formatPhone(phone.phone)}</span>
                  {phone.is_primary ? <Badge size="sm" tone="info">Primary</Badge> : null}
                </span>
              )) : <span className={styles.muted}>No phone number yet</span>}
            </Field>
          </>
        ) : null}
        {/* A Silicon's date of birth is the day its account was created, already on the front as Issued. */}
        {carbon ? (
          <Field label="Date of birth">
            <span className={styles.valueLine}>
              <span>{formatDate(me.dob)}</span>
              {dobAction}
            </span>
          </Field>
        ) : null}
        {/* The uuid is the card's number: it never changes, while the id on the front can. */}
        <Field label="Card no." note="Never changes. Apps and support know you by it.">
          <span className={styles.valueLine}>
            <span className={`mono ${styles.contactText}`}>{me.uuid}</span>
            <CopyButton value={me.uuid} label="Copy card number for support" iconOnly variant="plain" />
          </span>
        </Field>
        {silicon ? (
          <>
            <Field label="Webhook"><span className={styles.contactText}>{silicon.webhook_url ?? "Not set"}</span></Field>
            <Field label="STK rotated">{rotated ? formatDate(rotated) : "Never"}</Field>
          </>
        ) : null}
      </dl>
      <div className={styles.foot}>
        {carbon && manageLink ? (
          <Link href={paths.signInMethods} className={styles.backLink}>
            Add or remove emails and phone numbers
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </Link>
        ) : <span />}
        <Button variant="secondary" size="sm" className={styles.turn} onClick={card.toggle}>
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Back
        </Button>
      </div>
    </div>
  );
}
