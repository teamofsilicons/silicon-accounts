"use client";
import {useState} from "react";
import Link from "next/link";
import {Section,Surface,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Checkbox} from "@/components/silicon-ui/checkbox/checkbox";
import {Input} from "@/components/silicon-ui/input/input";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {SecretReveal} from "@/components/developer/parts/secret-reveal";
import {CopyField} from "@/components/developer/parts/copy-field";
import {paths} from "@/lib/navigation";
import type {Cell,CreatedCell} from "@/lib/cells/api";
import {useCellData,useCellAction,useCellsLeaveGuard,Failure,date} from "./shared";
import styles from "./cells.module.css";

type Copy={parent_uuid:string;parent_cell_id:string;copy:string;cell:Cell;background_paused:boolean;last_operation:string|null;prerequisites:string[];created_at:string;updated_at:string};
type Operation={id:string;status:string;error_code:string|null};
type Selected={kind:"reset"|"delete"|"resume";copy:Copy};
function prerequisite(value:string){return value==="storage_provider_required"?"Connect storage before uploading files.":value==="apps_require_explicit_link"?"Link apps explicitly before using sign-in.":value.startsWith("app_link:")?`Link ${value.slice(9)} explicitly before using its sign-in.`:value;}

export function CellCopies({cell}:{cell:Cell}){
  return cell.cell_id.includes("--")?<CopyInfo cell={cell}/>:<ParentCopies cell={cell}/>;
}
function CopyInfo({cell}:{cell:Cell}){
  const query=useCellData<{copy:Copy}>(cell.cell_id,"/copy"),action=useCellAction(cell.cell_id);
  const [resuming,setResuming]=useState(false),[notice,setNotice]=useState("");
  const copy=query.data?.copy;
  async function background(paused:boolean){
    const result=await action.run("/copy","PATCH",{background_paused:paused});
    if(result){setResuming(false);setNotice(paused?"Background work paused for this copy.":"Background work resumed for this copy.");}
  }
  return <Section title="Test copy" description="This cell has independent data, keys and authors."><Surface><Stack>
    <Failure error={query.error??(!resuming?action.error:null)}/>{notice&&<Alert tone="info" title={notice}/>}
    <p>Current copy authors can pause or resume background work independently, even after the parent is removed. Reset requires current authorship in both cells.</p>
    {copy&&<><p>Parent: <Link href={paths.cell(copy.parent_cell_id,"copies")}>{copy.parent_cell_id}</Link>. Background work is {copy.background_paused?"paused":"enabled"}.</p><Cluster>{copy.background_paused?<Button disabled={action.busy||cell.status!=="active"} onClick={()=>setResuming(true)}>Resume background work</Button>:<Button disabled={action.busy||cell.status!=="active"} onClick={()=>void background(true)}>Pause background work</Button>}<Button variant="secondary" disabled={query.isFetching} onClick={()=>void query.refetch()}>Refresh copy</Button></Cluster>{copy.prerequisites.map(value=><p key={value}>{prerequisite(value)}</p>)}<Link href={paths.cell(copy.parent_cell_id,"copies")}>Reset from the parent</Link></>}
    <p>Paused copies retain queued work and schedule cursors. Resume may process that backlog. Interactive functions, author SQL and manual job runs remain available; persistent services require Resume.</p>
    <Link href={paths.cell(cell.cell_id,"backups")}>Copy backups and recovery history</Link><p className={styles.muted}>Use ordinary migrations to review structure changes before applying them to the parent. Data never moves between cells automatically.</p>
    <Dialog open={resuming} onOpenChange={open=>{if(!action.busy)setResuming(open);}}><DialogContent title="Resume background work?" description="Retained jobs, queues, event deliveries and services may contact external destinations using copied settings and secrets. Review them before resuming."><Stack><Failure error={action.error}/><Button loading={action.busy} onClick={()=>void background(false)}>Confirm background resume</Button></Stack></DialogContent></Dialog>
  </Stack></Surface></Section>;
}
function ParentCopies({cell}:{cell:Cell}){
  const [includeDeleted,setIncludeDeleted]=useState(false),[creating,setCreating]=useState(false),[slug,setSlug]=useState(""),[name,setName]=useState("");
  const [selected,setSelected]=useState<Selected|null>(null),[confirm,setConfirm]=useState(""),[validation,setValidation]=useState("");
  const [created,setCreated]=useState<CreatedCell|null>(null),[notice,setNotice]=useState("");
  const query=useCellData<{copies:Copy[]}>(cell.cell_id,`/copies?include_deleted=${includeDeleted}`),action=useCellAction(cell.cell_id);
  useCellsLeaveGuard(action.busy||created!==null,"Save the new copy credentials before leaving. They are shown only once.");
  const active=cell.status==="active";
  function choose(kind:Selected["kind"],copy:Copy){setSelected({kind,copy});setConfirm("");setValidation("");}
  async function create(){
    setValidation("");
    if(!/^[a-z](?:[a-z0-9-]{0,28}[a-z0-9])?$/u.test(slug)||slug.includes("--")){setValidation("Use a copy name of 1–30 lowercase letters, digits or hyphens, without consecutive hyphens.");return;}
    const result=await action.run<{copy:Copy;operation:Operation;created_cell:CreatedCell}>("/copies","POST",{copy:slug,name:name.trim()||null});
    if(result){setCreated(result.created_cell);setNotice(`Copy requested. Operation ${result.operation.id}. Background work starts paused.`);}
  }
  async function mutate(){
    if(!selected)return;setValidation("");
    if(selected.kind!=="resume"&&confirm!==selected.copy.cell.cell_id){setValidation("Type the exact test-copy cell ID to confirm.");return;}
    const tail=`/copies/${encodeURIComponent(selected.copy.copy)}`;
    const result=await action.run<{copy:Copy;operation?:Operation}>(selected.kind==="reset"?`${tail}/reset`:tail,selected.kind==="reset"?"POST":selected.kind==="delete"?"DELETE":"PATCH",selected.kind==="resume"?{background_paused:false}:{confirm_cell_id:confirm});
    if(result){setNotice(selected.kind==="reset"?`Reset requested. Operation ${result.operation?.id}. Follow recovery in Backups.`:selected.kind==="delete"?"Copy deleted. Its address remains reserved.":"Background work resumed for this copy.");setSelected(null);}
  }
  return <Stack gap={8}><Failure error={query.error??(!creating&&!selected?action.error:null)}/>{notice&&<Alert tone="info" title={notice}/>}
    <Section title="Test copies" description="Try changes with the same setup and independent application data, keys and domain."><Surface><Stack>
      <p>Copies start with empty application data and paused background work. Tables, rules, editable source, buckets, jobs, settings and ordinary cell secrets are copied. Apps need explicit linking; storage uses a separate managed namespace or needs a provider.</p>
      <p className={styles.muted}>Current authors are copied initially and managed independently afterward. Removing an author from the parent does not remove them from its copies.</p>
      <Cluster><Button disabled={!active||action.busy} onClick={()=>{setCreating(true);setValidation("");}}>Create test copy</Button><Button variant="secondary" disabled={query.isFetching} onClick={()=>void query.refetch()}>Refresh copies</Button><Checkbox label="Show deleted copies" checked={includeDeleted} onCheckedChange={value=>setIncludeDeleted(value===true)}/></Cluster>
    </Stack></Surface>
    {query.isPending?<p role="status">Loading copies…</p>:<div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Copy</th><th>Status</th><th>Setup</th><th>Actions</th></tr></thead><tbody>{query.data?.copies.map(copy=><tr key={copy.cell.uuid}><td><Link href={paths.cell(copy.cell.cell_id)}>{copy.cell.name}</Link><div><code>{copy.cell.cell_id}</code></div><div>{date(copy.created_at)}</div></td><td>{copy.cell.status}<div>Background {copy.background_paused?"paused":"enabled"}</div>{copy.last_operation&&<Link href={paths.cell(copy.cell.cell_id,"backups")}>Recovery status</Link>}</td><td>{copy.prerequisites.map(value=><p key={value}>{prerequisite(value)}</p>)}</td><td><div className={styles.actions}>{copy.cell.status==="active"&&<><Button size="sm" variant="secondary" disabled={action.busy||!active} onClick={()=>choose("reset",copy)}>Reset copy</Button>{copy.background_paused?<Button size="sm" variant="secondary" disabled={action.busy} onClick={()=>choose("resume",copy)}>Resume background work</Button>:<Button size="sm" variant="secondary" disabled={action.busy} onClick={async()=>{const result=await action.run(`/copies/${encodeURIComponent(copy.copy)}`,"PATCH",{background_paused:true});if(result)setNotice("Background work paused for this copy.");}}>Pause background work</Button>}</>}{["active","failed"].includes(copy.cell.status)&&<Button size="sm" variant="secondary" disabled={action.busy} onClick={()=>choose("delete",copy)}>Delete copy</Button>}</div></td></tr>)}</tbody></table>{!query.data?.copies.length&&<p>No copies to show.</p>}</div>}
    <p className={styles.muted}>Review migrations in the copy before applying them to its parent. Reset saves an undo backup, replaces setup and empties data, while keeping the copy’s credentials and current authors.</p></Section>
    <Dialog open={creating} onOpenChange={open=>{if(!action.busy&&!created)setCreating(open);}}><DialogContent title={created?"Save the copy credentials":"Create test copy"} description={created?"The copy is being prepared. Save these credentials privately and check its recovery status.":"The new copy receives the current setup, empty application data and independent credentials."}>
      {created?<Stack><CopyField label="Copy URL" value={created.cell.url}/><CopyField label="Publishable key" value={created.publishable_key}/><SecretReveal title="Copy server credentials" description="These credentials stay in this dialog until you dismiss it." secrets={[{label:"Secret key",value:created.secret_key},{label:"Database connection",value:created.database_url},{label:"Database password",value:created.database_password}]} onDone={()=>{setCreated(null);setCreating(false);}} doneLabel="I’ve saved these credentials"/></Stack>:<form onSubmit={event=>{event.preventDefault();void create();}}><Stack><Failure error={action.error}/>{validation&&<Alert tone="danger" title={validation}/>}<Input label="Copy name" required maxLength={30} value={slug} disabled={action.busy} onChange={event=>setSlug(event.target.value)} description={`Address: ${cell.cell_id}--${slug||"copy"}`}/><Input label="Display name (optional)" maxLength={100} value={name} disabled={action.busy} onChange={event=>setName(event.target.value)}/><Button type="submit" loading={action.busy}>Create copy</Button></Stack></form>}
    </DialogContent></Dialog>
    <Dialog open={selected!==null} onOpenChange={open=>{if(!open&&!action.busy)setSelected(null);}}><DialogContent title={selected?.kind==="reset"?"Reset this copy?":selected?.kind==="delete"?"Delete this copy?":"Resume background work?"} description={selected?.kind==="reset"?"A fresh undo backup is saved first. The copy receives the parent's current setup and empty application data; its keys and current authors stay the same.":selected?.kind==="delete"?"The copy stops and enters the ordinary 30-day deletion period. Only its admin author can delete it.":"Retained jobs, queues, event deliveries and services may contact external destinations using copied settings and secrets. Review them before resuming."}><form onSubmit={event=>{event.preventDefault();void mutate();}}><Stack><Failure error={action.error}/>{validation&&<Alert tone="danger" title={validation}/>}<p>{selected?.copy.cell.cell_id}</p>{selected?.kind!=="resume"&&<Input label="Confirm test-copy cell ID" required value={confirm} disabled={action.busy} onChange={event=>setConfirm(event.target.value)}/>}<Button type="submit" loading={action.busy}>{selected?.kind==="reset"?"Confirm copy reset":selected?.kind==="delete"?"Confirm copy deletion":"Confirm background resume"}</Button></Stack></form></DialogContent></Dialog>
  </Stack>;
}
