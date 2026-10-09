/** The docs API's fixed vocabulary and limits, shared by lib/docs/api.ts and /openapi.json. */
export const PRODUCT_KEYS = ["apps", "accounts"] as const;
export const KIND_KEYS = ["start", "learn", "reference"] as const;
export type Product = (typeof PRODUCT_KEYS)[number];
export type Kind = (typeof KIND_KEYS)[number] | "overview";

export const MAX_QUERY = 200;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 10;
