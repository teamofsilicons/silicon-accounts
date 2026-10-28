"use client";
import {useState} from "react";
import {Section,Surface,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {SecretReveal} from "@/components/developer/parts/secret-reveal";
import {CopyField} from "@/components/developer/parts/copy-field";
import type {Cell,CreatedCell} from "@/lib/cells/api";
import {useCellData,useCellAction,useCellsLeaveGuard,Failure,bytes,date,cellPath} from "./shared";
import styles from "./cells.module.css";

type Backup={id:string;kind:string;status:string;requested_at:string;point_at:string|null;completed_at:string|null;expires_at:string;size_bytes:number|null;sha256:string|null;error_code:string|null};
type Recovery={status:string;earliest_at:string|null;latest_at:string|null;error_code:string|null};
type Restore={id:string;source_cell:string;destination_cell:string;source_backup:string|null;source_point:string|null;before_backup:string|null;status:string;error_code:string|null;created_at:string;updated_at:string;completed_at:string|null};
const pageSize=20;
const page=(before:string|undefined)=>`?limit=${pageSize}${before?`&before=${encodeURIComponent(before)}`:""}`;
function Time({value}:{value:string}){return <><time dateTime={value}>{date(value)}</time><span className={styles.muted}> ({new Date(value).toISOString()})</span></>;}

export function CellBackups({cell}:{cell:Cell}){
  const [backupPages,setBackupPages]=useState<string[]>([]),[restorePages,setRestorePages]=useState<string[]>([]);
  const backups=useCellData<{backups:Backup[];recovery:Recovery}>(cell.cell_id,`/backups${page(backupPages.at(-1))}`);
  const restores=useCellData<{restores:Restore[]}>(cell.cell_id,`/restores${page(restorePages.at(-1))}`);
  const action=useCellAction(cell.cell_id),[notice,setNotice]=useState("");
  const [open,setOpen]=useState(false),[source,setSource]=useState<"backup"|"point_in_time">("backup"),[backupId,setBackupId]=useState(""),[at,setAt]=useState("");
  const [destination,setDestination]=useState<"current"|"new">("current"),[confirm,setConfirm]=useState(""),[name,setName]=useState(""),[newId,setNewId]=useState("");
  const [validation,setValidation]=useState(""),[created,setCreated]=useState<CreatedCell|null>(null);
  const [operation,setOperation]=useState<Restore|null>(null),[retrying,setRetrying]=useState<Restore|null>(null);
  useCellsLeaveGuard(action.busy||created!==null,"Save the new cell credentials before leaving. They are shown only once.");
  const active=cell.status==="active",recovery=backups.data?.recovery;
  const instant=at&&!Number.isNaN(new Date(at).getTime())?new Date(at).toISOString():null;
  function choose(id?:string){setBackupId(id??"");setSource(id?"backup":"point_in_time");setConfirm("");setValidation("");setCreated(null);setOpen(true);}
  async function restore(){
    setValidation("");
    if(source==="backup"&&!/^[0-9a-f-]{36}$/u.test(backupId)){setValidation("Select a ready backup or enter its backup ID.");return;}
    if(source==="point_in_time"&&(!instant||!recovery?.earliest_at||!recovery.latest_at||instant<new Date(recovery.earliest_at).toISOString()||instant>new Date(recovery.latest_at).toISOString())){setValidation("Choose a time inside the available recovery window.");return;}
    if(destination==="current"&&confirm!==cell.cell_id){setValidation("Type the exact current cell ID to confirm replacement.");return;}
    const result=await action.run<{restore:Restore;created_cell:CreatedCell|null}>("/backups/restore","POST",{source:source==="backup"?{type:source,id:backupId}:{type:source,at:instant},destination:destination==="current"?{type:destination,confirm_cell_id:confirm}:{type:destination,name,cell_id:newId||null}});
    if(result){setOperation(result.restore);setNotice("Restore admitted. Refresh status to follow recovery.");if(result.created_cell)setCreated(result.created_cell);else setOpen(false);}
  }
  async function create(){const result=await action.run<{backup:Backup}>("/backups","POST");if(result)setNotice(`Backup requested: ${result.backup.id}. Refresh status until it is ready.`);}
  const refresh=()=>{void backups.refetch();void restores.refetch();};
  return <Stack gap={8}>
    <Failure error={backups.error??restores.error??(!open?action.error:null)}/>
    {notice&&<Alert tone="info" title={notice}/>}
    <Section title="Database backups" description="Daily database backups and point-in-time recovery for the last seven days, when coverage is available.">
      <Surface><Stack><Cluster><Button disabled={!active||action.busy} onClick={()=>void create()}>Create backup</Button><Button variant="secondary" onClick={refresh} disabled={backups.isFetching||restores.isFetching}>Refresh backup status</Button><Button variant="secondary" disabled={!active||action.busy||!recovery?.earliest_at||!recovery.latest_at} onClick={()=>choose()}>Restore a point in time</Button></Cluster>
        <p className={styles.muted}>A restore first saves the current database for undo. Current authors, credentials, revocations, secrets and completed side effects are preserved. Restoring into a new cell creates fresh credentials; app links and secrets need separate setup.</p>
        {recovery&&<div><strong>Recovery coverage: {recovery.status}</strong>{recovery.earliest_at&&recovery.latest_at?<p>From <Time value={recovery.earliest_at}/> through <Time value={recovery.latest_at}/></p>:<p>No verified recovery window is available yet.</p>}{recovery.error_code&&<p>Reason: {recovery.error_code}</p>}</div>}
      </Stack></Surface>
      {backups.isPending?<p role="status">Loading backups…</p>:<div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Backup</th><th>Recovery point</th><th>Status</th><th>Size / expires</th><th>Actions</th></tr></thead><tbody>{backups.data?.backups.map(backup=><tr key={backup.id}><td><code>{backup.id}</code><div>{backup.kind}</div></td><td><Time value={backup.point_at??backup.requested_at}/></td><td>{backup.status}{backup.error_code&&<div>{backup.error_code}</div>}</td><td>{backup.size_bytes!==null&&bytes(backup.size_bytes)}<div>Expires <Time value={backup.expires_at}/></div></td><td><div className={styles.actions}>{backup.status==="ready"&&<><a href={`/api/cells${cellPath(cell.cell_id,`/backups/${backup.id}/download`)}`} download={`${cell.cell_id}-${backup.id}.dump`}>Download database</a><Button size="sm" variant="secondary" disabled={!active||action.busy} onClick={()=>choose(backup.id)}>Restore backup</Button></>}</div>{backup.sha256&&<details><summary>SHA-256</summary><code>{backup.sha256}</code></details>}</td></tr>)}</tbody></table>{!backups.data?.backups.length&&<p>No backups on this page.</p>}</div>}
      <Cluster><Button variant="secondary" disabled={!backupPages.length} onClick={()=>setBackupPages(pages=>pages.slice(0,-1))}>Newer backups</Button><Button variant="secondary" disabled={backups.data?.backups.length!==pageSize} onClick={()=>setBackupPages(pages=>[...pages,backups.data!.backups.at(-1)!.id])}>Older backups</Button></Cluster>
    </Section>
    <Section title="Restore history" description="Retry a failed operation after repairing its reported problem. Both cells must still authorize you, and the original backup or recovery point must remain available.">
      {operation&&!restores.data?.restores.some(item=>item.id===operation.id)&&<p role="status">Latest operation: {operation.id} · {operation.status}</p>}
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Operation</th><th>Source</th><th>Status</th><th>Undo / retry</th></tr></thead><tbody>{restores.data?.restores.map(item=><tr key={item.id}><td><code>{item.id}</code><div>Destination: {item.destination_cell}</div><Time value={item.created_at}/></td><td>{item.source_point?<Time value={item.source_point}/>:<code>{item.source_backup}</code>}</td><td>{item.status}{item.error_code&&<div>{item.error_code}</div>}</td><td>{item.before_backup?<><code>{item.before_backup}</code><div>{item.destination_cell===cell.uuid?<Button size="sm" variant="secondary" disabled={!active||action.busy} onClick={()=>choose(item.before_backup!)}>Restore pre-restore backup</Button>:"Open the destination cell to undo."}</div></>:"—"}{item.status==="failed"&&<div><Button size="sm" variant="secondary" disabled={action.busy} onClick={()=>setRetrying(item)}>Retry restore</Button></div>}</td></tr>)}</tbody></table>{!restores.isPending&&!restores.data?.restores.length&&<p>No restore operations on this page.</p>}</div>
      <Cluster><Button variant="secondary" disabled={!restorePages.length} onClick={()=>setRestorePages(pages=>pages.slice(0,-1))}>Newer restores</Button><Button variant="secondary" disabled={restores.data?.restores.length!==pageSize} onClick={()=>setRestorePages(pages=>[...pages,restores.data!.restores.at(-1)!.id])}>Older restores</Button></Cluster>
    </Section>
    <Dialog open={retrying!==null} onOpenChange={value=>{if(!value&&!action.busy)setRetrying(null);}}><DialogContent title="Retry this restore?" description="This retries the same recovery point and destination. If replacing an existing database, a fresh pre-restore backup is saved first; the previous undo backup remains in history."><Stack><Failure error={action.error}/>{retrying&&<p>Destination: {retrying.destination_cell}<br/>Operation: {retrying.id}</p>}<Button loading={action.busy} onClick={async()=>{if(!retrying)return;const result=await action.run<{restore:Restore}>(`/restores/${retrying.id}/retry`,"POST");if(result){setOperation(result.restore);setNotice("Restore queued again. Refresh status to follow recovery.");setRetrying(null);}}}>Confirm restore retry</Button></Stack></DialogContent></Dialog>
    <Dialog open={open} onOpenChange={value=>{if(!action.busy&&!created)setOpen(value);}}><DialogContent title={created?"Save the new cell credentials":"Restore database"} description={created?"Recovery is still in progress. Keep these credentials private and check restore status before using the new cell.":"Review the recovery point and destination before starting."}>
      {created?<Stack><CopyField label="Cell URL" value={created.cell.url}/><CopyField label="Publishable key" value={created.publishable_key}/><SecretReveal title="Server credentials" description="These credentials stay in this dialog until you dismiss it." secrets={[{label:"Secret key",value:created.secret_key},{label:"Database connection",value:created.database_url},{label:"Database password",value:created.database_password}]} onDone={()=>{setCreated(null);setOpen(false);}} doneLabel="I’ve saved these credentials"/></Stack>:<form onSubmit={event=>{event.preventDefault();void restore();}}><Stack>
        <Failure error={action.error}/>{validation&&<Alert tone="danger" title={validation}/>}
        <label>Recovery source <select aria-label="Recovery source" value={source} disabled={action.busy} onChange={event=>setSource(event.target.value as typeof source)}><option value="backup">Saved backup</option><option value="point_in_time">Point in time</option></select></label>
        {source==="backup"?<Input label="Backup ID" required value={backupId} disabled={action.busy} onChange={event=>setBackupId(event.target.value)}/>:<><Input label="Recovery time (your local timezone)" type="datetime-local" step="1" required value={at} disabled={action.busy} onChange={event=>setAt(event.target.value)}/>{instant&&<p>Exact UTC recovery point: {instant}</p>}</>}
        <label>Destination <select aria-label="Destination" value={destination} disabled={action.busy} onChange={event=>setDestination(event.target.value as typeof destination)}><option value="current">Replace this cell’s database</option><option value="new">Restore into a new cell</option></select></label>
        {destination==="current"?<><Alert tone="warning" title="This replaces the current database">The cell pauses while recovery runs. A fresh pre-restore backup is retained for undo.</Alert><Input label="Confirm current cell ID" required value={confirm} disabled={action.busy} onChange={event=>setConfirm(event.target.value)} description={`Type ${cell.cell_id} exactly.`}/></>:<><Input label="New cell name" required maxLength={100} value={name} disabled={action.busy} onChange={event=>setName(event.target.value)}/><Input label="New cell ID (optional)" pattern="(?!.*--)[a-z][a-z0-9\-]{1,28}[a-z0-9]" value={newId} disabled={action.busy} onChange={event=>setNewId(event.target.value)} description="Leave blank to generate an ID."/></>}
        <Button type="submit" loading={action.busy} disabled={!active}>Start restore</Button>
      </Stack></form>}
    </DialogContent></Dialog>
  </Stack>;
}
