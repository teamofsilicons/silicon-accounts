"use client";
import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {Section,Surface,Stack,Cluster,DescriptionList,DescriptionItem} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Select} from "@/components/silicon-ui/select/select";
import {Checkbox} from "@/components/silicon-ui/checkbox/checkbox";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {CopyField} from "@/components/developer/parts/copy-field";
import {cellsRequest} from "@/lib/cells/api";
import {cellPath,useCellAction,Failure,date} from "./shared";
import styles from "./cells.module.css";
export interface Bucket {id:string;public:boolean;max_file_bytes:number;allowed_mime_types:string[];created_at:string}
export function BucketEditor({cellId,bucket,onDone}:{cellId:string;bucket?:Bucket;onDone:()=>void}){
  const action=useCellAction(cellId),rules=useCellAction(cellId),remove=useCellAction(cellId);
  const [id,setId]=useState(bucket?.id??""),[isPublic,setPublic]=useState(bucket?.public??false),[limit,setLimit]=useState(String(bucket?.max_file_bytes??52428800)),[types,setTypes]=useState(bucket?.allowed_mime_types.join(", ")??"");
  const [preset,setPreset]=useState(""),[app,setApp]=useState(""),[applied,setApplied]=useState(false),[confirm,setConfirm]=useState("");
  async function save(){if(await action.run(`/storage/buckets/${encodeURIComponent(id)}`,"PUT",{public:isPublic,max_file_bytes:Number(limit),allowed_mime_types:types.split(",").map(s=>s.trim()).filter(Boolean)}))onDone();}
  return <Stack gap={8}><form onSubmit={e=>{e.preventDefault();void save();}}><Stack><Failure error={action.error}/>
    <Input label="Bucket name" required pattern="[a-z0-9][a-z0-9_\-]{0,62}" disabled={!!bucket||action.busy} value={id} onChange={e=>setId(e.target.value)}/>
    <Input label="Maximum file size in bytes" type="number" required min={1} max={5497558138880} value={limit} onChange={e=>setLimit(e.target.value)}/>
    <Input label="Allowed content types" value={types} onChange={e=>setTypes(e.target.value)} description="Comma-separated types such as image/*, application/pdf. Leave blank to allow all types."/>
    <Checkbox label="Public downloads" description="Anyone with a public file URL can download it. Uploads and listings still follow the access rules." checked={isPublic} onCheckedChange={v=>setPublic(v===true)}/>
    <Button type="submit" loading={action.busy}>{bucket?"Save bucket":"Create bucket"}</Button>
  </Stack></form>{bucket&&<>
    <Section title="File access preset" description="Replace this bucket’s standard access policy. Additional policies written in SQL are preserved."><form onSubmit={async e=>{e.preventDefault();if(preset&&await rules.run(`/storage/buckets/${encodeURIComponent(id)}/rule`,"PUT",preset==="app"?{app}:preset))setApplied(true);}}><Stack><Failure error={rules.error}/>
      <Select label="Apply a preset" value={preset} onValueChange={value=>{setPreset(value);setApplied(false);}} options={[{value:"closed",label:"No standard access policy"},{value:"public_read",label:"Everyone can read"},{value:"signed_in_read",label:"Signed-in accounts can read"},{value:"own_files",label:"Accounts manage their own files"},{value:"only_silicons",label:"Silicons only"},{value:"only_carbons",label:"Carbons only"},{value:"app",label:"Accounts signed in through an app"}]}/>
      {preset==="app"&&<Input label="App ID" required value={app} onChange={e=>setApp(e.target.value)}/>}
      {applied&&<p role="status">Access preset applied.</p>}<Button type="submit" variant="secondary" disabled={!preset} loading={rules.busy}>Apply preset</Button>
    </Stack></form></Section>
    <Section title="Delete bucket" description="The bucket must contain no files, deleted files, or unfinished uploads."><Stack><Failure error={remove.error}/><Input label={`Type ${id} to confirm`} value={confirm} onChange={e=>setConfirm(e.target.value)}/><Button variant="danger" disabled={confirm!==id} loading={remove.busy} onClick={async()=>{if(await remove.run(`/storage/buckets/${encodeURIComponent(id)}`,"DELETE"))onDone();}}>Delete bucket</Button></Stack></Section>
  </>}</Stack>;
}
interface Provider {id:string;kind:"s3"|"managed";bucket:string;region:string;migration:string|null;health:{checked_at:string|null;failures:number;incident:string|null;last_error:string|null}|null}
interface Move {id:string;status:string;attempts:number;copied_objects:number;created_at:string;last_error:{message:string;hint?:string}|null}
export function StorageProvider({cellId,cellUuid}:{cellId:string;cellUuid:string}){
  const provider=useQuery({queryKey:["cells",cellId,"/storage/provider"],queryFn:({signal})=>cellsRequest<{provider:Provider|null}>(cellPath(cellId,"/storage/provider"),{signal}),refetchInterval:q=>q.state.data?.provider?.migration?3000:60000});
  const moves=useQuery({queryKey:["cells",cellId,"/storage/migrations"],queryFn:({signal})=>cellsRequest<{migrations:Move[]}>(cellPath(cellId,"/storage/migrations"),{signal}),refetchInterval:q=>q.state.data?.migrations.some(m=>["queued","copying"].includes(m.status))?3000:false});
  const [edit,setEdit]=useState(false),retry=useCellAction(cellId),current=provider.data?.provider;
  return <Section title="Storage provider" description="Use managed storage, or connect your own S3 bucket." actions={<Button variant="secondary" disabled={!!current?.migration} onClick={()=>setEdit(true)}>{current?"Change provider":"Connect storage"}</Button>}><Stack>
    <Failure error={provider.error??moves.error??retry.error}/>
    {provider.isPending?<p role="status">Loading storage provider…</p>:current?<Surface><DescriptionList><DescriptionItem label="Provider">{current.kind==="managed"?"Platform-managed storage":"Your S3 bucket"}</DescriptionItem><DescriptionItem label="Bucket">{current.bucket}</DescriptionItem><DescriptionItem label="Region">{current.region}</DescriptionItem></DescriptionList></Surface>:!provider.error&&<p>No storage provider is connected.</p>}
    {current?.migration&&<Alert tone="info" title="Moving files">Downloads continue from the current provider. Uploads and file changes are paused until the move finishes.</Alert>}
    {current?.health?.checked_at&&<p className={styles.muted}>Permission check {current.health.failures?"failed":"passed"} · {date(current.health.checked_at)}</p>}
    {!!current?.health?.failures&&<Alert tone="danger" title="Storage permission check failed">Check the bucket, region and access credentials below. Existing files remain on this provider. {current.health.incident?"An alert is queued for the authors through Ting; delivery status is in History.":"The service will check again before opening an outage alert."}</Alert>}
    {!!moves.data?.migrations.length&&<div className={styles.tableWrap}><table className={styles.table}><caption className="sr-only">Storage provider changes</caption><thead><tr><th>Started</th><th>Status</th><th>Objects copied</th><th>Details</th></tr></thead><tbody>{moves.data.migrations.map(m=><tr key={m.id}><td>{date(m.created_at)}</td><td>{m.status}</td><td>{m.copied_objects}</td><td>{m.last_error&&<p>{m.last_error.message} {m.last_error.hint}</p>}{m.status==="failed"&&<Button variant="secondary" size="sm" loading={retry.busy} onClick={()=>void retry.run(`/storage/migrations/${m.id}/retry`,"POST")}>Retry migration</Button>}</td></tr>)}</tbody></table></div>}
  </Stack><Dialog open={edit} onOpenChange={setEdit}><DialogContent title="Storage connection" description="The connection is checked before it is accepted. Existing files are copied and verified before switching providers.">{edit&&<ProviderEditor cellId={cellId} cellUuid={cellUuid} current={current?.kind??"managed"} onDone={()=>setEdit(false)}/>}</DialogContent></Dialog></Section>;
}
function ProviderEditor({cellId,cellUuid,current,onDone}:{cellId:string;cellUuid:string;current:string;onDone:()=>void}){
  const action=useCellAction(cellId);
  const [kind,setKind]=useState(current),[bucket,setBucket]=useState(""),[region,setRegion]=useState(""),[access,setAccess]=useState(""),[secret,setSecret]=useState(""),[session,setSession]=useState("");
  async function save(){
    if(await action.run("/storage/provider","PUT",kind==="managed"?{kind}:{kind,bucket,region,access_key_id:access,secret_access_key:secret,session_token:session||null})){setAccess("");setSecret("");setSession("");onDone();}
  }
  return <form onSubmit={e=>{e.preventDefault();void save();}}><Stack><Failure error={action.error}/><Select label="Provider" value={kind} onValueChange={setKind} options={[{value:"managed",label:"Platform-managed storage"},{value:"s3",label:"My S3 bucket"}]}/>
    {kind==="s3"&&<><CopyField label="S3 prefix for this cell" value={`cells/${cellUuid}/`}/><Input label="S3 bucket" required value={bucket} onChange={e=>setBucket(e.target.value)}/><Input label="AWS region" required placeholder="ap-south-1" value={region} onChange={e=>setRegion(e.target.value)}/><Input label="Access key ID" required type="password" autoComplete="off" value={access} onChange={e=>setAccess(e.target.value)}/><Input label="Secret access key" required type="password" autoComplete="off" value={secret} onChange={e=>setSecret(e.target.value)}/><Input label="Session token (optional)" type="password" autoComplete="off" value={session} onChange={e=>setSession(e.target.value)}/><p className={styles.muted}>The credentials need read, write, multipart-upload, and delete access to this cell’s prefix. Stored credentials cannot be read back.</p></>}
    <Cluster><Button type="submit" loading={action.busy}>Connect storage</Button></Cluster>
  </Stack></form>;
}
