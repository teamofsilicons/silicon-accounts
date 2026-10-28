"use client";
import {useState} from "react";
import {Section,Surface,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Textarea} from "@/components/silicon-ui/textarea/textarea";
import {Select} from "@/components/silicon-ui/select/select";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {CopyField} from "@/components/developer/parts/copy-field";
import {SecretReveal} from "@/components/developer/parts/secret-reveal";
import type {Cell} from "@/lib/cells/api";
import {useCellAction,useCellData,useCellsLeaveGuard,Failure,date} from "./shared";
import {StorageLocations} from "./storage-locations";
import {CellNotifications} from "./notifications";
import styles from "./cells.module.css";
interface Author {account:{uuid:string;id:string;display_name:string};joined_at:string}
interface Key {id:string;name:string;kind:string;prefix:string;publishable_key:string|null;revoked_at:string|null}
export function CellAuthors({cellId,active}:{cellId:string;active:boolean}){
  const query=useCellData<{authors:Author[]}>(cellId,"/authors"),invite=useCellAction(cellId),remove=useCellAction(cellId);
  const [target,setTarget]=useState(""),[sent,setSent]=useState(""),[selected,setSelected]=useState<Author|null>(null);
  return <Stack gap={8}><Section title="Authors" description="Authors share control of this cell."><Stack><Failure error={query.error}/>{query.isPending?<p role="status">Loading authors…</p>:query.data?.authors.map(a=><Surface key={a.account.uuid}><Cluster justify="between"><div><strong>{a.account.display_name}</strong><p className={styles.muted}>{a.account.id} · Joined {date(a.joined_at)}</p></div>{active&&<Button variant="ghost" onClick={()=>setSelected(a)}>Remove</Button>}</Cluster></Surface>)}</Stack></Section>
    {active&&<Section title="Invite an author"><form onSubmit={async e=>{e.preventDefault();if(await invite.run("/authors","POST",{target})){setSent(target);setTarget("");}}}><Stack><Failure error={invite.error}/><Input label="Carbon or Silicon ID, or email" required value={target} onChange={e=>setTarget(e.target.value)} placeholder="si:your-agent"/>{sent&&<p role="status">Invitation created for {sent}. They can accept it in Cells.</p>}<Button type="submit" loading={invite.busy}>Invite author</Button></Stack></form></Section>}
    <Dialog open={!!selected} onOpenChange={value=>{if(!value&&!remove.busy)setSelected(null);}}><DialogContent title="Remove author?" description={`${selected?.account.id??"This author"} will lose access to manage this cell.`}><Stack><Failure error={remove.error}/><Button variant="danger" loading={remove.busy} onClick={async()=>{if(selected&&await remove.run(`/authors/${selected.account.uuid}`,"DELETE"))setSelected(null);}}>Remove author</Button></Stack></DialogContent></Dialog>
  </Stack>;
}
export function CellHistory({cellId}:{cellId:string}){
  const query=useCellData<{history:{id:number;action:string;actor_uuid:string;occurred_at:string;details:unknown}[]}>(cellId,"/history");
  return <Stack gap={8}><CellNotifications cellId={cellId}/><Section title="History" description="The latest 200 changes to this cell."><Stack><Failure error={query.error}/>{query.isPending?<p role="status">Loading history…</p>:query.data?.history.map(item=><Surface key={item.id}><details><summary>{item.action} · {date(item.occurred_at)}</summary><p className={styles.muted}>Author: {item.actor_uuid}</p><pre className={styles.pre}>{JSON.stringify(item.details,null,2)}</pre></details></Surface>)}</Stack></Section></Stack>;
}
export function CellSettings({cell}:{cell:Cell}){
  return <Stack gap={8}>{cell.status==="active"&&<><OriginSettings key={JSON.stringify(cell.settings)} cell={cell}/><Keys cellId={cell.cell_id}/><Secrets cellId={cell.cell_id}/></>}{cell.status==="deleted"&&<StorageLocations cellId={cell.cell_id}/>}<Lifecycle cell={cell}/></Stack>;
}
function OriginSettings({cell}:{cell:Cell}){
  const action=useCellAction(cell.cell_id),[origins,setOrigins]=useState(cell.settings.allowed_origins.join("\n")),[redirects,setRedirects]=useState(cell.settings.redirect_urls.join("\n")),[saved,setSaved]=useState(false);
  const lines=(value:string)=>value.split("\n").map(s=>s.trim()).filter(Boolean);
  return <Section title="Web origins and sign-in"><form onSubmit={async e=>{e.preventDefault();if(await action.run("/settings","PUT",{allowed_origins:lines(origins),redirect_urls:lines(redirects)}))setSaved(true);}}><Stack><Failure error={action.error}/><Textarea label="Allowed web origins" value={origins} onChange={e=>{setOrigins(e.target.value);setSaved(false);}} description="One exact origin per line, such as https://my-app.example."/><Textarea label="Sign-in redirect URLs" value={redirects} onChange={e=>{setRedirects(e.target.value);setSaved(false);}} description="One complete callback URL per line. These must also be allowed by the linked app."/>{saved&&<p role="status">Settings saved.</p>}<Button type="submit" loading={action.busy}>Save settings</Button></Stack></form></Section>;
}
function Keys({cellId}:{cellId:string}){
  const query=useCellData<{keys:Key[]}>(cellId,"/keys"),create=useCellAction(cellId),revoke=useCellAction(cellId);
  const [name,setName]=useState(""),[kind,setKind]=useState("publishable"),[value,setValue]=useState<string|null>(null),[selected,setSelected]=useState<Key|null>(null);
  useCellsLeaveGuard(create.busy||value!==null,"Save the new API key before leaving. Secret keys are shown only once.");
  return <Section title="API keys" description="Publishable keys belong in frontends. Secret keys bypass access rules and belong only on servers."><Stack><Failure error={query.error}/>{query.data?.keys.map(key=><Surface key={key.id}><Stack><Cluster justify="between"><div><strong>{key.name}</strong><p className={styles.muted}>{key.kind} · {key.prefix}…{key.revoked_at?" · Revoked":""}</p></div>{!key.revoked_at&&<Button variant="ghost" onClick={()=>setSelected(key)}>Revoke</Button>}</Cluster>{key.publishable_key&&!key.revoked_at&&<CopyField label="Publishable key" value={key.publishable_key}/>}</Stack></Surface>)}
    {value?<SecretReveal title="New API key" description="Save this key before continuing." secrets={[{label:"API key",value}]} onDone={()=>setValue(null)}/>:<form onSubmit={async e=>{e.preventDefault();const result=await create.run<{value:string}>("/keys","POST",{name,kind});if(result){setValue(result.value);setName("");}}}><Stack><Failure error={create.error}/><Input label="Key name" required value={name} onChange={e=>setName(e.target.value)}/><Select label="Kind" value={kind} onValueChange={setKind} options={[{value:"publishable",label:"Publishable"},{value:"secret",label:"Secret"}]}/><Button type="submit" loading={create.busy}>Create key</Button></Stack></form>}
  </Stack><Dialog open={!!selected} onOpenChange={v=>{if(!v&&!revoke.busy)setSelected(null);}}><DialogContent title="Revoke API key?" description={`Requests using ${selected?.name??"this key"} will stop working immediately.`}><Stack><Failure error={revoke.error}/><Button variant="danger" loading={revoke.busy} onClick={async()=>{if(selected&&await revoke.run(`/keys/${selected.id}`,"DELETE"))setSelected(null);}}>Revoke key</Button></Stack></DialogContent></Dialog></Section>;
}
function Secrets({cellId}:{cellId:string}){
  const query=useCellData<{secrets:{name:string;version:number;updated_at:string}[]}>(cellId,"/secrets"),save=useCellAction(cellId),remove=useCellAction(cellId);
  const [name,setName]=useState(""),[value,setValue]=useState(""),[selected,setSelected]=useState<string|null>(null),[saved,setSaved]=useState(false);
  return <Section title="Secrets" description="Values are encrypted and cannot be read back."><Stack><Failure error={query.error}/>{query.data?.secrets.map(s=><Surface key={s.name}><Cluster justify="between"><div><strong>{s.name}</strong><p className={styles.muted}>Version {s.version} · {date(s.updated_at)}</p></div><Button variant="ghost" onClick={()=>setSelected(s.name)}>Delete</Button></Cluster></Surface>)}
    <form onSubmit={async e=>{e.preventDefault();if(await save.run(`/secrets/${encodeURIComponent(name)}`,"PUT",{value})){setName("");setValue("");setSaved(true);}}}><Stack><Failure error={save.error}/><Input label="Secret name" required pattern="[A-Za-z_][A-Za-z0-9_]*" value={name} onChange={e=>{setName(e.target.value);setSaved(false);}}/><Input label="Value" required type="password" autoComplete="off" value={value} onChange={e=>{setValue(e.target.value);setSaved(false);}}/>{saved&&<p role="status">Secret saved.</p>}<Button type="submit" loading={save.busy}>Save secret</Button></Stack></form>
  </Stack><Dialog open={!!selected} onOpenChange={v=>{if(!v&&!remove.busy)setSelected(null);}}><DialogContent title="Delete secret?" description={`${selected??"This secret"} will no longer be available to this cell.`}><Stack><Failure error={remove.error}/><Button variant="danger" loading={remove.busy} onClick={async()=>{if(selected&&await remove.run(`/secrets/${encodeURIComponent(selected)}`,"DELETE"))setSelected(null);}}>Delete secret</Button></Stack></DialogContent></Dialog></Section>;
}
function Lifecycle({cell}:{cell:Cell}){
  const action=useCellAction(cell.cell_id),[confirm,setConfirm]=useState("");
  return <Section title={cell.status==="deleted"?"Restore cell":"Delete cell"} description={cell.status==="deleted"?"Restore within 30 days to resume the cell with its data and settings.":"Deletion stops this backend immediately. You can restore it within 30 days; its ID stays reserved permanently."}><Stack><Failure error={action.error}/>{cell.status==="deleted"?<Button loading={action.busy} onClick={()=>void action.run("/restore","POST")}>Restore cell</Button>:cell.status==="active"?<><Input label={`Type ${cell.cell_id} to confirm deletion`} value={confirm} onChange={e=>setConfirm(e.target.value)}/><Button variant="danger" disabled={confirm!==cell.cell_id} loading={action.busy} onClick={()=>void action.run("","DELETE",{cell_id:confirm})}>Delete cell</Button></>:<p>This cell is {cell.status}.</p>}</Stack></Section>;
}
