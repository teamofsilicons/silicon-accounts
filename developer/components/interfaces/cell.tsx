"use client";
import Link from "next/link";
import {useRef,useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {Section,Surface,Stack} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {Select} from "@/components/silicon-ui/select/select";
import {CopyField} from "@/components/developer/parts/copy-field";
import {SecretReveal} from "@/components/developer/parts/secret-reveal";
import {useCellsLeaveGuard} from "@/components/cells/shared";
import {ApiError} from "@/lib/api/errors";
import {cellsApi,type Credentials} from "@/lib/cells/api";
import {paths} from "@/lib/navigation";

export function InterfaceCellSection({interfaceId,disabled=false,publicClient=true}:{interfaceId:string;disabled?:boolean;publicClient?:boolean}) {
  const cache=useQueryClient();
  const connection=useQuery({queryKey:["cells","interface",interfaceId],queryFn:({signal})=>cellsApi.interface(interfaceId,signal)});
  const list=useQuery({queryKey:["cells","list"],queryFn:({signal})=>cellsApi.list(signal)});
  const [choice,setChoice]=useState("new");const [credentials,setCredentials]=useState<Credentials|null>(null);
  const operation=useRef<{choice:string;key:string}|null>(null);
  const cell=connection.data?.cell;const selected=choice==="new" && cell ? cell.cell_id : choice;
  const enable=useMutation({mutationFn:async()=>{
    if(operation.current?.choice!==selected)operation.current={choice:selected,key:crypto.randomUUID()};
    const {credentials:privateValues,...result}=await cellsApi.enableInterface(interfaceId,selected==="new"?null:selected,operation.current.key);
    if(privateValues)setCredentials(privateValues);return result;
  },onSuccess:async result=>{cache.setQueryData(["cells","interface",interfaceId],result);await Promise.all([cache.invalidateQueries({queryKey:["cells","list"]}),cache.invalidateQueries({queryKey:["interface",interfaceId]})]);setChoice(result.cell?.cell_id??"new");operation.current=null;},meta:{toast:false}});
  useCellsLeaveGuard(!!credentials,"Save the cell credentials before leaving. They are shown only once.");
  const failure=enable.error??connection.error??list.error;
  const options=[...(!cell?[{value:"new",label:"Create a cell for this interface"}]:[]),...(list.data?.cells??[]).filter(item=>item.status==="active").map(item=>({value:item.cell_id,label:`${item.name} · ${item.cell_id}`}))];
  return <Section title="Sign in with a cell" description="Use a cell to finish interface sign-in and connect your frontend to its backend."><Surface><Stack>
    <Link href="/docs/interfaces#cell-sign-in">Read the Cell sign-in setup guide →</Link>
    {failure&&<Alert tone="danger" title={ApiError.from(failure).message}>{ApiError.from(failure).hint}</Alert>}
    {!publicClient&&<Alert tone="warning" title="Cell sign-in needs a public client">The Cell broker uses PKCE without an interface secret. Enable “Allow browser and native clients” and save if that fits your interface, or use your own confidential backend.</Alert>}
    {connection.isPending?<p role="status">Loading the interface’s cell…</p>:<><Select label="Cell" value={selected} options={options} onValueChange={setChoice} disabled={disabled||!publicClient||enable.isPending||list.isPending}/><Button loading={enable.isPending} disabled={disabled||!publicClient||!!connection.error||list.isPending||!!list.error} onClick={()=>enable.mutate()}>{cell?"Use selected cell":"Enable sign-in"}</Button>{disabled&&<p>Save your interface changes before connecting a cell.</p>}</>}
    {cell&&<><Link href={paths.cell(cell.cell_id)}>Open this cell →</Link><CopyField label="Cell URL" value={cell.url}/>{connection.data?.publishable_key&&<CopyField label="Publishable key" value={connection.data.publishable_key}/>} {(connection.data?.sign_in_links??[]).map(link=><CopyField key={link.redirect_to} label={`Sign-in link for ${link.redirect_to}`} value={link.sign_in}/>)}{!connection.data?.sign_in_links?.length&&<p>Save a frontend redirect URI above, then choose “Use selected cell” to create its sign-in link.</p>}</>}
    {credentials&&<SecretReveal title="Save these server credentials" description="Keep these on your server. Your frontend uses the publishable key." secrets={[{label:"Secret key",value:credentials.secret_key},{label:"Database connection",value:credentials.database_url}]} onDone={()=>setCredentials(null)} doneLabel="I’ve saved these credentials"/>}
  </Stack></Surface></Section>;
}
