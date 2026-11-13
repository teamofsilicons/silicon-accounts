"use client";
import {useState} from "react";
import {Section,Surface,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {useCellAction,useCellData,Failure} from "./shared";
import styles from "./cells.module.css";
interface Location {id:string;kind:"managed"|"s3";bucket:string;region:string;active:boolean}
export function StorageLocations({cellId}:{cellId:string}){
  const query=useCellData<{locations:Location[]}>(cellId,"/storage/locations"),action=useCellAction(cellId);
  const [selected,setSelected]=useState<Location|null>(null),[access,setAccess]=useState(""),[secret,setSecret]=useState(""),[session,setSession]=useState("");
  function close(){setSelected(null);setAccess("");setSecret("");setSession("");}
  async function save(){
    if(!selected)return;
    const input=selected.kind==="managed"?{kind:"managed"}:{kind:"s3",access_key_id:access,secret_access_key:secret,session_token:session||null};
    if(await action.run(`/storage/locations/${selected.id}/credentials`,"PUT",input))close();
  }
  return <Section title="Storage connections" description="Repair revoked credentials for current or previous locations. This remains available for stopped cells awaiting erasure."><Stack><Failure error={query.error}/>{query.isPending?<p role="status">Loading storage connections…</p>:query.data?.locations.map(location=><Surface key={location.id}><Cluster justify="between"><div><strong>{location.bucket}</strong><p className={styles.muted}>{location.region} · {location.kind==="managed"?"Managed storage":"Your S3 bucket"} · {location.active?"Current":"Previous or pending"}</p></div><Button variant="secondary" onClick={()=>setSelected(location)}>Repair connection</Button></Cluster></Surface>)}{query.data?.locations.length===0&&<p>No storage connections yet.</p>}</Stack>
    <Dialog open={selected!==null} onOpenChange={value=>{if(!value&&!action.busy)close();}}><DialogContent title="Repair storage connection" description={`Validate access to ${selected?.bucket??"this bucket"} without changing where its files are stored.`}>
      <form onSubmit={event=>{event.preventDefault();void save();}}><Stack><Failure error={action.error}/>{selected?.kind==="s3"?<><Input label="Access key ID" required type="password" autoComplete="off" value={access} onChange={e=>setAccess(e.target.value)}/><Input label="Secret access key" required type="password" autoComplete="off" value={secret} onChange={e=>setSecret(e.target.value)}/><Input label="Session token (optional)" type="password" autoComplete="off" value={session} onChange={e=>setSession(e.target.value)}/></>:<p>Reconnect this location using the platform’s current managed-storage credentials.</p>}<Button type="submit" loading={action.busy}>Validate and repair</Button></Stack></form>
    </DialogContent></Dialog>
  </Section>;
}
