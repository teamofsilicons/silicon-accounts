"use client";
import {useEffect,useRef,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {cellsRequest} from "@/lib/cells/api";
import {useNavigationGuard} from "@/lib/navigation-guard";
import {ApiError} from "@/lib/api/errors";

export const cellPath=(id:string,tail="")=>`/cells/${encodeURIComponent(id)}${tail}`;
export function useCellData<T>(id:string,tail:string){
  return useQuery({queryKey:["cells",id,tail],queryFn:({signal})=>cellsRequest<T>(cellPath(id,tail),{signal})});
}
export function Failure({error}:{error:unknown}){
  if(error==null)return null;
  const problem=ApiError.from(error);
  return <Alert tone="danger" title={problem.message}>{problem.hint}</Alert>;
}
/** Plain local state: secret inputs and one-time results never enter a query/mutation cache. */
export function useCellAction(id:string){
  const cache=useQueryClient(),pending=useRef(false);
  const operations=useRef(new Map<string,string>());
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  async function run<T>(tail:string,method:string,body?:unknown):Promise<T|undefined>{
    if(pending.current)return undefined;
    pending.current=true;setBusy(true);setError(null);
    try{
      const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([tail,method,body])));
      const fingerprint=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
      let key=operations.current.get(fingerprint);
      if(!key){key=crypto.randomUUID();operations.current.set(fingerprint,key);}
      const result=await cellsRequest<T>(cellPath(id,tail),{method,body,key});
      operations.current.delete(fingerprint);
      // Refresh is advisory; a refresh failure must not turn a successful mutation into a retry.
      void cache.invalidateQueries({queryKey:["cells",id]});
      void cache.invalidateQueries({queryKey:["cells","list"]});
      return result;
    }catch(cause){setError(cause);return undefined;}
    finally{pending.current=false;setBusy(false);}
  }
  return {run,busy,error};
}
export function bytes(value:number){
  if(value<1024)return `${value} B`;
  const index=Math.min(4,Math.floor(Math.log(value)/Math.log(1024)));
  return `${(value/1024**index).toLocaleString(undefined,{maximumFractionDigits:1})} ${["B","KiB","MiB","GiB","TiB"][index]}`;
}
export const date=(value:string)=>new Date(value).toLocaleString();

export function useCellsLeaveGuard(active:boolean,description:string){
  useNavigationGuard(active?{question:{title:"Leave this page?",description}}:null);
  useEffect(()=>{
    if(!active)return;
    const warn=(event:BeforeUnloadEvent)=>event.preventDefault();
    window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);
  },[active]);
}
