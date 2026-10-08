/**
 * Query keys for every cached API read, in one place so any page can invalidate what it changed:
 *
 *   queryClient.invalidateQueries({ queryKey: queryKeys.me.root })            // everything under /v1/me
 *   queryClient.setQueryData(queryKeys.flow(flow.id), flow)
 */
import type { AppProofsQuery, AppUsersQuery, DeliveriesQuery, HistoryKind, ImportRowsQuery, ManagedAppProofsQuery } from "../api/types";

export const queryKeys = {
  meta: ["meta"] as const,
  session: ["session"] as const,
  idAvailability: (id: string) => ["ids", "available", id] as const,
  account: (uuid: string) => ["accounts", uuid] as const,

  me: {
    /** Prefix of everything about the signed-in account (invalidate it after sign-in or a big change). */
    root: ["me"] as const,
    view: ["me", "view"] as const,
    emails: ["me", "emails"] as const,
    phones: ["me", "phones"] as const,
    identities: ["me", "identities"] as const,
    apps: ["me", "apps"] as const,
    sessions: ["me", "sessions"] as const,
    /** Prefix of every history list (all kinds). */
    historyRoot: ["me", "history"] as const,
    history: (kind?: HistoryKind | null) => ["me", "history", kind ?? "all"] as const,
    proofs: ["me", "proofs"] as const,
    appProofsRoot: ["me", "app-proofs"] as const,
    accountVerificationRoot: ["me", "account-verification-request"] as const,
    accountVerification: (appId: string) => ["me", "account-verification-request", appId] as const,
    appProofs: (query: Omit<ManagedAppProofsQuery, "cursor" | "limit"> = {}) => ["me", "app-proofs", query] as const,
    silicons: ["me", "silicons"] as const,
    silicon: (uuid: string) => ["me", "silicons", uuid] as const,
    custodianRequests: ["me", "custodian-requests"] as const,
    ownedApps: ["me", "owned-apps"] as const,
  },

  app: {
    root: (appId: string) => ["apps", appId] as const,
    public: (appId: string) => ["apps", appId, "public"] as const,
    detail: (appId: string) => ["apps", appId, "detail"] as const,
    configHistory: (appId: string) => ["apps", appId, "config-history"] as const,
    users: (appId: string, query: Omit<AppUsersQuery, "cursor" | "limit"> = {}) => ["apps", appId, "users", query] as const,
    user: (appId: string, uuid: string) => ["apps", appId, "user", uuid] as const,
    imports: (appId: string) => ["apps", appId, "imports"] as const,
    import: (appId: string, jobId: string) => ["apps", appId, "imports", jobId] as const,
    importRows: (appId: string, jobId: string, query: Omit<ImportRowsQuery, "cursor" | "limit"> = {}) => ["apps", appId, "imports", jobId, "rows", query] as const,
    deliveries: (appId: string, query: Omit<DeliveriesQuery, "cursor" | "limit"> = {}) => ["apps", appId, "deliveries", query] as const,
    delivery: (appId: string, deliveryId: string) => ["apps", appId, "delivery", deliveryId] as const,
    proofs: (appId: string, query: Omit<AppProofsQuery, "cursor" | "limit"> = {}) => ["apps", appId, "proofs", query] as const,
    proofHistory: (appId: string, proofId: string) => ["apps", appId, "proofs", "history", proofId] as const,
  },

  flow: (id: string) => ["flows", id] as const,
  device: (userCode: string) => ["device", userCode] as const,
};
