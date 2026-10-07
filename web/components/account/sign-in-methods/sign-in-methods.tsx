"use client";

/**
 * /sign-in-methods: every way to sign in to this account. Up to 10 emails and 10 phone numbers, all verified with a
 * 6-digit code before they count; one of each is primary (apps that can see your email or phone get the primary one),
 * and the primary one cannot be removed until another is made primary. Below them, the Google and Apple accounts
 * connected to this account: connecting one adds its verified email without a code.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { AnimatedCounter } from "@/components/arc/animated-counter/animated-counter";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { ConfirmMorph } from "@/components/arc/confirm-morph/confirm-morph";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader, Section } from "@/components/foundation/layout/layout";
import type { CarbonMe, EmailView, IdentityView, Meta, PhoneView, Provider } from "@/lib/api/types";
import { formatDate, formatPhone, formatRelative } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useMakePrimaryEmail, useMakePrimaryPhone } from "@/lib/query/account";
import { useMe, useMeta } from "@/lib/query/session";
import { asCarbon, asSilicon, describeError, useNow } from "../parts/common";
import { FitPrompt } from "../parts/fit-prompt";
import { focusAfterRemoval } from "../parts/focus";
import { AnimatedRows } from "../parts/animated-rows";
import { useConnectProvider, useLinkFlow, useRemoveContact, useSetMeView, useUnlinkProvider } from "../parts/queries";
import { guessCountry } from "@/components/foundation/phone-field/phone-data";
import { ContactAdder } from "./contact-adder";
import styles from "./sign-in-methods.module.css";

const LIMIT = 10;
const PROVIDER_NAMES: Record<Provider, string> = { google: "Google", apple: "Apple" };

/** The visitor's likely country for local phone numbers: the timezone's country, else the browser language's region. */
const defaultCountry = (): string => guessCountry();

export function SignInMethods() {
  const me = useMe();
  const meta = useMeta();
  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);
  return (
    <Page width="narrow">
      <PageHeader title="Sign-in methods" description="Every email, phone number and Google or Apple account here signs you in to the same account." />
      {me.error && !me.data ? (
        <Alert tone="danger" title="Your sign-in methods did not load">
          {describeError(me.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
        </Alert>
      ) : silicon ? (
        <EmptyState
          icon={<KeyRound width={24} height={24} strokeWidth={1.5} />}
          title="Silicons sign in with an STK"
          description={`${silicon.id ?? "This Silicon"} signs in with its si:id and STK, not with emails or phone numbers. Its custodian can rotate the STK.`}
        />
      ) : carbon ? (
        <>
          <LinkResult />
          <ContactSection channel="email" carbon={carbon} />
          <ContactSection channel="phone" carbon={carbon} />
          <ProvidersSection carbon={carbon} meta={meta.data} metaError={meta.data ? null : meta.error} metaPending={meta.isPending} metaRetrying={meta.isFetching} onRetryMeta={() => void meta.refetch()} />
        </>
      ) : (
        <MethodsSkeleton />
      )}
    </Page>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Emails and phone numbers                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

type Contact = EmailView | PhoneView;
const valueOf = (item: Contact) => ("email" in item ? item.email : item.phone);

function ContactSection({ channel, carbon }: { channel: "email" | "phone"; carbon: CarbonMe }) {
  const isEmail = channel === "email";
  const items: Contact[] = isEmail ? carbon.emails : carbon.phones;
  const shown = (value: string) => (isEmail ? value : formatPhone(value));
  const noun = isEmail ? "email" : "phone number";
  const pluralNoun = isEmail ? "emails" : "phone numbers";
  const view = useSetMeView();
  const primaryEmail = useMakePrimaryEmail();
  const primaryPhone = useMakePrimaryPhone();
  const remove = useRemoveContact(channel);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [country] = useState(defaultCountry);
  const group = useRef<HTMLDivElement>(null);

  const makePrimary = async (value: string) => {
    setPromoting(value);
    // Optimistic: the badge moves at once, and moves back if the server says no (the hook toasts why).
    const previous = view.patch(me => (me.kind === "carbon"
      ? (isEmail
        ? { ...me, emails: me.emails.map(item => ({ ...item, is_primary: item.email === value })) }
        : { ...me, phones: me.phones.map(item => ({ ...item, is_primary: item.phone === value })) })
      : me));
    try {
      if (isEmail) await primaryEmail.mutateAsync(value);
      else await primaryPhone.mutateAsync(value);
    } catch {
      if (previous) view.set(previous);
    } finally {
      setPromoting(null);
    }
  };

  const removeOne = async (value: string) => {
    await remove.mutateAsync(value);
    // "Removed" shows in place, then the row folds away; focus goes to the next row, else to adding one.
    window.setTimeout(() => focusAfterRemoval(() => group.current?.querySelector('[role="list"]'), () => group.current?.querySelector<HTMLElement>("[data-adder] button")), 760);
  };

  const sorted = [...items].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  const count = items.length;

  return (
    <Section
      title={isEmail ? "Emails" : "Phone numbers"}
      description={isEmail
        ? "A code sent to any of these signs you in. Apps that can see your email get the primary one."
        : "A code texted to any of these signs you in. Apps that can see your phone number get the primary one."}
      actions={<span className={styles.count} aria-label={`${count} of ${LIMIT} ${pluralNoun}`}><AnimatedCounter value={count} /> of {LIMIT}</span>}
    >
      <div ref={group} data-sq="surface" className={styles.group}>
        <AnimatedRows items={sorted} keyOf={valueOf} label={isEmail ? "Your emails" : "Your phone numbers"}>
          {item => (
            <ContactRow
              value={valueOf(item)}
              shown={shown(valueOf(item))}
              item={item}
              noun={noun}
              promoting={promoting === valueOf(item)}
              busy={promoting !== null}
              onMakePrimary={() => void makePrimary(valueOf(item))}
              onRemove={() => removeOne(valueOf(item))}
            />
          )}
        </AnimatedRows>
        {count === 0 ? <p className={styles.emptyRow}>No {noun} yet. Add one to sign in with a code.</p> : null}
        <div className={styles.adderRow} data-adder="">
          {count < LIMIT
            ? <ContactAdder channel={channel} existing={items.map(valueOf)} defaultCountry={country} />
            : <p className={styles.limit}>You have {LIMIT} {pluralNoun}, the most an account can hold. Remove one to add another.</p>}
        </div>
      </div>
    </Section>
  );
}

function verifiedText(item: Contact): string {
  if (!item.verified_at) return "Not verified yet. Sign in once with a code sent to it to verify it.";
  const via = item.verified_via ?? "code";
  const how = via === "google" ? "Verified by Google" : via === "apple" ? "Verified by Apple" : "Verified with a code";
  return `${how} on ${formatDate(item.verified_at)}`;
}

interface ContactRowProps {
  value: string;
  shown: string;
  item: Contact;
  noun: string;
  promoting: boolean;
  busy: boolean;
  onMakePrimary: () => void;
  onRemove: () => Promise<unknown>;
}

function ContactRow({ value, shown, item, noun, promoting, busy, onMakePrimary, onRemove }: ContactRowProps) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={styles.row} data-primary={item.is_primary || undefined}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>
          <span className={styles.value} title={value}>{shown}</span>
          {item.is_primary ? <Badge size="sm" tone="info">Primary</Badge> : null}
          {!item.verified_at ? <Badge size="sm" tone="warning">Not verified</Badge> : null}
        </div>
        <span className={styles.rowMeta}>
          {item.is_primary ? `Your primary ${noun}. To remove it, make another ${noun} primary first.` : verifiedText(item)}
        </span>
        {error ? <span className={styles.rowError} role="alert">{error}</span> : null}
      </div>
      <div className={styles.rowActions}>
        {!item.is_primary && item.verified_at ? (
          <Button variant="ghost" size="sm" onClick={onMakePrimary} loading={promoting} disabled={busy && !promoting}>Make primary</Button>
        ) : null}
        <ConfirmMorph
          label="Remove"
          prompt={<FitPrompt full={`Remove ${shown}?`} short={noun === "email" ? "Remove this email?" : "Remove this number?"} tiny="Remove it?" />}
          confirmLabel="Remove"
          pendingLabel="Removing"
          doneLabel="Removed"
          disabled={item.is_primary}
          onConfirm={async () => {
            setError(null);
            try {
              await onRemove();
            } catch (raw) {
              setError(describeError(raw));
              throw raw;
            }
          }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Google and Apple                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

function ProviderMark({ provider }: { provider: Provider }) {
  return (
    <span className={styles.providerMark} aria-hidden="true">
      {provider === "google" ? (
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
          <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M16.37 12.65c-.02-2.13 1.74-3.15 1.82-3.2-.99-1.45-2.54-1.65-3.09-1.67-1.31-.13-2.57.78-3.24.78-.67 0-1.7-.76-2.8-.74-1.44.02-2.77.84-3.51 2.13-1.5 2.6-.38 6.44 1.08 8.55.71 1.03 1.56 2.19 2.67 2.15 1.07-.04 1.48-.69 2.77-.69 1.29 0 1.66.69 2.79.67 1.15-.02 1.88-1.05 2.58-2.08.81-1.19 1.15-2.35 1.17-2.41-.03-.01-2.24-.86-2.24-3.49ZM14.25 6.38c.59-.71.99-1.71.88-2.7-.85.03-1.88.57-2.49 1.28-.55.63-1.03 1.64-.9 2.61.95.07 1.92-.48 2.51-1.19Z" /></svg>
      )}
    </span>
  );
}

interface ProvidersSectionProps {
  carbon: CarbonMe;
  /** GET /v1/meta: whether Google and Apple can be connected on this deployment. */
  meta: Meta | undefined;
  metaError: unknown;
  metaPending: boolean;
  metaRetrying: boolean;
  onRetryMeta: () => void;
}

function ProvidersSection({ carbon, meta, metaError, metaPending, metaRetrying, onRetryMeta }: ProvidersSectionProps) {
  const now = useNow(60_000);
  const unlink = useUnlinkProvider();
  const connect = useConnectProvider();
  const [connecting, setConnecting] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const identities = carbon.identities;
  const connectable = (["google", "apple"] as const).filter(provider => meta?.providers[provider] && !identities.some(item => item.provider === provider));

  const remove = async (identity: IdentityView) => {
    await unlink.mutateAsync({ provider: identity.provider, subject: identity.subject });
    window.setTimeout(() => focusAfterRemoval(() => group.current?.querySelector('[role="list"]'), () => group.current?.querySelector<HTMLElement>("[data-connect] button")), 760);
  };

  /** The provider's sign-in page comes next (a full navigation); it sends the browser back here with the outcome. */
  const start = async (provider: Provider) => {
    setError(null);
    setConnecting(provider);
    try {
      const connection = await connect.mutateAsync({ provider, returnTo: paths.signInMethods });
      window.location.assign(connection.authorize_url);
    } catch (raw) {
      setError(describeError(raw));
      setConnecting(null);
    }
  };

  return (
    <Section title="Google and Apple" description="Sign in with these instead of a code. Unlinking one only stops it signing you in; your emails stay.">
      <div ref={group} data-sq="surface" className={styles.group}>
        <AnimatedRows items={identities} keyOf={item => `${item.provider}:${item.subject}`} label="Linked Google and Apple accounts">
          {identity => <IdentityRow identity={identity} now={now} onRemove={() => remove(identity)} />}
        </AnimatedRows>
        {identities.length === 0 ? <p className={styles.emptyRow}>No Google or Apple account is linked yet.</p> : null}
        {metaError ? (
          // Which providers this deployment offers comes from GET /v1/meta; without it there is nothing to connect yet.
          <div className={styles.connect} data-connect="">
            <Alert tone="danger" title="Connecting Google or Apple is unavailable for now">
              {describeError(metaError)}{identities.length ? " The accounts linked above still sign you in." : ""}
              <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={onRetryMeta} loading={metaRetrying}>Try again</Button></span>
            </Alert>
          </div>
        ) : metaPending ? (
          <div className={styles.connect} aria-busy="true" aria-label="Loading the ways to connect">
            <SkeletonBlock width="min(100%, 420px)" height="16px" radius="6px" />
            <span className={styles.connectButtons}>
              <SkeletonBlock width="148px" height="32px" index={1} />
              <SkeletonBlock width="136px" height="32px" index={2} />
            </span>
          </div>
        ) : connectable.length ? (
          <div className={styles.connect} data-connect="">
            <p className={styles.connectText}>
              Connect one to sign in with it. Its verified email is added to your emails without a code, unless another
              account already has that email.
            </p>
            {error ? <p className={styles.rowError} role="alert">{error}</p> : null}
            <div className={styles.connectButtons}>
              {connectable.map(provider => (
                <Button key={provider} variant="secondary" size="sm" onClick={() => void start(provider)} loading={connecting === provider} disabled={connecting !== null && connecting !== provider}>
                  <ProviderMark provider={provider} />
                  Connect {PROVIDER_NAMES[provider]}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function IdentityRow({ identity, now, onRemove }: { identity: IdentityView; now: number; onRemove: () => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const name = PROVIDER_NAMES[identity.provider];
  return (
    <div className={styles.row}>
      <div className={styles.rowLead}>
        <ProviderMark provider={identity.provider} />
        <div className={styles.rowMain}>
          <div className={styles.rowTitle}>
            <span className={styles.value}>{name}</span>
            {identity.email ? <span className={styles.valueSecondary} title={identity.email}>{identity.email}</span> : null}
          </div>
          <span className={styles.rowMeta}>
            Linked {formatDate(identity.created_at)}
            {identity.last_used_at ? ` · last used ${formatRelative(identity.last_used_at, now)}` : " · not used yet"}
          </span>
          {error ? <span className={styles.rowError} role="alert">{error}</span> : null}
        </div>
      </div>
      <div className={styles.rowActions}>
        <ConfirmMorph
          label="Unlink"
          prompt={<FitPrompt full={`Unlink ${name}?`} short={`Unlink ${name}?`} tiny="Unlink it?" />}
          confirmLabel="Unlink"
          pendingLabel="Unlinking"
          doneLabel="Unlinked"
          onConfirm={async () => {
            setError(null);
            try {
              await onRemove();
            } catch (raw) {
              setError(describeError(raw));
              throw raw;
            }
          }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Coming back from Google or Apple                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Plain words for the codes a connection can end with, when the flow cannot be read for its own message. */
const LINK_ERRORS: Record<string, string> = {
  identity_in_use: "That account already signs in to another Silicon Accounts account, so it cannot be connected to this one.",
  email_in_use: "Its email belongs to another account, so it was not connected. Sign in to that account to use it there.",
  email_limit_reached: "This account already has 10 emails. Remove one, then connect it again.",
  email_not_verified: "The provider has not verified its email, so it cannot be connected.",
  provider_email_invalid: "The provider sent an email address that cannot be used.",
  session_changed: "This browser signed in to another account while it was connecting. Connect it again.",
  provider_cancelled: "You cancelled it at the provider. Nothing changed.",
  provider_error: "The provider answered with an error. Nothing changed; try again.",
  provider_token_invalid: "The provider's answer could not be verified. Nothing changed; try again.",
  flow_expired: "It took too long, so the connection expired. Connect it again.",
};

/** The outcome of connecting Google or Apple (`?linked=…` or `?link_error=…`), read once; the address is cleaned up. */
function LinkResult() {
  const search = useSearchParams();
  const router = useRouter();
  const [result] = useState(() => {
    const linked = search.get("linked");
    const failed = search.get("link_error");
    const provider = (search.get("provider") ?? linked) as Provider | null;
    if (!linked && !failed) return null;
    return { linked: !!linked, emailAdded: search.get("email_added") === "true", provider: provider === "google" || provider === "apple" ? provider : null, code: failed, flow: search.get("flow") };
  });
  const [open, setOpen] = useState(true);
  const flow = useLinkFlow(result && !result.linked ? result.flow : null);
  useEffect(() => {
    if (result) router.replace(paths.signInMethods, { scroll: false });
  }, [result, router]);
  if (!result) return null;
  const name = result.provider ? PROVIDER_NAMES[result.provider] : "The account";
  if (result.linked) {
    return (
      <Alert tone="success" title={`${name} is connected`} open={open} onDismiss={() => setOpen(false)}>
        {result.emailAdded ? `It signs you in from now on, and its verified email was added to your emails.` : "It signs you in from now on. Its email was already on your account."}
      </Alert>
    );
  }
  // The flow has the precise reason; wait for it (a quick read) rather than swapping words in front of the reader.
  if (result.flow && flow.isPending) return null;
  const reason = flow.data?.error ? [flow.data.error.message, flow.data.error.hint].filter(Boolean).join(" ") : LINK_ERRORS[result.code ?? ""] ?? `Connecting it did not finish (${result.code}). Nothing changed; try again.`;
  return (
    <Alert tone="danger" title={`${name} was not connected`} open={open} onDismiss={() => setOpen(false)}>
      {reason}
    </Alert>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Skeleton                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

function MethodsSkeleton() {
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label="Loading your sign-in methods">
      {[0, 1, 2].map(index => (
        <div key={index} className={styles.skeletonSection}>
          <SkeletonBlock width="140px" height="22px" radius="8px" index={index * 3} />
          <SkeletonBlock width="100%" height={index === 2 ? "84px" : "176px"} radius="var(--radius-panel)" index={index * 3 + 1} />
        </div>
      ))}
    </div>
  );
}
