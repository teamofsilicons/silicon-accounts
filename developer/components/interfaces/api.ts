"use client";
import {ApiError} from "@/lib/api/errors";

export type Kind = "unverified" | "verified" | "trusted";
export type Upload = {id:string; url:string; filename:string; content_type:string; size:number; sha256:string; category:"image"|"release"};
export type Interface = {interface_id:string; name:string; logo_url:string|null; kind:Kind; app_ids:string[]; app_descriptions:Record<string,string>; redirect_uris:string[]; allowed_origins:string[]; branding:Record<string, unknown>; signin_config:Record<string, unknown>; description:string; website_url:string|null; cover_url:string|null; images:string[]; platforms:string[]; links:{label:string;url:string}[]; published:boolean; revision:number; pending_operation?:{action:string;can_resume:boolean}|null; creators:{uuid:string;id:string;display_name:string;pfp_url:string|null}[]; releases:{id:string;version:string;notes:string;created_at:string;assets:{platform:string;upload_id:string;url:string;filename:string;sha256:string;size:number}[]}[]};
export type Invitation = {id:string;interface_id:string;interface_name:string;inviter_uuid:string;target_uuid:string;status:string;created_at:string};
export type Me = {eligibility:{verified:boolean;trusted:boolean};invites:Invitation[]};
export type History = {id:string|number;actor_uuid:string;action:string;detail:unknown;created_at:string};
export type AccessRequest = {id:string;kind:string;reason:string;status:string;created_at:string};

const pending = new Map<string,string>();
const storagePrefix = "silicon-interfaces-operation:";
/** Persist only a hash and operation key, never the request, tokens or a returned secret. */
async function fingerprint(value:string):Promise<string> {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
}
function storedKey(id:string):string|undefined {try{return sessionStorage.getItem(storagePrefix+id)??undefined;}catch{return undefined;}}
function rememberKey(id:string,key:string) {pending.set(id,key);try{sessionStorage.setItem(storagePrefix+id,key);}catch{}if(pending.size>256)pending.delete(pending.keys().next().value!);}
function forgetKey(id:string) {pending.delete(id);try{sessionStorage.removeItem(storagePrefix+id);}catch{}}
export async function request<T>(path:string, options:{method?:string;body?:unknown;key?:string;file?:File} = {}):Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers({accept:"application/json"});
  let body: BodyInit | undefined;
  if (options.file) {body=options.file;headers.set("content-type",options.file.type||"application/octet-stream");headers.set("x-filename",encodeURIComponent(options.file.name));}
  else if (options.body !== undefined) {body=JSON.stringify(options.body);headers.set("content-type","application/json");}
  let operation = "";
  if (method !== "GET") {
    // Large files stream without loading hundreds of MiB to hash in memory. The service verifies actual bytes on replay.
    const identity=options.file ? JSON.stringify([options.file.name,options.file.size,options.file.lastModified,options.file.type]) : String(body??"");
    operation=await fingerprint(JSON.stringify([method,path,identity]));
    headers.set("idempotency-key",options.key ?? pending.get(operation) ?? storedKey(operation) ?? crypto.randomUUID());
    rememberKey(operation,headers.get("idempotency-key")!);
  }
  let response:Response;
  try {response = await fetch(`/api/interfaces/${path}`, {method,headers,body,credentials:"same-origin",redirect:"error"});}
  catch(cause) {throw new ApiError({status:0,code:"network_unavailable",message:"Could not reach Silicon Interfaces.",hint:"Check your connection and retry. An unchanged request keeps its operation key.",cause});}
  const data: unknown = await response.json().catch(() => ({}));
  const failure = data as {error?:{code?:string;message?:string;hint?:string}};
  if (operation && (response.ok || (response.status < 500 && response.status !== 408 && response.status !== 429 && failure.error?.code !== "idempotency_result_unavailable"))) forgetKey(operation);
  if (!response.ok) throw new ApiError({status:response.status,code:failure.error?.code ?? "request_failed",message:failure.error?.message ?? `Interfaces returned HTTP ${response.status}.`,hint:failure.error?.hint});
  return data as T;
}

/** Private media is fetched by the sealed-session BFF rather than exposing a token in the page. */
export function mediaUrl(id:string, url:string):string {
  try {const path = new URL(url).pathname; const match = path.match(/^\/v1\/interfaces\/([A-Za-z0-9_-]+)\/uploads\/([A-Za-z0-9_-]+)$/); return match && match[1] === id ? `/api/interfaces/interfaces/${id}/uploads/${match[2]}` : url;}
  catch {return url;}
}
