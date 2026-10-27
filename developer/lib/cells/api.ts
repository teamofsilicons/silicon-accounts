/** The developer browser uses only its same-origin BFF, never Accounts tokens. */
import { ApiError } from "@/lib/api/errors";
export interface Cell {
  uuid: string; cell_id: string; name: string; status: string; url: string;
  created_at: string; deleted_at: string | null;
  settings: {allowed_origins: string[]; redirect_urls: string[]};
}
export interface Credentials {
  secret_key: string; database_url: string; database_password: string;
}
export interface AppCell {
  cell: Cell | null;
  publishable_key?: string | null;
  sign_in_links?: {redirect_to: string; sign_in: string; sign_up: string}[];
  created?: boolean;
  credentials?: Credentials;
}
export async function cellsRequest<T>(path: string, options: {method?: string; body?: unknown; key?: string; signal?: AbortSignal} = {}): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Use a relative Cells author path.");
  const headers = new Headers({accept: "application/json"});
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.key) headers.set("idempotency-key", options.key);
  let response: Response;
  try {
    response = await fetch(`/api/cells${path}`, {method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal, credentials: "same-origin", cache: "no-store", redirect: "error"});
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError({status: 0, code: "network_error", message: "Could not reach Silicon Cells.", hint: "Try again. Retrying a change keeps its operation key.", cause});
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError({status: response.status, code: body?.error?.code ?? "invalid_response", message: body?.error?.message ?? "Cells could not complete this request.", hint: body?.error?.hint, details: body?.error?.details});
  return body as T;
}
export const cellsApi = {
  list: (signal?: AbortSignal) => cellsRequest<{cells: Cell[]}>("/cells", {signal}),
  app: (app: string, signal?: AbortSignal) => cellsRequest<AppCell>(`/apps/${encodeURIComponent(app)}/cell`, {signal}),
  enable: (app: string, cell: string | null, key: string) => cellsRequest<AppCell>(`/apps/${encodeURIComponent(app)}/cell`, {method: "POST", body: {cell_id: cell}, key}),
};
