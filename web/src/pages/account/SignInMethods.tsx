/**
 * /sign-in-methods: every way to sign in to this account. Up to 10 emails and 10 phone numbers, all verified with a
 * 6-digit code before they count; one of each is primary (apps that can see your email or phone get the primary one).
 * The primary one cannot be removed until another is made primary. Below them, the Google and Apple accounts linked to
 * this account.
 */
import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { api, type CarbonMe, type EmailView, type IdentityView, type Meta, type PhoneView } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { Badge } from "../../arc/badge/badge";
import { Button } from "../../arc/button/button";
import { ConfirmMorph } from "../../arc/confirm-morph/confirm-morph";
import { EmptyState } from "../../arc/empty-state/empty-state";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { AnimatedCounter } from "../../arc/animated-counter/animated-counter";
import { useSquircle } from "../../arc/lib/squircle";
import { Page, PageHeader, Section } from "../../app/layout/layout";
import { notifyError } from "../../app/notify";
import { firstPartySignInUrl, refreshMe, setMe } from "../../app/session";
import { paths } from "../../app/navigation";
import { formatDate, formatPhone, formatRelative } from "../../lib/format";
import { KeyRound } from "lucide-solid";
import { AnimatedRows } from "./parts/AnimatedRows";
import { ContactAdder } from "./parts/ContactAdder";
import { asCarbon, asSilicon, createLoader, createNow, currentMe, describeError, meError, reportFailure } from "./parts/common";
import { focusAfterRemoval } from "./parts/focus";
import styles from "./parts/contact.module.css";
import "./parts/telemetry";

const LIMIT = 10;

/** Applies a change to the signed-in Carbon's Me view (every page reading Me follows). */
function updateCarbon(change: (carbon: CarbonMe) => CarbonMe) {
  setMe(previous => (previous && previous.kind === "carbon" ? change(previous) : (previous as unknown as CarbonMe)));
}

/** The browser's region (en-IN → IN) as the default country for local phone numbers. */
function defaultCountry(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    if (region && /^[A-Z]{2}$/.test(region)) return region;
  } catch {
    // Fall through to US.
  }
  return "US";
}

export default function SignInMethods() {
  const meta = createLoader(() => api.meta.get());
  return (
    <Page width="narrow">
      <PageHeader title="Sign-in methods" description="Every email, phone number and Google or Apple account here signs you in to the same account." />
      <Switch fallback={<MethodsSkeleton />}>
        <Match when={meError()}>
          {error => <Alert tone="danger" title="Your sign-in methods did not load" action={<Button variant="secondary" onClick={() => refreshMe()}>Try again</Button>}>{describeError(error())}</Alert>}
        </Match>
        <Match when={asSilicon(currentMe())}>
          {silicon => (
            <EmptyState
              icon={<KeyRound width={24} height={24} stroke-width={1.5} />}
              title="Silicons sign in with an STK"
              description={`${silicon().id ?? "This Silicon"} signs in with its si:id and STK, not with emails or phone numbers. Its custodian can rotate the STK.`}
            />
          )}
        </Match>
        <Match when={asCarbon(currentMe())}>
          {carbon => (
            <>
              <ContactSection channel="email" carbon={carbon()} />
              <ContactSection channel="phone" carbon={carbon()} />
              <ProvidersSection carbon={carbon()} meta={meta.data()} />
            </>
          )}
        </Match>
      </Switch>
    </Page>
  );
}

/* ------------------------------------------------ emails and phones ------------------------------------------------ */

type Contact = EmailView | PhoneView;

function ContactSection(props: { channel: "email" | "phone"; carbon: CarbonMe }) {
  const isEmail = () => props.channel === "email";
  const items = (): Contact[] => (isEmail() ? props.carbon.emails : props.carbon.phones);
  const valueOf = (item: Contact) => ("email" in item ? item.email : item.phone);
  const shown = (value: string) => (isEmail() ? value : formatPhone(value));
  const noun = () => (isEmail() ? "email" : "phone number");
  const plural = () => (isEmail() ? "emails" : "phone numbers");
  const setList = (list: Contact[]) => updateCarbon(carbon => (isEmail() ? { ...carbon, emails: list as EmailView[] } : { ...carbon, phones: list as PhoneView[] }));
  const [promoting, setPromoting] = createSignal<string | null>(null);

  const makePrimary = async (value: string) => {
    const before = items();
    setPromoting(value);
    // Optimistic: the badge moves at once, and moves back if the server says no.
    setList(before.map(item => ({ ...item, is_primary: valueOf(item) === value })));
    try {
      setList(isEmail() ? await api.me.emails.makePrimary(value) : await api.me.phones.makePrimary(value));
    } catch (error) {
      setList(before);
      notifyError(error, `${shown(value)} is not your primary ${noun()}`);
    } finally {
      setPromoting(null);
    }
  };

  let group: HTMLDivElement | undefined;
  const remove = async (value: string) => {
    if (isEmail()) await api.me.emails.remove(value);
    else await api.me.phones.remove(value);
    // Let "Removed" show in place, then fold the row away; focus goes to the next one, else to adding one.
    window.setTimeout(() => {
      setList(items().filter(item => valueOf(item) !== value));
      focusAfterRemoval(() => group?.querySelector('[role="list"]'), () => group?.querySelector<HTMLElement>(`.${styles.adderRow} button`));
    }, 700);
  };

  const sorted = createMemo(() => [...items()].sort((a, b) => Number(b.is_primary) - Number(a.is_primary)));
  const count = () => items().length;

  return (
    <Section
      title={isEmail() ? "Emails" : "Phone numbers"}
      description={isEmail()
        ? "A code sent to any of these signs you in. Apps that can see your email get the primary one."
        : "A code texted to any of these signs you in. Apps that can see your phone number get the primary one."}
      actions={<span class={styles.count} aria-label={`${count()} of ${LIMIT} ${plural()}`}><AnimatedCounter value={count()} size="inline" /> of {LIMIT}</span>}
    >
      <div ref={el => { group = el; useSquircle(el); }} class={styles.group}>
        <AnimatedRows items={sorted()} keyOf={valueOf} label={isEmail() ? "Your emails" : "Your phone numbers"}>
          {item => (
            <ContactRow
              value={valueOf(item())}
              shown={shown(valueOf(item()))}
              item={item()}
              noun={noun()}
              promoting={promoting() === valueOf(item())}
              busy={promoting() !== null}
              onMakePrimary={() => void makePrimary(valueOf(item()))}
              onRemove={() => remove(valueOf(item()))}
            />
          )}
        </AnimatedRows>
        <Show when={count() === 0}>
          <p class={styles.emptyRow}>No {noun()} yet. Add one to sign in with a code.</p>
        </Show>
        <div class={styles.adderRow}>
          <Show
            when={count() < LIMIT}
            fallback={<p class={styles.limit}>You have {LIMIT} {plural()}, the most an account can hold. Remove one to add another.</p>}
          >
            <ContactAdder
              channel={props.channel}
              existing={items().map(valueOf)}
              defaultCountry={defaultCountry()}
              onAdded={list => setList(list as Contact[])}
            />
          </Show>
        </div>
      </div>
    </Section>
  );
}

function verifiedText(item: Contact): string {
  if (!item.verified_at) return "Not verified yet. Sign in once with a code sent to it to verify it.";
  const via = "verified_via" in item ? item.verified_via : "code";
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

function ContactRow(props: ContactRowProps) {
  const [error, setError] = createSignal<string | null>(null);
  return (
    <div class={styles.row} data-primary={props.item.is_primary || undefined}>
      <div class={styles.rowMain}>
        <div class={styles.rowTitle}>
          <span class={styles.value} title={props.value}>{props.shown}</span>
          <Show when={props.item.is_primary}><Badge size="sm" tone="info">Primary</Badge></Show>
          <Show when={!props.item.verified_at}><Badge size="sm" tone="warning">Not verified</Badge></Show>
        </div>
        <span class={styles.rowMeta}>
          <Show when={props.item.is_primary} fallback={verifiedText(props.item)}>
            Your primary {props.noun}. To remove it, make another {props.noun} primary first.
          </Show>
        </span>
        <Show when={error()}><span class={styles.rowError} role="alert">{error()}</span></Show>
      </div>
      <div class={styles.rowActions}>
        <Show when={!props.item.is_primary && props.item.verified_at}>
          <Button variant="ghost" size="sm" onClick={() => props.onMakePrimary()} loading={props.promoting} disabled={props.busy && !props.promoting}>Make primary</Button>
        </Show>
        <ConfirmMorph
          label="Remove"
          prompt={`Remove ${props.shown}?`}
          confirmLabel="Remove"
          pendingLabel="Removing"
          doneLabel="Removed"
          disabled={props.item.is_primary}
          onConfirm={() => { setError(null); return props.onRemove(); }}
          onError={raw => setError(reportFailure(raw, `${props.shown} was not removed`))}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------- google and apple ------------------------------------------------- */

const PROVIDER_NAMES = { google: "Google", apple: "Apple" } as const;

function ProviderMark(props: { provider: "google" | "apple" }) {
  return (
    <span class={styles.providerMark} aria-hidden="true">
      <Show
        when={props.provider === "google"}
        fallback={<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M16.37 12.65c-.02-2.13 1.74-3.15 1.82-3.2-.99-1.45-2.54-1.65-3.09-1.67-1.31-.13-2.57.78-3.24.78-.67 0-1.7-.76-2.8-.74-1.44.02-2.77.84-3.51 2.13-1.5 2.6-.38 6.44 1.08 8.55.71 1.03 1.56 2.19 2.67 2.15 1.07-.04 1.48-.69 2.77-.69 1.29 0 1.66.69 2.79.67 1.15-.02 1.88-1.05 2.58-2.08.81-1.19 1.15-2.35 1.17-2.41-.03-.01-2.24-.86-2.24-3.49ZM14.25 6.38c.59-.71.99-1.71.88-2.7-.85.03-1.88.57-2.49 1.28-.55.63-1.03 1.64-.9 2.61.95.07 1.92-.48 2.51-1.19Z" /></svg>}
      >
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
          <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
        </svg>
      </Show>
    </span>
  );
}

function ProvidersSection(props: { carbon: CarbonMe; meta: Meta | undefined }) {
  const now = createNow(60_000);
  const identities = () => props.carbon.identities;
  let group: HTMLDivElement | undefined;
  const remove = async (identity: IdentityView) => {
    await api.me.identities.remove(identity.provider, identity.subject);
    window.setTimeout(() => {
      updateCarbon(carbon => ({ ...carbon, identities: carbon.identities.filter(item => !(item.provider === identity.provider && item.subject === identity.subject)) }));
      focusAfterRemoval(() => group?.querySelector('[role="list"]'), () => group?.querySelector<HTMLElement>(`.${styles.connectButtons} button`));
    }, 700);
  };
  const connectable = () => (["google", "apple"] as const).filter(provider => props.meta?.providers[provider] && !identities().some(item => item.provider === provider));
  /**
   * Linking is a fresh sign-in with the provider (there is no endpoint that ties a provider to the signed-in account
   * yet). Google gets a hint: an email of this account, a Gmail address first, so its chooser offers the right account.
   */
  const hint = () => {
    const emails = props.carbon.emails.filter(item => item.verified_at).map(item => item.email);
    return emails.find(email => /@(gmail|googlemail)\.com$/i.test(email)) ?? props.carbon.emails.find(item => item.is_primary)?.email ?? emails[0];
  };
  const connect = (provider: "google" | "apple") =>
    location.assign(firstPartySignInUrl(paths.signInMethods, { method: provider, prompt: "login", login_hint: provider === "google" ? hint() : undefined }));
  return (
    <Section title="Google and Apple" description="Sign in with these instead of a code. Unlinking one only stops it signing you in; your emails stay.">
      <div ref={el => { group = el; useSquircle(el); }} class={styles.group}>
        <AnimatedRows items={identities()} keyOf={item => `${item.provider}:${item.subject}`} label="Linked Google and Apple accounts">
          {identity => <IdentityRow identity={identity()} now={now()} onRemove={() => remove(identity())} />}
        </AnimatedRows>
        <Show when={identities().length === 0}>
          <p class={styles.emptyRow}>No Google or Apple account is linked yet.</p>
        </Show>
        <Show when={connectable().length}>
          <div class={styles.connect}>
            <p class={styles.connectText}>
              To link one, sign in with it using an email that is already on this account; it links itself. Its email decides
              which account you end up in: one on another account signs this browser in to that account instead, and one on no
              account starts a new account. To add a new email, add it above with a code.
            </p>
            <div class={styles.connectButtons}>
              <For each={connectable()}>
                {provider => (
                  <Button variant="secondary" size="sm" onClick={() => connect(provider)}>
                    <ProviderMark provider={provider} />Sign in with {PROVIDER_NAMES[provider]}
                  </Button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </Section>
  );
}

function IdentityRow(props: { identity: IdentityView; now: number; onRemove: () => Promise<unknown> }) {
  const [error, setError] = createSignal<string | null>(null);
  const name = () => PROVIDER_NAMES[props.identity.provider];
  return (
    <div class={styles.row}>
      <div class={styles.rowLead}>
        <ProviderMark provider={props.identity.provider} />
        <div class={styles.rowMain}>
          <div class={styles.rowTitle}>
            <span class={styles.value}>{name()}</span>
            <Show when={props.identity.email}><span class={styles.valueSecondary} title={props.identity.email ?? ""}>{props.identity.email}</span></Show>
          </div>
          <span class={styles.rowMeta}>
            Linked {formatDate(props.identity.created_at)}
            {props.identity.last_used_at ? ` · last used ${formatRelative(props.identity.last_used_at, props.now)}` : " · not used yet"}
          </span>
          <Show when={error()}><span class={styles.rowError} role="alert">{error()}</span></Show>
        </div>
      </div>
      <div class={styles.rowActions}>
        <ConfirmMorph
          label="Unlink"
          prompt={`Unlink ${name()}?`}
          confirmLabel="Unlink"
          pendingLabel="Unlinking"
          doneLabel="Unlinked"
          onConfirm={() => { setError(null); return props.onRemove(); }}
          onError={raw => setError(reportFailure(raw, `${name()} is still linked`))}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------- skeleton ---------------------------------------------------- */

function MethodsSkeleton() {
  return (
    <div class={styles.skeleton} aria-busy="true" aria-label="Loading your sign-in methods">
      <For each={[0, 1, 2]}>
        {index => (
          <div class={styles.skeletonSection}>
            <SkeletonBlock width="140px" height="22px" radius="8px" index={index * 3} />
            <SkeletonBlock width="100%" height={index === 2 ? "84px" : "176px"} radius="var(--radius-panel)" index={index * 3 + 1} />
          </div>
        )}
      </For>
    </div>
  );
}
