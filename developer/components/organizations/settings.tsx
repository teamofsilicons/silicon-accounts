"use client";
import {useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {Page,PageHeader,Surface,Stack} from "@/components/foundation/layout/layout";
import {Select} from "@/components/silicon-ui/select/select";
import {Button} from "@/components/silicon-ui/button/button";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {GrantsEditor} from "./policy-editor";
import {organizationApi,type Policy,type Directory,useOrganizations} from "./api";

function Editor({org,policy,directory}:{org:string;policy:Policy;directory:Directory}) {
  const cache=useQueryClient(),[draft,setDraft]=useState(policy),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState(false);
  return <Stack><GrantsEditor value={draft.grants} onChange={grants=>{setSaved(false);setDraft({grants});}} directory={directory}/>{error&&<Alert tone="danger" title={error}/>} {saved&&<p role="status">Publishing permissions saved.</p>}<Button disabled={busy||draft.grants.some(g=>!g.permissions.length)} onClick={async()=>{setBusy(true);setError(null);try{await organizationApi(`orgs/${org}/actions`,{action:"publishing_policy_update",publishing_policy:draft});setSaved(true);void cache.invalidateQueries({queryKey:["organizations","publishing"]});}catch(error){setError(error instanceof Error?error.message:"Permissions could not be saved.");}finally{setBusy(false);}}}>Save publishing permissions</Button></Stack>;
}
function OrganizationSettings({org}:{org:string}) {
  const query=useQuery({queryKey:["organizations",org,"settings"],queryFn:async()=>{const [policy,directory]=await Promise.all([organizationApi<{publishing_policy:Policy}>(`orgs/${org}/publishing-policy`),organizationApi<Directory>(`orgs/${org}`)]);return {policy:policy.publishing_policy,directory};}});
  if(query.isPending)return <p role="status">Loading publishing settings…</p>;
  if(!query.data)return <Alert tone="danger" title="Publishing settings could not be loaded"><button type="button" onClick={()=>void query.refetch()}>Retry</button></Alert>;
  return <Editor org={org} {...query.data}/>;
}
export function OrganizationsSettings() {
  const query=useOrganizations(),[selected,setSelected]=useState("");
  const manageable=query.data?.organizations.filter(org=>org.admin)??[];
  const org=manageable.find(org=>org.org_id===selected)??manageable[0];
  return <Page width="narrow"><PageHeader title="Organization publishing" description="Choose who can create, edit and publish your organization's apps, interfaces and cells."/><Surface><Stack>
    {query.isPending?<p role="status">Loading organizations…</p>:query.error?<Alert tone="danger" title="Organizations could not be loaded"><button type="button" onClick={()=>void query.refetch()}>Retry</button></Alert>:!org?<p>Sign in with an organization owner or admin work account to manage these settings. <a href="https://organizations.teamofsilicons.com">Open Organizations</a></p>:<><Select label="Organization" value={org.org_id} onValueChange={setSelected} options={manageable.map(org=>({value:org.org_id,label:org.name}))}/><OrganizationSettings key={org.org_id} org={org.org_id}/></>}
  </Stack></Surface></Page>;
}
