/**
 * Query keys for every cached API read, in one place so any page can invalidate what it changed:
 *
 *   queryClient.invalidateQueries({ queryKey: queryKeys.me.root })            // everything under /v1/me
 *   queryClient.setQueryData(queryKeys.flow(flow.id), flow)
 */
import type { HistoryKind } from "../api/types";

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
    silicons: ["me", "silicons"] as const,
    silicon: (uuid: string) => ["me", "silicons", uuid] as const,
    custodianRequests: ["me", "custodian-requests"] as const,
  },

  /** An app's public sign-in look (the embed reads it itself). */
  app: {
    public: (appId: string) => ["apps", appId, "public"] as const,
  },

  flow: (id: string) => ["flows", id] as const,
  device: (userCode: string) => ["device", userCode] as const,
};
