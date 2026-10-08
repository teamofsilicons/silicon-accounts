/**
 * Listings and identity: the account's /v1/me/proofs and the issuing app's /v1/apps/{app_id}/proofs page with a stable
 * cursor, newest first, filter by status and kind, and refuse bad parameters precisely; a verification names the
 * account's current id after an id change (the uuid and membership stay); a user verification proof needs no membership with the
 * receiving app.
 */
import type { Journey } from "../../context";
import { appTokens, asApp, errorCode, issueUserVerification, refreshAs, short, signInToApp, verifyAs, type AppProofItem, type IssuedProof, type MyProofItem } from "./_helpers";

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export const journey: Journey = {
  name: "proofs-perf-listings",
  title: "/v1/me/proofs and /v1/apps/dm/proofs: newest first, a stable cursor across pages, status and kind filters, clamped limits, precise refusals of bad parameters; verify names the account's current id after an id change; no membership with the receiving app is needed",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await signInToApp(ctx, "dm");
    const subject = (await appTokens(env, "dm", carbon.uuid)).access_token;
    const proofs: IssuedProof[] = [];
    for (let i = 1; i <= 5; i++) proofs.push((await issueUserVerification(ctx, "dm", subject, { receiving_app: "briefcase", scopes: [`pp.list.${i}`] })).body);
    const [p1, p2, p3, p4, p5] = proofs as [IssuedProof, IssuedProof, IssuedProof, IssuedProof, IssuedProof];
    await asApp(ctx, "dm", "POST", "/v1/proofs/revoke", { proof_id: p2.proof_id });
    await carbon.session.call("DELETE", `/v1/me/proofs/${p4.proof_id}`);

    // The account's listing, two at a time.
    const seen: string[] = [];
    let cursor: string | null = null;
    const pages: number[] = [];
    for (let page = 0; page < 6; page++) {
      const answer: { status: number; body: Page<MyProofItem> } = await carbon.session.call<Page<MyProofItem>>("GET", `/v1/me/proofs?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      pages.push(answer.body.items?.length ?? -1);
      seen.push(...(answer.body.items ?? []).map(item => item.proof_id));
      cursor = answer.body.next_cursor;
      if (!cursor) break;
    }
    const newestFirst = [p5, p4, p3, p2, p1].map(p => p.proof_id);
    results.check("/v1/me/proofs?limit=2 pages 2 + 2 + 1, newest first, every proof exactly once, then next_cursor null", JSON.stringify(seen) === JSON.stringify(newestFirst) && JSON.stringify(pages) === "[2,2,1]", `pages ${JSON.stringify(pages)}`);
    const active = (await carbon.session.call<Page<MyProofItem>>("GET", "/v1/me/proofs?status=active")).body.items ?? [];
    const revoked = (await carbon.session.call<Page<MyProofItem>>("GET", "/v1/me/proofs?status=revoked")).body.items ?? [];
    results.check("?status=active → the three live ones; ?status=revoked → the one dm revoked and the one the Carbon revoked", JSON.stringify(active.map(item => item.proof_id)) === JSON.stringify([p5, p3, p1].map(p => p.proof_id)) && JSON.stringify(revoked.map(item => `${item.proof_id}:${item.revoke_reason}`)) === JSON.stringify([`${p4.proof_id}:revoked_by_account`, `${p2.proof_id}:revoked_by_app`]), `${active.length} active, ${revoked.map(item => item.revoke_reason).join(", ")}`);
    const expired = (await carbon.session.call<Page<MyProofItem>>("GET", "/v1/me/proofs?status=expired")).body.items ?? [];
    results.check("?status=expired → none yet", expired.length === 0, String(expired.length));
    const clampedLow = await carbon.session.call<Page<MyProofItem>>("GET", "/v1/me/proofs?limit=0");
    const clampedHigh = await carbon.session.call<Page<MyProofItem>>("GET", "/v1/me/proofs?limit=5000");
    results.check("limit is clamped to 1..200 (limit=0 → one item and a cursor; limit=5000 → all five)", clampedLow.status === 200 && clampedLow.body.items?.length === 1 && !!clampedLow.body.next_cursor && clampedHigh.status === 200 && clampedHigh.body.items?.length === 5, `${clampedLow.status} ${clampedLow.body.items?.length} / ${clampedHigh.status} ${clampedHigh.body.items?.length}`);
    for (const [query, what] of [["status=bogus", "an unknown status"], ["cursor=not-a-cursor", "a forged cursor"], ["kind=user_verification", "a filter this listing doesn't have"], ["foo=1", "an unknown parameter"]] as const) {
      const answer = await carbon.session.call<Page<MyProofItem>>("GET", `/v1/me/proofs?${query}`);
      results.check(`/v1/me/proofs?${query} (${what}) → 400/422 with an error code, not a silent list`, (answer.status === 400 || answer.status === 422) && !!errorCode(answer.body), `${answer.status} ${short(answer.body)}`);
    }

    // The issuing app's listing (it holds every proof dm issued on this stack): filters and a cursor that never repeats.
    const mine = new Set(proofs.map(p => p.proof_id));
    const collect = async (query: string) => {
      const out: AppProofItem[] = [];
      let next: string | null = null;
      for (let page = 0; page < 200; page++) {
        const answer: { status: number; body: Page<AppProofItem> } = await asApp<Page<AppProofItem>>(ctx, "dm", "GET", `/v1/apps/dm/proofs?limit=9${query}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
        out.push(...(answer.body.items ?? []));
        next = answer.body.next_cursor;
        if (!next) break;
      }
      return out;
    };
    const everything = await collect("");
    const ids = everything.map(item => item.proof_id);
    results.check("dm's listing, 9 at a time across every page: no proof twice, newest first, ours in order", new Set(ids).size === ids.length && JSON.stringify(ids.filter(id => mine.has(id))) === JSON.stringify(newestFirst) && everything.every((item, i) => i === 0 || Date.parse(everything[i - 1]!.created_at) >= Date.parse(item.created_at)), `${ids.length} proofs listed`);
    const shapes = everything.filter(item => typeof item.receiving_app !== "string" || "audiences" in item || "receiving_apps" in item);
    results.check("every entry names its one receiving app as receiving_app (a string), never a list of apps", everything.length > 0 && shapes.length === 0 && everything.filter(item => mine.has(item.proof_id)).every(item => item.receiving_app === "briefcase"), shapes.length ? short(shapes[0]) : `${everything.length} entries`);
    const revokedUserVerification = (await collect("&kind=user_verification&status=revoked")).filter(item => mine.has(item.proof_id));
    results.check("?kind=user_verification&status=revoked has exactly our two revoked proofs, with who revoked them", JSON.stringify(revokedUserVerification.map(item => `${item.proof_id}:${item.revoke_reason}`)) === JSON.stringify([`${p4.proof_id}:revoked_by_account`, `${p2.proof_id}:revoked_by_app`]), short(revokedUserVerification.map(item => item.revoke_reason)));
    const ataOnly = await collect("&kind=app_verification");
    results.check("?kind=app_verification lists no User verification proof", ataOnly.every(item => item.kind === "app_verification" && item.user === null), `${ataOnly.length} App verification proof(s)`);
    const badKind = await asApp<Page<AppProofItem>>(ctx, "dm", "GET", "/v1/apps/dm/proofs?kind=xyz");
    results.check("?kind=xyz → 400/422", badKind.status === 400 || badKind.status === 422, `${badKind.status} ${short(badKind.body)}`);

    // A refresh shows on the listing; the verification names the account's current id after an id change.
    await refreshAs(ctx, "dm", p5.proof_refresh_token);
    const refreshedItem = (await carbon.session.call<Page<MyProofItem>>("GET", "/v1/me/proofs?status=active")).body.items?.find(item => item.proof_id === p5.proof_id);
    results.check("after dm refreshes a proof, the account's listing shows last_refreshed_at", !!refreshedItem?.last_refreshed_at, short(refreshedItem));
    const newId = `c:pp-renamed-${carbon.uuid.toLowerCase()}-${Date.now().toString(36)}`;
    const changed = await carbon.session.call<{ id?: string }>("POST", "/v1/me/id", { id: newId });
    results.check("the Carbon changes its id on the account site's API", changed.status === 200 && changed.body.id === newId, `${changed.status} ${short(changed.body)}`);
    const renamed = await verifyAs(ctx, "briefcase", p3.proof_token);
    results.check("Briefcase's next verify of a proof issued before the change names the new id; uuid and membership dm:<uuid> unchanged", renamed.body.valid === true && renamed.body.user?.id === newId && renamed.body.user.uuid === carbon.uuid && renamed.body.user.membership_id === `dm:${carbon.uuid}`, short(renamed.body.user));

    // The receiving app needs no membership: the Carbon never signed into Briefcase.
    const apps = (await carbon.session.call<Page<{ app: { app_id: string } }>>("GET", "/v1/me/apps?limit=200")).body.items ?? [];
    results.check("the Carbon never signed into Briefcase, yet Briefcase verified proofs about it (User verification needs the issuing app's grant only)", !apps.some(item => item.app.app_id === "briefcase") && apps.some(item => item.app.app_id === "dm"), apps.map(item => item.app.app_id).join(", "));
  },
};
