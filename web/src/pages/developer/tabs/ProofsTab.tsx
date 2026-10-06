/**
 * Proofs: Silicon Accounts only issues and verifies proofs; what each one allows is up to the apps.
 *  - ATA (app to app): this page stands in for Silicon Apps' ATA page. Pick the apps that may verify the proof, its
 *    scopes and the token lifetime; the proof token and its refresh token are shown once.
 *  - OBO (on behalf of): issued by the app's server with a user's access token after it got their consent.
 * Every proof this app issued is listed, and any can be revoked.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onMount } from "solid-js";
import { ArrowRight, ShieldCheck, X } from "lucide-solid";
import { api, ApiError, collectPages, createPagedList, type AppProof, type IssuedProof } from "../../../api";
import { Accordion } from "../../../arc/accordion/accordion";
import { Alert } from "../../../arc/alert/alert";
import { Avatar } from "../../../arc/avatar/avatar";
import { Badge } from "../../../arc/badge/badge";
import { Button } from "../../../arc/button/button";
import { CodeBlock } from "../../../arc/code-block/code-block";
import { ConfirmMorph } from "../../../arc/confirm-morph/confirm-morph";
import { EmptyState } from "../../../arc/empty-state/empty-state";
import { SegmentedControl } from "../../../arc/segmented-control/segmented-control";
import { Skeleton } from "../../../arc/skeleton/skeleton";
import { TagInput } from "../../../arc/tag-input/tag-input";
import { useSquircle } from "../../../arc/lib/squircle";
import { Section, Surface } from "../../../app/layout/layout";
import { notifyError } from "../../../app/notify";
import { formatDateTime, formatExpiry, formatRelative, plural } from "../../../lib/format";
import { lookupApp, rememberApp } from "../lib/apps";
import { useDeveloperApp } from "../lib/context";
import { actionKey } from "../lib/keys";
import { PROOF_STATUS, ttlLabel } from "../lib/labels";
import { appIdProblem, proofScopeProblem } from "../lib/validate";
import { AppIcon } from "../parts/AppIcon";
import { SecretReveal } from "../parts/SecretReveal";
import styles from "./proofs.module.css";

const TTLS = [60, 300, 900, 1800] as const;
type KindFilter = "all" | "ata" | "obo";
type StatusFilter = "all" | "active" | "expired" | "revoked";
type ProofItem = AppProof & { status?: string; token_expires_at?: string | null; access_ttl_seconds?: number; revoke_reason?: string | null };

/** Why a proof stopped working, for every `revoke_reason` the server reports (crates/proofs model.rs revoke_reason). */
const REVOKE_REASON: Record<string, string> = {
  revoked_by_app: "the app revoked it with its secret",
  revoked_by_owner: "the app's owner revoked it",
  revoked_by_account: "the account it speaks for revoked it",
  refresh_token_reuse: "one of its refresh tokens was presented again after it had been used",
  access_removed: "the account removed this app's access",
  account_deleted: "the account it speaks for was deleted",
  sign_in_revoked: "the sign-in it was issued under was revoked (the account signed out of this app, or its tokens were revoked)",
  sign_in_expired: "the sign-in it was issued under expired",
  membership_inactive: "the account's membership with this app is no longer active",
  account_inactive: "the account is no longer active",
};
const revokeReason = (reason: string) => REVOKE_REASON[reason] ?? "it was revoked";

/** A small chip for an app id: its icon and name once looked up. */
function AppChip(props: { appId: string; onRemove?: () => void }) {
  const lookup = () => lookupApp(props.appId);
  const name = () => {
    const value = lookup();
    return value.state === "found" ? value.app.name : props.appId;
  };
  return (
    <span ref={el => useSquircle(el)} class={styles.appChip} data-state={lookup().state}>
      <AppIcon name={name()} src={lookup().state === "found" ? (lookup() as { app: { logo_url: string | null } }).app.logo_url : null} size={24} />
      <span class={styles.appChipText}>
        <span class={styles.appChipName}>{name()}</span>
        <Show when={name() !== props.appId}><span class={styles.appChipId}>{props.appId}</span></Show>
      </span>
      <Show when={props.onRemove}>
        <button type="button" ref={el => useSquircle(el)} class={styles.appChipRemove} aria-label={`Remove ${props.appId}`} onClick={() => props.onRemove?.()}><X size={14} stroke-width={1.75} aria-hidden="true" /></button>
      </Show>
    </span>
  );
}

function ProofRow(props: { proof: ProofItem; appId: string; appName: string; logo: string | null; onRevoke: (id: string) => Promise<void> }) {
  const status = () => PROOF_STATUS[props.proof.status ?? (props.proof.revoked_at ? "revoked" : new Date(props.proof.expires_at).getTime() < Date.now() ? "expired" : "active")] ?? { label: props.proof.status ?? "Unknown", tone: "neutral" as const };
  const active = () => (props.proof.status ?? "active") === "active" && !props.proof.revoked_at;
  return (
    <li class={styles.proof}>
      <div class={styles.flow} aria-label={`${props.appName} to ${props.proof.audiences.join(", ")}`}>
        <Badge size="sm" tone={props.proof.kind === "ata" ? "info" : "neutral"}>{props.proof.kind === "ata" ? "ATA" : "OBO"}</Badge>
        <AppIcon name={props.appName} src={props.logo} size={32} />
        <span class={styles.connector} data-active={active() || undefined} aria-hidden="true"><i /><ArrowRight size={14} stroke-width={1.75} /></span>
        <span class={styles.receivers}>
          <For each={props.proof.audiences}>{audience => <AppChip appId={audience} />}</For>
        </span>
      </div>
      <div class={styles.proofMeta}>
        <Show when={props.proof.user}>
          {user => (
            <span class={styles.onBehalf}>
              <Avatar name={user().display_name} src={user().pfp_url} kind={user().kind} size="xs" />
              <span>for <code>{user().id ?? user().uuid}</code></span>
            </span>
          )}
        </Show>
        <span class={styles.scopes}>
          <Show when={props.proof.scopes.length} fallback={<span class={styles.muted}>No scopes</span>}>
            <For each={props.proof.scopes}>{scope => <code ref={el => useSquircle(el)} class={styles.scope}>{scope}</code>}</For>
          </Show>
        </span>
        <span class={styles.dates}>
          <span title={formatDateTime(props.proof.created_at)}>Issued {formatRelative(props.proof.created_at)}</span>
          <Show when={active() && props.proof.token_expires_at}>{at => <span title={formatDateTime(at())}>· token {formatExpiry(at())}</span>}</Show>
          <Show when={props.proof.revoked_at}>{at => <span title={formatDateTime(at())}>· revoked {formatRelative(at())}{props.proof.revoke_reason ? `: ${revokeReason(props.proof.revoke_reason)}` : ""}</span>}</Show>
        </span>
      </div>
      <div class={styles.proofEnd}>
        <Badge size="sm" tone={status().tone} dot={active()}>{status().label}</Badge>
        <Show when={active()}>
          <ConfirmMorph label="Revoke" prompt="Revoke this proof?" confirmLabel="Revoke" pendingLabel="Revoking" doneLabel="Revoked" onConfirm={() => props.onRevoke(props.proof.proof_id)} onError={error => notifyError(error, "The proof was not revoked")} />
        </Show>
      </div>
    </li>
  );
}

export default function ProofsTab() {
  const ctx = useDeveloperApp();
  const [audiences, setAudiences] = createSignal<string[]>([]);
  const [scopes, setScopes] = createSignal<string[]>([]);
  const [ttl, setTtl] = createSignal<string>("1800");
  const [issuing, setIssuing] = createSignal(false);
  const [issueError, setIssueError] = createSignal<ApiError | null>(null);
  const [issued, setIssued] = createSignal<IssuedProof | null>(null);
  const [suggestions, setSuggestions] = createSignal<string[]>([]);
  const [kind, setKind] = createSignal<KindFilter>("all");
  const [status, setStatus] = createSignal<StatusFilter>("all");
  // A retry of the same request reuses its key: a proof whose answer was lost is shown again, not issued twice.
  const issueKey = actionKey();

  onMount(() => {
    // Apps this Carbon owns or signed into are the likely audiences; their chips render without a lookup.
    void Promise.allSettled([collectPages(query => api.me.ownedApps(query), 2), collectPages(query => api.me.apps.list(query), 2)]).then(([owned, mine]) => {
      const ids = new Set<string>();
      if (owned.status === "fulfilled") for (const app of owned.value) { rememberApp(app); ids.add(app.app_id); }
      if (mine.status === "fulfilled") for (const entry of mine.value) { rememberApp(entry.app); ids.add(entry.app.app_id); }
      ids.delete(ctx.appId);
      ids.delete("accounts");
      setSuggestions([...ids].slice(0, 12));
    });
  });

  const list = createPagedList(query => api.apps.proofs.list(ctx.appId, { ...query, kind: kind() === "all" ? undefined : (kind() as "ata" | "obo"), status: status() === "all" ? undefined : (status() as "active" | "revoked") }), { limit: 50, immediate: false });
  createEffect(on([kind, status], () => void list.reset()));

  const audienceProblems = createMemo(() => audiences().flatMap(id => {
    const lookup = lookupApp(id);
    if (lookup.state === "missing") return [`${id}: ${lookup.message}`];
    if (lookup.state === "error") return [`${id}: ${lookup.message}`];
    return [];
  }));
  const resolving = () => audiences().some(id => lookupApp(id).state === "loading");

  const issue = async () => {
    setIssueError(null);
    if (!audiences().length) {
      setIssueError(new ApiError({ status: 0, code: "validation_failed", message: "Add at least one app that may verify the proof.", hint: "Type its app id, such as remind, and press Enter." }));
      return;
    }
    setIssuing(true);
    try {
      const body = { audiences: audiences(), scopes: scopes().length ? scopes() : undefined, access_ttl_seconds: Number(ttl()) };
      const proof = await api.apps.proofs.createAta(ctx.appId, body, { idempotencyKey: issueKey.for(JSON.stringify(body)) });
      issueKey.done();
      setIssued(proof);
      void list.reset();
    } catch (raw) {
      setIssueError(ApiError.from(raw));
    } finally {
      setIssuing(false);
    }
  };

  const revoke = async (proofId: string) => {
    await api.apps.proofs.revoke(ctx.appId, proofId);
    list.mutate(items => items.map(item => (item.proof_id === proofId ? { ...item, revoked_at: new Date().toISOString(), status: "revoked", revoke_reason: "revoked_by_owner" } as AppProof : item)));
  };

  // The tokens stay masked above; the commands read them from variables you set with the Copy buttons.
  const verifyCurl = (proof: IssuedProof) => {
    const audience = proof.receiving_apps?.[0] ?? proof.receiving_app ?? "remind";
    return `# Run by ${audience}, with its own app secret; PROOF_TOKEN is the proof token above\ncurl -u ${audience}:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -d "{\\"proof_token\\":\\"$PROOF_TOKEN\\"}" \\\n  ${ctx.publicUrl()}/v1/proofs/verify`;
  };
  const refreshCurl = () => `# Run by ${ctx.appId} when the token expires; the refresh token rotates every time\ncurl -u ${ctx.appId}:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -d "{\\"proof_refresh_token\\":\\"$PROOF_REFRESH_TOKEN\\"}" \\\n  ${ctx.publicUrl()}/v1/proofs/refresh`;
  const oboCurl = () => `# Your server, after the account agreed in your app\ncurl -u ${ctx.appId}:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: 4f1c…' \\\n  -d '{"subject_token":"<their access token for ${ctx.appId}>","receiving_app":"briefcase","scopes":["files.write"],"access_ttl_seconds":600}' \\\n  ${ctx.publicUrl()}/v1/proofs/obo`;

  return (
    <div class={styles.proofs}>
      <Section title="Issue an app-to-app proof" description={`A proof from ${ctx.app().name} that the apps you name can verify with Silicon Accounts. This stands in for the ATA page of Silicon Apps.`}>
        <Surface class={styles.creator}>
          <div class={styles.audiences}>
            <TagInput
              label="Apps that may verify it"
              mono
              placeholder="remind"
              value={audiences()}
              onValueChange={value => { setAudiences(value.map(item => item.toLowerCase())); setIssueError(null); }}
              normalize={value => value.trim().toLowerCase()}
              validate={tag => (tag === ctx.appId ? `${ctx.appId} is the app issuing the proof; name the apps that receive it.` : appIdProblem(tag))}
              maxTags={20}
              description="App ids, up to 20. Each must exist and be active."
            />
            <Show when={audiences().length}>
              <div class={styles.resolved}><For each={audiences()}>{id => <AppChip appId={id} onRemove={() => setAudiences(list => list.filter(item => item !== id))} />}</For></div>
            </Show>
            <Show when={suggestions().filter(id => !audiences().includes(id)).length}>
              <div class={styles.suggestions}>
                <span class={styles.muted}>Your apps:</span>
                <For each={suggestions().filter(id => !audiences().includes(id))}>
                  {id => <button type="button" ref={el => useSquircle(el)} class={styles.suggestion} onClick={() => setAudiences(list => [...list, id])}>+ {id}</button>}
                </For>
              </div>
            </Show>
          </div>
          <TagInput
            label="Scopes (optional)"
            mono
            placeholder="notify.send"
            value={scopes()}
            onValueChange={setScopes}
            normalize={value => value.trim()}
            validate={tag => proofScopeProblem(tag)}
            maxTags={20}
            description="Your own strings; the receiving apps decide what they allow. Up to 20, letters, digits and _ . : / -"
          />
          <div class={styles.ttl}>
            <span class={styles.ttlLabel} id="ata-ttl">Token lifetime</span>
            <SegmentedControl label="Token lifetime" value={ttl()} onValueChange={setTtl} options={TTLS.map(seconds => ({ value: String(seconds), label: ttlLabel(seconds) }))} />
            <span class={styles.muted}>The proof token expires after this. The refresh token gets new ones for up to 900 days.</span>
          </div>
          <Show when={audienceProblems().length}>
            <Alert tone="danger" title="Some apps can't receive the proof"><ul class={styles.problemList} role="list"><For each={audienceProblems()}>{problem => <li>{problem}</li>}</For></ul></Alert>
          </Show>
          <Show when={issueError()}>{error => <Alert tone="danger" title="The proof was not issued">{error().message} {error().hint}<Show when={Object.keys(error().fields).length}><ul class={styles.problemList} role="list"><For each={Object.entries(error().fields)}>{([path, message]) => <li><code>{path}</code> {message}</li>}</For></ul></Show></Alert>}</Show>
          <div class={styles.creatorActions}>
            <Button loading={issuing()} disabled={!audiences().length || audienceProblems().length > 0 || resolving()} onClick={() => void issue()}>Issue the proof</Button>
            <span class={styles.muted}>{audiences().length ? `For ${audiences().join(", ")}, valid ${ttlLabel(Number(ttl()))} at a time` : "Add at least one app"}</span>
          </div>
        </Surface>
        <Show when={issued()}>
          {proof => (
            <SecretReveal
              title="Your proof"
              description={`${ctx.app().name} → ${(proof().receiving_apps ?? [proof().receiving_app ?? ""]).join(", ")}${proof().scopes.length ? `, scopes ${proof().scopes.join(" ")}` : ""}. Keep the refresh token on your server.`}
              secrets={[
                { label: "Proof token", value: proof().proof_token, note: `Send it to the receiving app. Expires ${formatRelative(proof().expires_at)} (${formatDateTime(proof().expires_at)}).` },
                { label: "Proof refresh token", value: proof().proof_refresh_token, note: `Gets new proof tokens until ${formatDateTime(proof().refresh_expires_at)}. Presenting a used one revokes the proof.` },
              ]}
              doneLabel="I've stored them"
              onDone={() => setIssued(null)}
            >
              <CodeBlock filename="Verify it" language="bash" code={verifyCurl(proof())} wrap />
              <CodeBlock filename="Refresh it" language="bash" code={refreshCurl()} wrap />
            </SecretReveal>
          )}
        </Show>
      </Section>

      <Section title="Proofs this app issued" description="Active proofs verify until their token expires; revoking one stops it at once, refresh token included.">
        <div class={styles.filters}>
          <SegmentedControl label="Kind" size="sm" value={kind()} onValueChange={setKind} options={[{ value: "all", label: "All" }, { value: "ata", label: "App to app" }, { value: "obo", label: "On behalf of" }]} />
          <SegmentedControl label="Status" size="sm" value={status()} onValueChange={setStatus} options={[{ value: "all", label: "Any status" }, { value: "active", label: "Active" }, { value: "expired", label: "Expired" }, { value: "revoked", label: "Revoked" }]} />
        </div>
        <Show when={list.error()}>{error => <Alert tone="danger" title="Proofs could not be loaded" action={<Button size="sm" variant="secondary" onClick={() => void list.reset()}>Try again</Button>}>{error().message} {error().hint}</Alert>}</Show>
        <Switch>
          <Match when={list.loading() && !list.items().length}><Skeleton lines={4} avatar label="Loading proofs" /></Match>
          <Match when={!list.items().length && !list.error()}>
            <Surface padding="none">
              <EmptyState icon={<ShieldCheck size={24} stroke-width={1.5} />} title={kind() === "all" && status() === "all" ? "No proofs yet" : "No proofs match"} description={kind() === "all" && status() === "all" ? `Proofs ${ctx.app().name} issues, from here or from its server, appear here.` : "Try another kind or status."} />
            </Surface>
          </Match>
          <Match when={true}>
            <ul ref={el => useSquircle(el)} class={styles.proofList} role="list">
              <For each={list.items() as ProofItem[]}>{proof => <ProofRow proof={proof} appId={ctx.appId} appName={ctx.app().name} logo={ctx.app().logo_url} onRevoke={revoke} />}</For>
            </ul>
            <Show when={list.hasMore()}><Button size="sm" variant="secondary" loading={list.loadingMore()} onClick={() => void list.loadMore()}>Load more</Button></Show>
            <p class={styles.muted}>{plural(list.items().length, "proof")} shown.</p>
          </Match>
        </Switch>
      </Section>

      <Section title="On-behalf-of proofs" description={`When ${ctx.app().name} acts at another app for an account, it asks the account itself, then trades the account's access token for a proof. The receiving app verifies it; the account can see and revoke it on account.teamofsilicons.com.`}>
        <Accordion
          defaultOpen={-1}
          items={[{ id: "obo", title: "Issue an OBO proof from your server", content: <CodeBlock filename="POST /v1/proofs/obo" language="bash" code={oboCurl()} wrap /> }]}
        />
      </Section>
    </div>
  );
}
