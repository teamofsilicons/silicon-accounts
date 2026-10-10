"use client";

/**
 * App verification: the app's app-to-app proofs (UNDERSTANDING "Proofs"). Silicon Accounts only issues and verifies proofs; what each
 * one allows is up to the apps. An App verification proof is always for exactly one app: pick the one receiving app, its scopes and
 * the token lifetime; the proof token and its refresh token are shown once. To talk to two apps, make one proof for
 * each. Every proof this app issued is listed (App verification by default; User verification proofs, issued by the app's server for an account,
 * are one filter away), and any active one can be revoked.
 */
import Link from "next/link";
import { paths } from "@/lib/navigation";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ShieldCheck, X } from "lucide-react";
import { Input } from "@/components/silicon-ui/input/input";
import { Accordion } from "@/components/silicon-ui/accordion/accordion";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import { CodeBlock } from "@/components/silicon-ui/code-block/code-block";
import { ConfirmMorph } from "@/components/silicon-ui/confirm-morph/confirm-morph";
import { EmptyState } from "@/components/silicon-ui/empty-state/empty-state";
import SegmentedControl from "@/components/silicon-ui/segmented-control/segmented-control";
import { Skeleton } from "@/components/silicon-ui/skeleton/skeleton";
import { Section, Surface } from "@/components/foundation/layout/layout";
import { ApiError } from "@/lib/api/errors";
import { proofRevokeReason } from "@/lib/api/labels";
import type { AppProof, IssuedProof } from "@/lib/api/types";
import { formatDateTime, formatExpiry, formatRelative, plural } from "@/lib/format";
import { useCreateAppVerification, useOwnedApps, useRevokeAppProof } from "@/lib/query/developer";
import { useAppLookups, type AppLookup, type KnownApp } from "../lib/apps";
import { useDeveloperApp } from "../lib/context";
import { PROOF_STATUS, ttlLabel } from "../lib/labels";
import { useProofList } from "../lib/queries";
import { appIdProblem, proofScopeProblem } from "../lib/validate";
import { AppIcon } from "../parts/app-icon";
import { SecretReveal } from "../parts/secret-reveal";
import { TagField } from "../parts/tag-field";
import styles from "./app_verification.module.css";

const TTLS = [60, 300, 900, 1800] as const;
type KindFilter = "all" | "app_verification" | "user_verification";
type StatusFilter = "all" | "active" | "expired" | "revoked";

/** A small chip for an app id: its icon and name once looked up. */
function AppChip({ appId, lookup, onRemove }: { appId: string; lookup: AppLookup | undefined; onRemove?: () => void }) {
  const found = lookup?.state === "found" ? lookup.app : null;
  const name = found?.name ?? appId;
  return (
    <span data-sq="surface" className={styles.appChip} data-state={lookup?.state ?? "loading"} title={lookup?.state === "missing" || lookup?.state === "error" ? lookup.message : undefined}>
      <AppIcon name={name} src={found?.logo_url ?? null} size={24} decorative />
      <span className={styles.appChipText}>
        <span className={styles.appChipName}>{name}</span>
        {name !== appId ? <span className={styles.appChipId}>{appId}</span> : null}
      </span>
      {onRemove ? (
        <button type="button" data-sq="surface" className={styles.appChipRemove} aria-label={`Remove ${appId}`} onClick={onRemove}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
      ) : null}
    </span>
  );
}

/** The one app a proof is for (`receiving_app`; older listings only have the stored audiences). */
const receiverOf = (proof: AppProof): string[] => (proof.receiving_app ? [proof.receiving_app] : proof.audiences ?? []);

function ProofRow({ proof, appName, logo, lookups, onRevoke }: { proof: AppProof; appName: string; logo: string | null; lookups: Record<string, AppLookup>; onRevoke: (id: string) => Promise<void> }) {
  const status = PROOF_STATUS[proof.status] ?? { label: proof.status, tone: "neutral" as const };
  const active = proof.status === "active";
  const ended = proof.revoked_at ?? (proof.status === "expired" ? proof.expires_at : null);
  const receivers = receiverOf(proof);
  return (
    <li className={styles.proof}>
      <div className={styles.flow} aria-label={`${appName} to ${receivers.join(", ")}`}>
        <Badge size="sm" tone={proof.kind === "app_verification" ? "info" : "neutral"}>{proof.kind === "app_verification" ? "App verification" : "User verification"}</Badge>
        <AppIcon name={appName} src={logo} size={32} decorative />
        <span className={styles.connector} data-active={active || undefined} aria-hidden="true"><i /><ArrowRight size={14} strokeWidth={1.75} /></span>
        <span className={styles.receivers}>
          {receivers.map(audience => <AppChip key={audience} appId={audience} lookup={lookups[audience]} />)}
        </span>
      </div>
      <div className={styles.proofMeta}>
        {proof.user ? (
          <span className={styles.onBehalf}>
            <Avatar name={proof.user.display_name} src={proof.user.pfp_url} size="sm" aria-hidden="true" />
            <span>for <code>{proof.user.id ?? proof.user.uuid}</code></span>
          </span>
        ) : null}
        <span className={styles.scopes}>
          {proof.scopes.length ? proof.scopes.map(scope => <code key={scope} data-sq="surface" className={styles.scope}>{scope}</code>) : <span className={styles.muted}>No scopes</span>}
        </span>
        <span className={styles.dates}>
          <span title={formatDateTime(proof.created_at)}>Issued {formatRelative(proof.created_at)}</span>
          {active && proof.token_expires_at ? <span title={formatDateTime(proof.token_expires_at)}>· token {formatExpiry(proof.token_expires_at) === "expired" ? "expired, waiting for a refresh" : `expires ${formatExpiry(proof.token_expires_at)}`}</span> : null}
          {!active && ended ? <span title={formatDateTime(ended)}>· {proof.status === "revoked" ? "revoked" : "ended"} {formatRelative(ended)}{proof.revoke_reason ? `: ${proofRevokeReason(proof.revoke_reason)}` : ""}</span> : null}
        </span>
      </div>
      <div className={styles.proofEnd}>
        {/* Where focus lands once a revoke here takes the Revoke control away (it says the new status). */}
        <span className={styles.statusFocus} tabIndex={-1} data-proof-status={proof.proof_id}>
          <Badge size="sm" tone={status.tone}>{status.label}</Badge>
        </span>
        {active ? <ConfirmMorph label="Revoke" prompt="Revoke this verification?" confirmLabel="Revoke" pendingLabel="Revoking" doneLabel="Revoked" onConfirm={() => onRevoke(proof.proof_id)} /> : null}
      </div>
    </li>
  );
}

export function AppVerificationTab() {
  const ctx = useDeveloperApp();
  const { appId } = ctx;
  /** The one app the next proof is for (normalized app id), and what is typed into the field. */
  const [receiver, setReceiver] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [typedProblem, setTypedProblem] = useState<string | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [ttl, setTtl] = useState("1800");
  const [issued, setIssued] = useState<IssuedProof | null>(null);
  const [kind, setKind] = useState<KindFilter>("app_verification");
  const [status, setStatus] = useState<StatusFilter>("all");
  const owned = useOwnedApps();

  // Apps this Carbon owns are the likely receivers; their chips render without a lookup.
  const known = useMemo<KnownApp[]>(() => (owned.data?.items ?? []).map(app => ({ app_id: app.app_id, name: app.name, logo_url: app.logo_url })), [owned.data]);
  const suggestions = known.map(app => app.app_id).filter(id => id !== appId && id !== "silicon-accounts" && id !== "developer" && id !== receiver).slice(0, 12);

  const list = useProofList(appId, { kind: kind === "all" ? undefined : kind, status: status === "all" ? undefined : status });
  const proofs = useMemo(() => list.data?.pages.flatMap(page => page.items) ?? [], [list.data]);
  const listedAudiences = [...new Set(proofs.flatMap(receiverOf))];
  const lookups = useAppLookups([...new Set([...(receiver ? [receiver] : []), ...listedAudiences])], known);

  // A revoke takes its row's Revoke control away once the list says "Revoked"; focus then goes to that status (or to
  // the list's heading when the row leaves the current filter) instead of falling to the start of the page.
  const revoked = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = revoked.current;
    if (!id) return;
    const proof = proofs.find(item => item.proof_id === id);
    if (proof?.status === "active") return;
    revoked.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const status = proof ? document.querySelector<HTMLElement>(`[data-proof-status="${CSS.escape(id)}"]`) : null;
    const heading = document.querySelector<HTMLElement>("#proofs-issued h2");
    if (heading && !heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    (status ?? heading)?.focus({ preventScroll: true });
  }, [proofs]);

  // A secret mutation (lib/query useSecretMutation): the proof and refresh tokens are kept only by the reveal below,
  // never in TanStack's cache. A refusal is shown in place (its own state, since the mutation forgets it).
  const issue = useCreateAppVerification(appId, { toast: false });
  const [issueError, setIssueError] = useState<ApiError | null>(null);
  const revoke = useRevokeAppProof(appId);

  const lookup = receiver ? lookups[receiver] : undefined;
  const receiverProblem = lookup?.state === "missing" || lookup?.state === "error" ? `${receiver}: ${lookup.message}` : null;
  const resolving = lookup?.state === "loading";

  /** Picks the one receiving app (typed or suggested); a second pick replaces the first: one app per proof. */
  const choose = (raw: string) => {
    const id = raw.trim().toLowerCase();
    const problem = id === appId ? `${appId} is the app issuing the proof; pick the app that receives it.` : appIdProblem(id);
    setTypedProblem(problem);
    if (problem) return;
    setReceiver(id);
    setTyped("");
    setIssueError(null);
  };

  const submit = async () => {
    if (!receiver) return;
    setIssueError(null);
    try {
      const proof = await issue.run({ receiving_app: receiver, scopes: scopes.length ? scopes : undefined, access_ttl_seconds: Number(ttl) });
      setIssued(proof);
    } catch (raw) {
      setIssueError(ApiError.from(raw));
    }
  };

  // The tokens stay masked above; the commands read them from variables set with the Copy buttons.
  const verifyCurl = (proof: IssuedProof) => {
    const audience = proof.receiving_app ?? proof.receiving_apps?.[0] ?? "remind";
    return `# Run by ${audience}, with its own app secret; PROOF_TOKEN is the proof token above\ncurl -u ${audience}:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -d "{\\"proof_token\\":\\"$PROOF_TOKEN\\"}" \\\n  ${ctx.publicUrl}/v1/proofs/verify`;
  };
  const refreshCurl = `# Run by ${appId} when the token expires; the refresh token rotates every time\ncurl -u ${appId}:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -d "{\\"proof_refresh_token\\":\\"$PROOF_REFRESH_TOKEN\\"}" \\\n  ${ctx.publicUrl}/v1/proofs/refresh`;
  const oboCurl = `# Your server, after the account agreed in your app\ncurl -u ${appId}:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: 4f1c…' \\\n  -d '{"subject_token":"<their access token for ${appId}>","receiving_app":"briefcase","scopes":["files.write"],"access_ttl_seconds":600}' \\\n  ${ctx.publicUrl}/v1/proofs/user-verification\n\n# → { "proof_id": "…", "proof_token": "sap_…", "proof_refresh_token": "sapr_…", "expires_at": "…", … }\n# The receiving app verifies it with POST /v1/proofs/verify and its own credentials.`;
  const filtered = kind !== "all" || status !== "all";
  const ataCurl = `# Your server: one proof per receiving app (an app verification is for exactly one app)\ncurl -u ${appId}:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: 9b2e…' \\\n  -d '{"receiving_app":"${receiver ?? "remind"}","scopes":["notify.send"],"access_ttl_seconds":1800}' \\\n  ${ctx.publicUrl}/v1/proofs/app-verification`;

  return (
    <div className={styles.proofs}>
      <Section title="Create an app verification token" description={`A proof from ${ctx.app.name} that exactly one app can verify with Silicon Accounts. To talk to several apps, make one proof for each: each app verifies its own.`}>
        <Surface className={styles.creator}>
          <div className={styles.audiences}>
            {receiver ? (
              <div className={styles.receiver}>
                <span className={styles.fieldLabel}>The app that receives it</span>
                <div className={styles.resolved}>
                  <AppChip appId={receiver} lookup={lookups[receiver]} onRemove={() => { setReceiver(null); setIssueError(null); }} />
                </div>
              </div>
            ) : (
              <form className={styles.pick} onSubmit={event => { event.preventDefault(); choose(typed); }}>
                <Input
                  label="The app that receives it"
                  className={styles.mono}
                  placeholder="An app id, like remind"
                  value={typed}
                  onChange={event => { setTyped(event.currentTarget.value); setTypedProblem(null); }}
                  error={typedProblem ?? undefined}
                  description="One app id. It must exist and be active."
                  spellCheck={false}
                  autoComplete="off"
                />
                <Button type="submit" variant="secondary" disabled={!typed.trim()}>Choose</Button>
              </form>
            )}
            {suggestions.length ? (
              <div className={styles.suggestions}>
                <span className={styles.muted}>{receiver ? "Or another of your apps:" : "Your apps:"}</span>
                {suggestions.map(id => <button key={id} type="button" data-sq="surface" className={styles.suggestion} onClick={() => choose(id)}>{id}</button>)}
              </div>
            ) : null}
          </div>
          <TagField
            label="Scopes (optional)"
            mono
            placeholder="A scope, like notify.send"
            value={scopes}
            onValueChange={setScopes}
            validate={tag => proofScopeProblem(tag)}
            max={20}
            description="Your own strings; the receiving apps decide what they allow. Up to 20, letters, digits and _ . : / -"
          />
          <div className={styles.ttl}>
            <span className={styles.ttlLabel}>Token lifetime</span>
            <SegmentedControl label="Token lifetime" value={ttl} onValueChange={setTtl} options={TTLS.map(seconds => ({ value: String(seconds), label: ttlLabel(seconds) }))} />
            <span className={styles.muted}>The proof token expires after this. The refresh token gets new ones for up to 900 days.</span>
          </div>
          {receiverProblem ? (
            <Alert tone="danger" title="This app can't receive the proof">{receiverProblem}</Alert>
          ) : null}
          {issueError ? (
            <Alert tone="danger" title="The proof was not issued">
              {issueError.message} {issueError.hint}
              {Object.keys(issueError.fields).length ? (
                <span className={styles.problemLines}>{Object.entries(issueError.fields).map(([path, message]) => <span key={path}><code>{path}</code> {message}</span>)}</span>
              ) : null}
            </Alert>
          ) : null}
          <div className={styles.creatorActions}>
            <Button loading={issue.isPending} disabled={!receiver || !!receiverProblem || resolving} onClick={() => void submit()}>Create token</Button>
            <span className={styles.muted}>{receiver ? `For ${receiver} only, valid ${ttlLabel(Number(ttl))} at a time` : "Choose the one app that receives it"}</span>
          </div>
        </Surface>
        {issued ? (
          <SecretReveal
            title="Your verification tokens"
            description={`${ctx.app.name} → ${issued.receiving_app ?? issued.receiving_apps?.[0] ?? ""}${issued.scopes.length ? `, scopes ${issued.scopes.join(" ")}` : ""}. Keep the refresh token on your server.`}
            secrets={[
              { label: "Verification token", value: issued.proof_token, note: `Send it to the receiving app. Expires ${formatRelative(issued.expires_at)} (${formatDateTime(issued.expires_at)}).` },
              { label: "Verification refresh token", value: issued.proof_refresh_token, note: `Gets new proof tokens until ${formatDateTime(issued.refresh_expires_at)}. Presenting a used one revokes the proof.` },
            ]}
            doneLabel="I've stored them"
            onDone={() => setIssued(null)}
          >
            <div className={styles.wrapCode}><CodeBlock filename="Verify it" language="bash" code={verifyCurl(issued)} /></div>
            <div className={styles.wrapCode}><CodeBlock filename="Refresh it" language="bash" code={refreshCurl} /></div>
          </SecretReveal>
        ) : null}
      </Section>

      <Section id="proofs-issued" title="Verifications this app issued" description="Active verifications can be refreshed until their refresh period ends. Revoking one stops it at once, refresh token included." actions={<Link href={paths.appVerification(appId)}>All app verification history <ArrowRight size={14} aria-hidden="true" /></Link>}>
        <div className={styles.filters}>
          <SegmentedControl label="Kind" value={kind} onValueChange={value => setKind(value as KindFilter)} options={[{ value: "app_verification", label: "App verification" }, { value: "user_verification", label: "User verification" }, { value: "all", label: "All" }]} />
          <SegmentedControl label="Status" value={status} onValueChange={value => setStatus(value as StatusFilter)} options={[{ value: "all", label: "Any status" }, { value: "active", label: "Active" }, { value: "expired", label: "Expired" }, { value: "revoked", label: "Revoked" }]} />
        </div>
        {list.error ? (
          <Alert tone="danger" title="Verifications could not be loaded">
            {list.error.message} {list.error.hint}
            <span className={styles.problemLines}><Button size="sm" variant="secondary" onClick={() => void list.refetch()}>Try again</Button></span>
          </Alert>
        ) : null}
        {list.isPending ? <Skeleton lines={4} avatar label="Loading verifications" /> : !proofs.length && !list.error ? (
          <Surface padding="none">
            <EmptyState
              icon={<ShieldCheck size={24} strokeWidth={1.5} />}
              title={filtered ? "No verifications match" : "No verifications yet"}
              description={filtered ? (kind === "app_verification" && status === "all" ? `App verifications ${ctx.app.name} creates, here or from its server, appear here.` : "Try another kind or status.") : `Verifications ${ctx.app.name} issues, from here or from its server, appear here.`}
            />
          </Surface>
        ) : proofs.length ? (
          <>
            <ul data-sq="surface" className={styles.proofList} role="list" aria-busy={list.isPlaceholderData || undefined}>
              {proofs.map(proof => (
                <ProofRow
                  key={proof.proof_id}
                  proof={proof}
                  appName={ctx.app.name}
                  logo={ctx.app.logo_url}
                  lookups={lookups}
                  onRevoke={async id => {
                    await revoke.mutateAsync(id);
                    revoked.current = id;
                  }}
                />
              ))}
            </ul>
            {list.hasNextPage ? <Button size="sm" variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more verifications</Button> : null}
            <p className={styles.footnote}>{plural(proofs.length, "verification")} shown.</p>
          </>
        ) : null}
      </Section>

      <Section title="From your server" description={`${ctx.app.name}'s server can make the same proofs with its app id and secret. User verification tokens (when ${ctx.app.name} acts at another app for an account, after asking the account itself) come only from the server; the account sees and can revoke them on accounts.teamofsilicons.com.`}>
        <Accordion defaultOpen={-1} items={[
          { title: "Create an app verification token from your server", content: <div className={styles.wrapCode}><CodeBlock filename="POST /v1/proofs/app-verification" language="bash" code={ataCurl} /></div> },
          { title: "Issue a user verification token from your server", content: <div className={styles.wrapCode}><CodeBlock filename="POST /v1/proofs/user-verification" language="bash" code={oboCurl} /></div> },
        ]} />
      </Section>
    </div>
  );
}
