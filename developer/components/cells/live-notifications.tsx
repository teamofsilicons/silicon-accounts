"use client";
import {useEffect,useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {Button} from "@/components/silicon-ui/button/button";
import {Cluster} from "@/components/foundation/layout/layout";
import {cellPath} from "./shared";

export function LiveNotifications({cellId,onConnected}:{cellId:string;onConnected:(value:boolean)=>void}) {
  const [enabled,setEnabled]=useState(false);
  const [status,setStatus]=useState("Live updates are off");
  const query=useQueryClient();
  useEffect(()=>{
    if(!enabled)return;
    const abort=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let failures=0;
    const refresh=()=>{void query.invalidateQueries({queryKey:["cells",cellId]});};
    async function connect(){
      onConnected(false);setStatus("Connecting to Ting…");
      const started=Date.now();
      try{
        const response=await fetch(`/api/cells${cellPath(cellId,"/notifications/live")}`,{
          method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","accept":"text/event-stream"},
          body:JSON.stringify({allow:true}),signal:abort.signal,
        });
        if(!response.ok||!response.body||!response.headers.get("content-type")?.includes("text/event-stream")){
          await response.body?.cancel();
          if([401,403,404].includes(response.status)){setStatus("Live updates stopped. Refresh this page to check access.");return;}
          throw new Error("Live updates unavailable");
        }
        const reader=response.body.getReader(),decoder=new TextDecoder();
        let buffer="";
        try{
          while(!abort.signal.aborted){
            const chunk=await reader.read();if(chunk.done)break;
            buffer+=decoder.decode(chunk.value,{stream:true});
            if(buffer.length>65536)throw new Error("Invalid stream");
            let end:number;
            while((end=buffer.indexOf("\n\n"))>=0){
              const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
              if(/^event: ?ready$/m.test(frame)){onConnected(true);setStatus("Live updates connected through Ting");refresh();}
              if(/^event: ?changed$/m.test(frame))refresh();
            }
          }
        }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      }catch{ /* Fixed UI text only; upstream prose and credentials stay private. */ }
      if(abort.signal.aborted)return;
      if(Date.now()-started>=60000)failures=0;
      onConnected(false);setStatus("Reconnecting to Ting…");
      const delay=Math.min(30000,1000*2**Math.min(failures++,5))*(0.8+Math.random()*0.2);
      timer=setTimeout(()=>void connect(),delay);
    }
    void connect();
    return()=>{abort.abort();clearTimeout(timer);onConnected(false);};
  },[enabled,cellId,query,onConnected]);
  return <Cluster><Button variant="secondary" onClick={()=>{setEnabled(value=>!value);setStatus("Live updates are off");}}>{enabled?"Stop live updates":"Enable live updates"}</Button><span role="status">{status}</span></Cluster>;
}
