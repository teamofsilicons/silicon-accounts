'use client';
import {useQuery} from '@tanstack/react-query';
import {useSession} from '@/lib/query/session';
import {ApiError} from '@/lib/api/errors';
import {mergePeople,type Person,type Contact} from './ranking';
export async function contactsApi<T>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{const response=await fetch(`/api/contacts/${path}`,{method,headers:body===undefined?undefined:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal,credentials:'same-origin'});const value=await response.json();if(!response.ok)throw new ApiError({status:response.status,code:value.error?.code??'contacts_unavailable',message:value.error?.message??'Contacts could not complete this request.'});return value;}
export function useContacts(){
 const {me}=useSession();
 const connection=useQuery({queryKey:['contacts','connection',me?.uuid],enabled:!!me,queryFn:({signal})=>contactsApi<{connected:boolean}>('connection','GET',undefined,signal),retry:false});
 const contacts=useQuery({queryKey:['contacts','list',me?.uuid],enabled:connection.data?.connected===true,queryFn:async({signal})=>{const items:Contact[]=[];for(let offset=0;;offset+=200){const page=await contactsApi<{items:Contact[];total:number}>(`contacts?limit=200&offset=${offset}`,'GET',undefined,signal);if(!Array.isArray(page.items)||!Number.isFinite(page.total))throw new Error('Contacts returned an incomplete address book.');items.push(...page.items);if(!page.items.length||items.length>=page.total)return items;}},retry:false});
 return {connection,contacts:{...contacts,data:connection.data?.connected?contacts.data:undefined}};
}
export function usePeople(){const {me}=useSession();const {connection,contacts}=useContacts();const history=useQuery({queryKey:['people','history',me?.uuid],enabled:!!me,queryFn:async({signal})=>{const results=await Promise.allSettled(['apps','interfaces','cells'].map(async service=>{const r=await fetch(`/api/${service}/people`,{signal,credentials:'same-origin'});if(!r.ok)throw Error(service);const value=await r.json();if(!Array.isArray(value.items))throw Error(service);return value.items.filter((p:Person|null)=>p&&typeof p.uuid==='string') as Person[];}));return {items:results.flatMap(r=>r.status==='fulfilled'?r.value:[]),partial:results.some(r=>r.status==='rejected')};},retry:false,staleTime:0});return {accountUuid:me?.uuid,people:mergePeople(history.data?.items??[],contacts.data??[]),connection,contacts,history};}
export function safePhoto(value:string|null|undefined){if(!value)return undefined;if(value.startsWith('/api/contacts/photos/'))return value;try{const url=new URL(value);return url.protocol==='https:'?value:undefined;}catch{return undefined;}}
