"use client";
import {useEffect,useRef,useState} from "react";
import {Section,Surface,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {SecretReveal} from "@/components/developer/parts/secret-reveal";
import {CopyField} from "@/components/developer/parts/copy-field";
import {cellsRequest} from "@/lib/cells/api";
import {downloadText} from "@/lib/cells/database-files";
import {cellPath,Failure,useCellAction,useCellData,useCellsLeaveGuard} from "./shared";
import styles from "./cells.module.css";
type Reference={base_url:string;tables:{name:string;columns:{name:string;type:string;nullable:boolean}[]}[];functions:{name:string;arguments:string;returns:string}[];authentication:Record<string,string>;examples:Record<string,string>};
type Extension={name:string;title:string;available_version:string|null;installed_version:string|null;schema:string|null;enabled:boolean};
export function DatabaseReference({cellId}:{cellId:string}){
 const [reference,setReference]=useState<Reference|null>(null),[error,setError]=useState<unknown>(null),[loading,setLoading]=useState(false);
 async function load(){setLoading(true);try{setError(null);setReference(await cellsRequest<Reference>(cellPath(cellId,"/database/reference")));}catch(error){setError(error);}finally{setLoading(false);}}
 return <Section title="API reference" description="Current tables and database functions on this cell’s REST API."><Stack><Failure error={error}/><Cluster><Button variant="secondary" loading={loading} onClick={()=>void load()}>Generate API reference</Button>{reference&&<><Button variant="secondary" onClick={()=>downloadText(`${cellId}-api.json`,JSON.stringify(reference,null,2),"application/json")}>Download API reference</Button><Button variant="ghost" onClick={()=>setReference(null)}>Clear API reference</Button></>}</Cluster>{reference&&<><CopyField label="REST API base URL" value={reference.base_url}/>{Object.entries(reference.authentication).map(([key,value])=><p key={key}>{value}</p>)}<Surface><Stack>{Object.entries(reference.examples).map(([key,value])=><CopyField key={key} label={key} value={value}/>)}</Stack></Surface>{reference.tables.map(table=><details key={table.name}><summary>{table.name} · /{encodeURIComponent(table.name)}</summary><pre className={styles.pre}>{JSON.stringify(table.columns,null,2)}</pre></details>)}{reference.functions.map((fn,index)=><details key={`${fn.name}-${index}`}><summary>POST /rpc/{encodeURIComponent(fn.name)}</summary><pre className={styles.pre}>{fn.arguments}{"\n→ "}{fn.returns}</pre></details>)}</>}</Stack></Section>;
}
export function DatabaseExtensions({cellId}:{cellId:string}){
 const query=useCellData<{extensions:Extension[]}>(cellId,"/database/extensions"),action=useCellAction(cellId);
 return <Section title="Extensions" description="Enable supported PostgreSQL features installed on this server."><Stack><Failure error={query.error??action.error}/>{query.data?.extensions.map(extension=><Surface key={extension.name}><Cluster justify="between"><Stack><strong>{extension.title}</strong><span>{extension.name} · {extension.enabled?`Installed ${extension.installed_version} in ${extension.schema}`:extension.available_version?`Available ${extension.available_version}`:"Server library unavailable"}</span></Stack><Button variant="secondary" disabled={extension.enabled||!extension.available_version||action.busy} onClick={()=>void action.run(`/database/extensions/${encodeURIComponent(extension.name)}`,"POST",{})}>{extension.enabled?"Enabled":"Enable extension"}</Button></Cluster></Surface>)}<p className={styles.muted}>Installed extensions are never upgraded automatically. Their types and functions are available in the displayed schema.</p></Stack></Section>;
}

type Connections={direct:{url:string;mode:string};pooled:{url:string;mode:string}|null};
type PasswordRotation={id:string;status:"rotating"|"succeeded";data_generation:number;created_at:string;completed_at:string|null;error_code:string|null};
type PasswordResult={rotation:PasswordRotation;database_password:string|null;credential_expires_at:string|null};
export function DatabaseConnections({cellId}:{cellId:string}){
 return <DatabaseConnectionsPanel key={cellId} cellId={cellId}/>;
}
function DatabaseConnectionsPanel({cellId}:{cellId:string}){
 const [connections,setConnections]=useState<Connections|null>(null),[error,setError]=useState<unknown>(null),[loading,setLoading]=useState(false);
 const [open,setOpen]=useState(false),[started,setStarted]=useState(false),[busy,setBusy]=useState(false),[rotationError,setRotationError]=useState<unknown>(null);
 const [rotation,setRotation]=useState<PasswordRotation|null>(null),[password,setPassword]=useState<string|null>(null);
 // Keep the retry key and credential outside general query/mutation caches. A 202 or lost reply must not start another rotation.
 const key=useRef<string|null>(null),request=useRef<AbortController|null>(null);
 useEffect(()=>()=>request.current?.abort(),[]);
 useCellsLeaveGuard(started,"Save the replacement database password before leaving. If you leave without saving it, you will need to replace it again.");
 async function load(){
  setLoading(true);
  try{setError(null);setConnections(await cellsRequest<Connections>(cellPath(cellId,"/database/connections")));}
  catch(error){setError(error);}finally{setLoading(false);}
 }
 async function replace(){
  if(request.current||rotation?.status==="succeeded")return;
  const controller=new AbortController();request.current=controller;
  key.current??=crypto.randomUUID();setStarted(true);setBusy(true);setRotationError(null);
  try{
   const result=await cellsRequest<PasswordResult>(cellPath(cellId,"/database/password/rotate"),{method:"POST",body:{},key:key.current,signal:controller.signal});
   if(!controller.signal.aborted){setRotation(result.rotation);setPassword(result.rotation.status==="succeeded"?result.database_password:null);}
  }catch(error){if(!controller.signal.aborted)setRotationError(error);}
  finally{request.current=null;if(!controller.signal.aborted)setBusy(false);}
 }
 function done(){setPassword(null);setRotation(null);setRotationError(null);key.current=null;setStarted(false);setOpen(false);}
 return <Section title="Database connections" description="Use the direct connection for PostgreSQL tools and transaction pooling for short server requests."><Stack>
  <Failure error={error}/><Cluster><Button variant="secondary" loading={loading} onClick={()=>void load()}>Show connection addresses</Button><Button variant="secondary" onClick={()=>setOpen(true)}>{started?"Continue password replacement":"Replace database password"}</Button></Cluster>
  {connections&&<><CopyField label="Direct connection (password omitted)" value={connections.direct.url}/>{connections.pooled?<CopyField label="Transaction pool (password omitted)" value={connections.pooled.url}/>:<p>Transaction pooling is currently unavailable for this cell.</p>}</>}
  <p className={styles.muted}>Transaction pooling does not preserve session-level state between transactions. Use the direct connection for migrations, LISTEN or tools that need a stable session.</p>
  <Dialog open={open} onOpenChange={next=>{if(!busy&&!password)setOpen(next);}}><DialogContent title={rotation?.status==="succeeded"?"Database password replaced":"Replace database password"} description="Existing direct and pooled database sessions will close. Update your integrations with the new password before reconnecting."><Stack>
   <Failure error={rotationError}/>
   {password?<SecretReveal title="New database password" description="Save this password privately and update your integrations. It gives owner access to this cell." secrets={[{label:"Database password",value:password}]} onDone={done} doneLabel="Done — I’ve saved the password"/>:rotation?.status==="succeeded"?<><p role="status">The password was replaced, but its display window has expired or it has since been replaced. Replace it again if you did not save the current password.</p><Button variant="secondary" onClick={done}>Done</Button></>:<>
    {started?<p role="status">{busy?"Replacing the database password…":rotationError?"The result could not be confirmed. Retry to continue the same replacement.":"Password replacement is still in progress. Check again to retrieve the new password when it is ready."}</p>:<p>The current password cannot be shown again. Confirming replaces it with a new password.</p>}
    <p>Keep this page open until you save the new password. You can retry here for up to 10 minutes after completion. Leaving this page loses that recovery option.</p>
    <Button loading={busy} onClick={()=>void replace()}>{!started?"Confirm password replacement":rotationError?"Retry password replacement":"Check password replacement"}</Button>
   </>}
  </Stack></DialogContent></Dialog>
 </Stack></Section>;
}
