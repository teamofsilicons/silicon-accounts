import {useSession} from "@/lib/query/session";
import {useQuery} from "@tanstack/react-query";
import {ApiError} from "@/lib/api/errors";
export type ResourceKind = "apps" | "interfaces" | "cells";
export type Permission = "create" | "read" | "edit" | "publish" | "manage";
export type Subject = {type:"account" | "team"; id:string};
export type Grant = {subject:Subject; resources:ResourceKind[]; permissions:Permission[]};
export type Policy = {grants:Grant[]};
export type ResourcePolicy = Policy & {audience:{mode:"organization" | "restricted"; include:Subject[]; exclude:Subject[]}};
export type Organization = {org_id:string; name:string; logo_url:string|null; admin:boolean; teams:string[]; permissions:Partial<Record<ResourceKind,Permission[]>>};
export type Context = {account_uuid:string; organizations:Organization[]};
export type Member = {uuid:string; id:string; display_name:string; pfp_url:string; removed_at?:number|null};
export type Directory = {members:Member[]; teams:{id:string;name:string}[]};
export const emptyResourcePolicy = ():ResourcePolicy => ({grants:[],audience:{mode:"organization",include:[],exclude:[]}});
const pending = new Map<string,string>();
export async function organizationApi<T>(path:string, body?:unknown, signal?:AbortSignal):Promise<T> {
  const fingerprint = JSON.stringify([path,body]);
  if (body !== undefined && !pending.has(fingerprint)) { if(pending.size>=256)pending.delete(pending.keys().next().value!);pending.set(fingerprint,crypto.randomUUID()); }
  const response = await fetch(`/api/organizations/${path}`, {method:body === undefined?"GET":"POST", headers:body === undefined?undefined:{"content-type":"application/json","idempotency-key":pending.get(fingerprint)!}, body:body === undefined?undefined:JSON.stringify(body), signal, credentials:"same-origin"});
  const data = await response.json();
  if (response.ok || (response.status<500 && ![408,429].includes(response.status))) pending.delete(fingerprint);
  if (!response.ok) throw new ApiError({status:response.status,code:data.error?.code??"organization_request_failed",message:data.error?.message??"Organizations could not complete this request."});
  return data as T;
}
export function useOrganizations() {const {me}=useSession();return useQuery({queryKey:["organizations","publishing",me?.uuid],enabled:!!me,queryFn:({signal})=>organizationApi<Context>("publishing",undefined,signal),staleTime:0,retry:false});}
export function useOrganizationDirectory(org:string|null) {const {me}=useSession();return useQuery({queryKey:["organizations",org,"directory",me?.uuid],queryFn:({signal})=>organizationApi<Directory>(`orgs/${org}`,undefined,signal),enabled:!!org,staleTime:0,retry:false});}
