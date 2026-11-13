"use client";
import {useState} from "react";
import {useInfiniteQuery} from "@tanstack/react-query";
import {Section,Stack} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {cellsRequest} from "@/lib/cells/api";
import {cellPath,useCellAction,Failure,bytes,date} from "./shared";
import styles from "./cells.module.css";
interface DeletedFile {id:string;bucket:string;name:string;size:number;deleted_at:string;expires_at:string}
export function FileTrash({cellId,bucket}:{cellId:string;bucket:string}){
  const query=useInfiniteQuery({queryKey:["cells",cellId,"trash",bucket],initialPageParam:"",queryFn:({signal,pageParam})=>{
    const params=new URLSearchParams({limit:"100"});if(pageParam)params.set("after",pageParam);
    return cellsRequest<{files:DeletedFile[];next:string|null}>(cellPath(cellId,`/storage-api/trash/${encodeURIComponent(bucket)}?${params}`),{signal});
  },getNextPageParam:page=>page.next??undefined});
  const [selected,setSelected]=useState<DeletedFile|null>(null),rows=query.data?.pages.flatMap(page=>page.files)??[];
  return <Section title="Trash" description={`Deleted files in ${bucket} can be restored for 30 days.`}><Stack><Failure error={query.error}/>{query.isPending?<p role="status">Loading trash…</p>:rows.length?<div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>File</th><th>Size</th><th>Recover before</th><th>Action</th></tr></thead><tbody>{rows.map(file=><tr key={file.id}><td>{file.name}<p className={styles.muted}>Deleted {date(file.deleted_at)}</p></td><td>{bytes(file.size)}</td><td>{date(file.expires_at)}</td><td><Button variant="secondary" size="sm" onClick={()=>setSelected(file)}>Restore</Button></td></tr>)}</tbody></table></div>:!query.error&&<p>No recoverable files in this bucket.</p>}{query.hasNextPage&&<Button variant="secondary" loading={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>Load more deleted files</Button>}</Stack>
    <Dialog open={selected!==null} onOpenChange={value=>{if(!value)setSelected(null);}}><DialogContent title="Restore file" description="Choose a vacant path. Restoring never replaces an existing file, and old signed links stay invalid.">{selected&&<RestoreFile key={selected.id} cellId={cellId} file={selected} onDone={()=>setSelected(null)}/>}</DialogContent></Dialog>
  </Section>;
}
function RestoreFile({cellId,file,onDone}:{cellId:string;file:DeletedFile;onDone:()=>void}){
  const action=useCellAction(cellId),[bucket,setBucket]=useState(file.bucket),[name,setName]=useState(file.name);
  return <form onSubmit={async event=>{event.preventDefault();if(await action.run(`/storage-api/trash/${file.id}/restore`,"POST",{bucket,name}))onDone();}}><Stack><Failure error={action.error}/><Input label="Bucket" required value={bucket} onChange={e=>setBucket(e.target.value)}/><Input label="File path" required value={name} onChange={e=>setName(e.target.value)}/><Button type="submit" loading={action.busy}>Restore file</Button></Stack></form>;
}
