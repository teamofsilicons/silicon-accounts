"use client";

import {useState} from "react";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {Select} from "@/components/silicon-ui/select/select";
import {useSession} from "@/lib/query/session";
import {useOrganizations, type ResourceKind} from "./api";

export function usePublisher(kind:ResourceKind) {
  const {me}=useSession();
  const query=useOrganizations();
  const [choice,setChoice]=useState<{account:string; value:string}>();
  const orgs=query.data?.account_uuid===me?.uuid ? query.data?.organizations : undefined;
  const eligible=orgs?.filter(org=>org.permissions[kind]?.includes("create"))??[];
  const selected=choice?.account===me?.uuid ? choice?.value : undefined;
  const home=me?.id?.includes(".") ? me.id.slice(me.id.lastIndexOf(".")+1) : undefined;
  let value=selected==="personal" || eligible.some(org=>`org:${org.org_id}`===selected) ? selected : undefined;
  if(value===undefined && orgs) {
    if(home && eligible.some(org=>org.org_id===home)) value=`org:${home}`;
    else if(!home && orgs.length===0) value="personal";
    else if(!home && orgs.length===1 && eligible.length===1) value=`org:${eligible[0].org_id}`;
  }
  return {
    value, eligible, ready:value!==undefined, organizationId:value==="personal"?null:value?.slice(4),
    loading:query.isPending, error:query.error,
    select:(value:string)=>{if(me)setChoice({account:me.uuid,value});},
    reset:()=>setChoice(undefined),
    retry:()=>void query.refetch(),
  };
}

export function PublisherSelect({publisher,disabled=false}:{publisher:ReturnType<typeof usePublisher>;disabled?:boolean}) {
  return <div>
    <Select label="Publisher" placeholder={publisher.loading?"Loading publishers…":"Choose a publisher"}
      value={publisher.value??""} disabled={disabled||publisher.loading} onValueChange={publisher.select}
      options={[{value:"personal",label:"Personal account"},...publisher.eligible.map(org=>({value:`org:${org.org_id}`,label:org.name}))]}
      description={publisher.organizationId?"The organization owns this resource, including after its creator leaves.":undefined}/>
    {publisher.error&&<Alert tone="warning" title="Organization publishers could not be loaded"><button type="button" onClick={publisher.retry}>Retry</button></Alert>}
  </div>;
}
