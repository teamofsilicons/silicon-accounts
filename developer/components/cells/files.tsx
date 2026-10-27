"use client";
import {useEffect,useRef,useState} from "react";
import {useInfiniteQuery,useQueryClient} from "@tanstack/react-query";
import {Section,Surface,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Select} from "@/components/silicon-ui/select/select";
import {Checkbox} from "@/components/silicon-ui/checkbox/checkbox";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {CopyField} from "@/components/developer/parts/copy-field";
import {cellsRequest,type Cell} from "@/lib/cells/api";
import {resumeAuthorUpload,type UploadStatus} from "@/lib/cells/uploads";
import {useNavigationGuard} from "@/lib/navigation-guard";
import {cellPath,useCellData,useCellAction,Failure,bytes,date} from "./shared";
import {BucketEditor,StorageProvider,type Bucket} from "./storage-settings";
import styles from "./cells.module.css";
interface StoredFile {id:string;bucket:string;name:string;size:number;content_type:string;updated_at:string}
interface PendingUpload {id:string;bucket:string;name:string;size:number;status:string;expires_at:string}
type FileAction={file:StoredFile;action:"copy"|"move"|"delete"|"sign"};
export function CellFiles({cell}:{cell:Cell}){
  const id=cell.cell_id,buckets=useCellData<{buckets:Bucket[]}>(id,"/storage/buckets");
  const [chosen,setChosen]=useState(""),[prefix,setPrefix]=useState("");
  const bucket=buckets.data?.buckets.find(b=>b.id===chosen)??buckets.data?.buckets[0];
  const [edit,setEdit]=useState<Bucket|"new"|null>(null),[upload,setUpload]=useState<"new"|PendingUpload|null>(null),[action,setAction]=useState<FileAction|null>(null);
  return <Stack gap={8}>
    <Section title="Files" description="Organize files into buckets and decide who can access them." actions={<Button variant="secondary" onClick={()=>setEdit("new")}>Create bucket</Button>}>
      <Failure error={buckets.error}/>{buckets.isPending&&<p role="status">Loading buckets…</p>}
      {bucket?<Stack><Cluster><Select label="Bucket" value={bucket.id} options={buckets.data!.buckets.map(b=>({label:b.id,value:b.id}))} onValueChange={value=>{setChosen(value);setPrefix("");}}/>
        <Button variant="secondary" onClick={()=>setEdit(bucket)}>Bucket settings</Button><Button onClick={()=>setUpload("new")}>Upload file</Button></Cluster>
        <Input label="Filter by path" value={prefix} onChange={e=>setPrefix(e.target.value)} placeholder="photos/"/>
        <FileList key={bucket.id} cellId={id} bucket={bucket.id} prefix={prefix} onAction={setAction}/>
      </Stack>:!buckets.isPending&&!buckets.error&&<Surface><p>Create a bucket to start storing files.</p></Surface>}
    </Section>
    <PendingUploads cellId={id} onResume={setUpload}/>
    <StorageProvider cellId={id} cellUuid={cell.uuid}/>
    <Dialog open={edit!==null} onOpenChange={value=>{if(!value)setEdit(null);}}><DialogContent title={edit==="new"?"Create bucket":"Bucket settings"} description="Bucket limits apply when new files are uploaded.">{edit&&<BucketEditor key={typeof edit==="string"?"new":edit.id} cellId={id} bucket={edit==="new"?undefined:edit} onDone={()=>setEdit(null)}/>}</DialogContent></Dialog>
    <Dialog open={upload!==null} onOpenChange={value=>{if(!value)setUpload(null);}}><DialogContent title={upload==="new"?"Upload file":"Resume upload"} description="Uploaded parts are kept for seven days. You can return with the same file to continue.">{upload&&bucket&&<UploadEditor key={typeof upload==="string"?"new":upload.id} cellId={id} bucket={bucket.id} pending={upload==="new"?undefined:upload} onDone={()=>setUpload(null)}/>}</DialogContent></Dialog>
    <Dialog open={action!==null} onOpenChange={value=>{if(!value)setAction(null);}}><DialogContent title={action?`${action.action[0].toUpperCase()+action.action.slice(1)} file`:"File"} description={action?.file.name??""}>{action&&<FileEditor key={`${action.action}:${action.file.id}`} cellId={id} target={action} onDone={()=>setAction(null)}/>}</DialogContent></Dialog>
  </Stack>;
}
function FileList({cellId,bucket,prefix,onAction}:{cellId:string;bucket:string;prefix:string;onAction:(value:FileAction)=>void}){
  const files=useInfiniteQuery({queryKey:["cells",cellId,"files",bucket,prefix],initialPageParam:"",queryFn:({signal,pageParam})=>{
    const params=new URLSearchParams({prefix,limit:"100"});if(pageParam)params.set("after",pageParam);
    return cellsRequest<{files:StoredFile[];next:string|null}>(cellPath(cellId,`/storage-api/files/${encodeURIComponent(bucket)}?${params}`),{signal});
  },getNextPageParam:page=>page.next??undefined});
  const rows=files.data?.pages.flatMap(p=>p.files)??[];
  return <Stack><Failure error={files.error}/>{files.isPending?<p role="status">Loading files…</p>:!rows.length?<p>No files match this path.</p>:<div className={styles.tableWrap}><table className={styles.table}><caption className="sr-only">Files in {bucket}</caption><thead><tr><th>Name</th><th>Size</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{rows.map(file=><tr key={file.id}><td>{file.name}<p className={styles.muted}>{file.content_type}</p></td><td>{bytes(file.size)}</td><td>{date(file.updated_at)}</td><td><div className={styles.actions}>
    <a href={`/api/cells${cellPath(cellId,`/storage-api/object/${encodeURIComponent(bucket)}/${file.name.split("/").map(encodeURIComponent).join("/")}`)}`} download={file.name.split("/").at(-1)}>Download</a>
    {(["copy","move","sign","delete"] as const).map(action=><Button key={action} variant="ghost" size="sm" onClick={()=>onAction({file,action})}>{action==="sign"?"Share link":action[0].toUpperCase()+action.slice(1)}</Button>)}
  </div></td></tr>)}</tbody></table></div>}{files.hasNextPage&&<Button variant="secondary" loading={files.isFetchingNextPage} onClick={()=>void files.fetchNextPage()}>Load more files</Button>}</Stack>;
}
function UploadEditor({cellId,bucket,pending,onDone}:{cellId:string;bucket:string;pending?:PendingUpload;onDone:()=>void}){
  const cache=useQueryClient(),begin=useCellAction(cellId),controller=useRef<AbortController|null>(null);
  const [file,setFile]=useState<File|null>(null),[name,setName]=useState(pending?.name??""),[replace,setReplace]=useState(false);
  const [uploadId,setUploadId]=useState(pending?.id),[busy,setBusy]=useState(false),[failure,setFailure]=useState<unknown>(null),[sent,setSent]=useState(0);
  useEffect(()=>()=>controller.current?.abort(),[]);
  useNavigationGuard(busy?{question:{title:"Pause this upload?",description:"Uploaded parts will be kept. Return with the same file to resume."}}:null);
  useEffect(()=>{if(!busy)return;const warn=(event:BeforeUnloadEvent)=>event.preventDefault();window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[busy]);
  async function send(){
    if(!file||controller.current)return;
    const control=new AbortController();controller.current=control;setBusy(true);setFailure(null);
    try{
      let current=uploadId;
      if(!current){const created=await begin.run<{id:string}>("/storage-api/uploads","POST",{bucket,name,size:file.size,content_type:file.type||"application/octet-stream",replace});if(!created)return;current=created.id;setUploadId(current);}
      control.signal.throwIfAborted();
      await resumeAuthorUpload(cellId,current,file,control.signal,setSent);
      void cache.invalidateQueries({queryKey:["cells",cellId]});onDone();
    }catch(error){if(control.signal.aborted)setFailure({code:"upload_paused",message:"Upload paused.",hint:"Keep the same file selected and choose Resume upload."});else setFailure(error);}
    finally{controller.current=null;setBusy(false);void cache.invalidateQueries({queryKey:["cells",cellId]});}
  }
  return <form onSubmit={e=>{e.preventDefault();void send();}}><Stack><Failure error={failure??begin.error}/>
    <Input label="File" type="file" required disabled={busy} onChange={e=>{const selected=e.target.files?.[0]??null;setFile(selected);if(selected&&!uploadId)setName(selected.name);}}/>
    <Input label="File path" value={name} disabled={busy||!!uploadId} required onChange={e=>setName(e.target.value)}/>
    {!uploadId&&<Checkbox label="Replace an existing file at this path" checked={replace} disabled={busy} onCheckedChange={value=>setReplace(value===true)}/>}
    <p className={styles.muted}>{pending?.bucket??bucket}{file?` · ${bytes(file.size)}`:""}</p>
    {(busy||sent>0)&&<><progress className={styles.progress} aria-label="Upload progress" max={file?.size||1} value={sent}/><p role="status">{bytes(sent)} uploaded{file&&sent===file.size?" · Verifying file…":""}</p></>}
    <Cluster><Button type="submit" loading={busy} disabled={!file}>{uploadId?"Resume upload":"Upload"}</Button>{busy&&<Button type="button" variant="secondary" onClick={()=>controller.current?.abort()}>Pause</Button>}</Cluster>
  </Stack></form>;
}
function PendingUploads({cellId,onResume}:{cellId:string;onResume:(value:PendingUpload)=>void}){
  const query=useCellData<{uploads:PendingUpload[]}>(cellId,"/storage-api/uploads"),action=useCellAction(cellId);
  const [cancel,setCancel]=useState<PendingUpload|null>(null),[failure,setFailure]=useState<unknown>(null);
  async function resume(upload:PendingUpload){try{setFailure(null);const status=await cellsRequest<UploadStatus>(cellPath(cellId,`/storage-api/uploads/${upload.id}`));if(!status.can_resume)throw new Error("Only the author who started this upload can resume it. Any author can cancel it.");onResume(upload);}catch(error){setFailure(error);}}
  return <Section title="Unfinished uploads" description="Up to 100 oldest uploads awaiting completion. Cancel unused uploads before changing storage providers."><Stack><Failure error={query.error??failure}/>{query.isPending?<p role="status">Loading uploads…</p>:query.data?.uploads.length?<div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>File</th><th>Size</th><th>Expires</th><th>Actions</th></tr></thead><tbody>{query.data.uploads.map(u=><tr key={u.id}><td>{u.bucket}/{u.name}</td><td>{bytes(u.size)}</td><td>{date(u.expires_at)}</td><td><Cluster><Button variant="ghost" size="sm" onClick={()=>void resume(u)}>Resume</Button><Button variant="ghost" size="sm" onClick={()=>setCancel(u)}>Cancel</Button></Cluster></td></tr>)}</tbody></table></div>:!query.error&&<p>No unfinished uploads.</p>}</Stack>
    <Dialog open={cancel!==null} onOpenChange={value=>{if(!value&&!action.busy)setCancel(null);}}><DialogContent title="Cancel upload?" description={`Discard uploaded parts for ${cancel?.name??"this file"}. An existing published file will remain available.`}><Stack><Failure error={action.error}/><Button variant="danger" loading={action.busy} onClick={async()=>{if(cancel&&await action.run(`/storage-api/uploads/${cancel.id}`,"DELETE"))setCancel(null);}}>Cancel upload</Button></Stack></DialogContent></Dialog>
  </Section>;
}
function FileEditor({cellId,target,onDone}:{cellId:string;target:FileAction;onDone:()=>void}){
  const action=useCellAction(cellId),[bucket,setBucket]=useState(target.file.bucket),[name,setName]=useState(target.file.name),[expiry,setExpiry]=useState("3600"),[link,setLink]=useState<string|null>(null);
  async function submit(){
    const base={bucket:target.file.bucket,name:target.file.name};
    if(target.action==="sign"){
      const result=await action.run<{url:string}>("/storage-api/sign","POST",{...base,expires_in:Number(expiry)});if(result)setLink(result.url);
    }else if(await action.run("/storage-api/files","POST",{...base,action:target.action,...(target.action==="delete"?{}:{to_bucket:bucket,to_name:name})}))onDone();
  }
  return <form onSubmit={e=>{e.preventDefault();void submit();}}><Stack><Failure error={action.error}/>
    {target.action==="delete"?<p>This removes the file from listings and invalidates its download links.</p>:target.action==="sign"?<><Input label="Expires in seconds" type="number" min={1} max={604800} required value={expiry} onChange={e=>setExpiry(e.target.value)}/><p>Anyone with this link can download this version until it expires or access is revoked.</p>{link&&<CopyField label="Download link" value={link}/>}</>:<><Input label="Destination bucket" required value={bucket} onChange={e=>setBucket(e.target.value)}/><Input label="Destination path" required value={name} onChange={e=>setName(e.target.value)}/></>}
    <Button type="submit" variant={target.action==="delete"?"danger":"primary"} loading={action.busy}>{target.action==="sign"?"Create link":`${target.action[0].toUpperCase()+target.action.slice(1)} file`}</Button>
  </Stack></form>;
}
