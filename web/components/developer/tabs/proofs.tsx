"use client";

/**
 * Proofs: Silicon Accounts only issues and verifies proofs; what each one allows is up to the apps.
 *  - ATA (app to app): this page stands in for Silicon Apps' ATA page. Pick the apps that may verify the proof, its
 *    scopes and the token lifetime; the proof token and its refresh token are shown once.
 *  - OBO (on behalf of): issued by the app's server with an account's access token, after the app got their consent.
 * Every proof this app issued is listed, and any active one can be revoked.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ShieldCheck, X } from "lucide-react";
import { Accordion } from "@/components/arc/accordion/accordion";
import { Alert } from "@/components/arc/alert/alert";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { CodeBlock } from "@/components/arc/code-block/code-block";
import { ConfirmMorph } from "@/components/arc/confirm-morph/confirm-morph";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { Section, Surface } from "@/components/foundation/layout/layout";
import { api } from "@/lib/api/endpoints";
import { proofRevokeReason } from "@/lib/api/labels";
import type { AppProof, AtaRequest, IssuedProof } from "@/lib/api/types";
import { formatDateTime, formatExpiry, formatRelative, plural } from "@/lib/format";
import { useMyApps } from "@/lib/query/account";
import { useOwnedApps, useRevokeAppProof } from "@/lib/query/developer";
import { useIdempotentMutation } from "@/lib/query/idempotency";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { useAppLookups, type AppLookup, type KnownApp } from "../lib/apps";
import { useDeveloperApp } from "../lib/context";
import { PROOF_STATUS, ttlLabel } from "../lib/labels";
import { useProofList } from "../lib/queries";
import { appIdProblem, proofScopeProblem } from "../lib/validate";
import { AppIcon } from "../parts/app-icon";
import { SecretReveal } from "../parts/secret-reveal";
import { TagField } from "../parts/tag-field";
import styles from "./proofs.module.css";

const TTLS = [60, 300, 900, 1800] as const;
type KindFilter = "all" | "ata" | "obo";
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

function ProofRow({ proof, appName, logo, lookups, onRevoke }: { proof: AppProof; appName: string; logo: string | null; lookups: Record<string, AppLookup>; onRevoke: (id: string) => Promise<void> }) {
  const status = PROOF_STATUS[proof.status] ?? { label: proof.status, tone: "neutral" as const };
  const active = proof.status === "active";
  const ended = proof.revoked_at ?? (proof.status === "expired" ? proof.expires_at : null);
  return (
    <li className={styles.proof}>
      <div className={styles.flow} aria-label={`${appName} to ${proof.audiences.join(", ")}`}>
        <Badge size="sm" tone={proof.kind === "ata" ? "info" : "neutral"}>{proof.kind === "ata" ? "ATA" : "OBO"}</Badge>
        <AppIcon name={appName} src={logo} size={32} decorative />
        <span className={styles.connector} data-active={active || undefined} aria-hidden="true"><i /><ArrowRight size={14} strokeWidth={1.75} /></span>
        <span className={styles.receivers}>
          {proof.audiences.map(audience => <AppChip key={audience} appId={audience} lookup={lookups[audience]} />)}
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
        {active ? <ConfirmMorph label="Revoke" prompt="Revoke this proof?" confirmLabel="Revoke" pendingLabel="Revoking" doneLabel="Revoked" onConfirm={() => onRevoke(proof.proof_id)} /> : null}
      </div>
    </li>
  );
}

export function ProofsTab() {
  const ctx = useDeveloperApp();
  const { appId } = ctx;
  const client = useQueryClient();
  const [audiences, setAudiences] = useState<string[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [ttl, setTtl] = useState("1800");
  const [issued, setIssued] = useState<IssuedProof | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const owned = useOwnedApps();
  const mine = useMyApps();

  // Apps this Carbon owns or signed into are the likely audiences; their chips render without a lookup.
  const known = useMemo<KnownApp[]>(() => {
    const byId = new Map<string, KnownApp>();
    for (const app of owned.data?.items ?? []) byId.set(app.app_id, { app_id: app.app_id, name: app.name, logo_url: app.logo_url });
    for (const entry of mine.data?.items ?? []) if (!byId.has(entry.app.app_id)) byId.set(entry.app.app_id, { app_id: entry.app.app_id, name: entry.app.name, logo_url: entry.app.logo_url });
    return [...byId.values()];
  }, [owned.data, mine.data]);
  const suggestions = known.map(app => app.app_id).filter(id => id !== appId && id !== "accounts" && !audiences.includes(id)).slice(0, 12);

  const list = useProofList(appId, { kind: kind === "all" ? undefined : kind, status: status === "all" ? undefined : status });
  const proofs = useMemo(() => list.data?.pages.flatMap(page => page.items) ?? [], [list.data]);
  const listedAudiences = [...new Set(proofs.flatMap(proof => proof.audiences))];
  const lookups = useAppLookups([...new Set([...audiences, ...listedAudiences])], known);

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

  const issue = useIdempotentMutation((body: AtaRequest, idempotencyKey) => api.apps.proofs.createAta(appId, body, { idempotencyKey }), {
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.app.root(appId).concat("proofs") }),
    meta: { toast: false },
  });
  const revoke = useRevokeAppProof(appId);

  const audienceProblems = audiences.flatMap(id => {
    const lookup = lookups[id];
    return lookup?.state === "missing" || lookup?.state === "error" ? [`${id}: ${lookup.message}`] : [];
  });
  const resolving = audiences.some(id => lookups[id]?.state === "loading");

  const submit = async () => {
    try {
      const proof = await issue.mutateAsync({ audiences, scopes: scopes.length ? scopes : undefined, access_ttl_seconds: Number(ttl) });
      setIssued(proof);
    } catch {
      // Shown inline from issue.error.
    }
  };

  // The tokens stay masked above; the commands read them from variables set with the Copy buttons.
  const verifyCurl = (proof: IssuedProof) => {
    const audience = proof.receiving_apps?.[0] ?? proof.receiving_app ?? "remind";
    return `# Run by ${audience}, with its own app secret; PROOF_TOKEN is the proof token above\ncurl -u ${audience}:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -d "{\\"proof_token\\":\\"$PROOF_TOKEN\\"}" \\\n  ${ctx.publicUrl}/v1/proofs/verify`;
  };
  const refreshCurl = `# Run by ${appId} when the token expires; the refresh token rotates every time\ncurl -u ${appId}:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -d "{\\"proof_refresh_token\\":\\"$PROOF_REFRESH_TOKEN\\"}" \\\n  ${ctx.publicUrl}/v1/proofs/refresh`;
  const oboCurl = `# Your server, after the account agreed in your app\ncurl -u ${appId}:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: 4f1c…' \\\n  -d '{"subject_token":"<their access token for ${appId}>","receiving_app":"briefcase","scopes":["files.write"],"access_ttl_seconds":600}' \\\n  ${ctx.publicUrl}/v1/proofs/obo\n\n# → { "proof_id": "…", "proof_token": "sap_…", "proof_refresh_token": "sapr_…", "expires_at": "…", … }\n# The receiving app verifies it with POST /v1/proofs/verify and its own credentials.`;
  const issueError = issue.error;
  const filtered = kind !== "all" || status !== "all";

  return (
    <div className={styles.proofs}>
      <Section title="Issue an app-to-app proof" description={`A proof from ${ctx.app.name} that the apps you name can verify with Silicon Accounts. This stands in for the ATA page of Silicon Apps.`}>
        <Surface className={styles.creator}>
          <div className={styles.audiences}>
            <TagField
              label="Apps that may verify it"
              mono
              placeholder="An app id, like remind"
              value={audiences}
              onValueChange={value => { setAudiences(value); issue.reset(); }}
              normalize={value => value.trim().toLowerCase()}
              commaAdds
              validate={tag => (tag === appId ? `${appId} is the app issuing the proof; name the apps that receive it.` : appIdProblem(tag))}
              max={20}
              description="App ids, up to 20. Each must exist and be active."
            />
            {audiences.length ? (
              <div className={styles.resolved}>
                {audiences.map(id => <AppChip key={id} appId={id} lookup={lookups[id]} onRemove={() => setAudiences(current => current.filter(item => item !== id))} />)}
              </div>
            ) : null}
            {suggestions.length ? (
              <div className={styles.suggestions}>
                <span className={styles.muted}>Your apps:</span>
                {suggestions.map(id => <button key={id} type="button" data-sq="surface" className={styles.suggestion} onClick={() => setAudiences(current => (current.includes(id) || current.length >= 20 ? current : [...current, id]))}>+ {id}</button>)}
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
          {audienceProblems.length ? (
            <Alert tone="danger" title="Some apps can't receive the proof">
              <span className={styles.problemLines}>{audienceProblems.map(problem => <span key={problem}>{problem}</span>)}</span>
            </Alert>
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
            <Button loading={issue.isPending} disabled={!audiences.length || audienceProblems.length > 0 || resolving} onClick={() => void submit()}>Issue the proof</Button>
            <span className={styles.muted}>{audiences.length ? `For ${audiences.join(", ")}, valid ${ttlLabel(Number(ttl))} at a time` : "Add at least one app"}</span>
          </div>
        </Surface>
        {issued ? (
          <SecretReveal
            title="Your proof"
            description={`${ctx.app.name} → ${(issued.receiving_apps ?? [issued.receiving_app ?? ""]).join(", ")}${issued.scopes.length ? `, scopes ${issued.scopes.join(" ")}` : ""}. Keep the refresh token on your server.`}
            secrets={[
              { label: "Proof token", value: issued.proof_token, note: `Send it to the receiving app. Expires ${formatRelative(issued.expires_at)} (${formatDateTime(issued.expires_at)}).` },
              { label: "Proof refresh token", value: issued.proof_refresh_token, note: `Gets new proof tokens until ${formatDateTime(issued.refresh_expires_at)}. Presenting a used one revokes the proof.` },
            ]}
            doneLabel="I've stored them"
            onDone={() => setIssued(null)}
          >
            <div className={styles.wrapCode}><CodeBlock filename="Verify it" language="bash" code={verifyCurl(issued)} /></div>
            <div className={styles.wrapCode}><CodeBlock filename="Refresh it" language="bash" code={refreshCurl} /></div>
          </SecretReveal>
        ) : null}
      </Section>

      <Section id="proofs-issued" title="Proofs this app issued" description="Active proofs verify until their token expires; revoking one stops it at once, refresh token included.">
        <div className={styles.filters}>
          <SegmentedControl label="Kind" value={kind} onValueChange={value => setKind(value as KindFilter)} options={[{ value: "all", label: "All" }, { value: "ata", label: "App to app" }, { value: "obo", label: "On behalf of" }]} />
          <SegmentedControl label="Status" value={status} onValueChange={value => setStatus(value as StatusFilter)} options={[{ value: "all", label: "Any status" }, { value: "active", label: "Active" }, { value: "expired", label: "Expired" }, { value: "revoked", label: "Revoked" }]} />
        </div>
        {list.error ? (
          <Alert tone="danger" title="Proofs could not be loaded">
            {list.error.message} {list.error.hint}
            <span className={styles.problemLines}><Button size="sm" variant="secondary" onClick={() => void list.refetch()}>Try again</Button></span>
          </Alert>
        ) : null}
        {list.isPending ? <Skeleton lines={4} avatar label="Loading proofs" /> : !proofs.length && !list.error ? (
          <Surface padding="none">
            <EmptyState
              icon={<ShieldCheck size={24} strokeWidth={1.5} />}
              title={filtered ? "No proofs match" : "No proofs yet"}
              description={filtered ? "Try another kind or status." : `Proofs ${ctx.app.name} issues, from here or from its server, appear here.`}
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
            {list.hasNextPage ? <Button size="sm" variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more proofs</Button> : null}
            <p className={styles.footnote}>{plural(proofs.length, "proof")} shown.</p>
          </>
        ) : null}
      </Section>

      <Section title="On-behalf-of proofs" description={`When ${ctx.app.name} acts at another app for an account, it asks the account itself, then trades the account's access token for a proof. The receiving app verifies it; the account can see and revoke it on account.teamofsilicons.com. The list above shows them under On behalf of.`}>
        <Accordion defaultOpen={-1} items={[{ title: "Issue an OBO proof from your server", content: <div className={styles.wrapCode}><CodeBlock filename="POST /v1/proofs/obo" language="bash" code={oboCurl} /></div> }]} />
      </Section>
    </div>
  );
}
