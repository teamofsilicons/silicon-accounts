"use client";
import {Select} from "@/components/silicon-ui/select/select";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {useOrganizations, type ResourceKind} from "./api";
export function PublisherSelect({kind,value,onChange,disabled=false}:{kind:ResourceKind;value:string;onChange:(value:string)=>void;disabled?:boolean}) {
  const query=useOrganizations();
  const eligible=query.data?.organizations.filter(org=>org.permissions[kind]?.includes("create"))??[];
  return <div>
    <Select label="Publisher" value={value||"personal"} disabled={disabled||query.isPending} onValueChange={value=>onChange(value==="personal"?"":value)} options={[{value:"personal",label:"Personal account"},...eligible.map(org=>({value:org.org_id,label:org.name}))]} description={value?"The organization owns this resource, including after its creator leaves.":"Create this resource from your personal account."}/>
    {query.error&&<Alert tone="warning" title="Organization publishers could not be loaded">You can still create a personal resource. <button type="button" onClick={()=>void query.refetch()}>Retry</button></Alert>}
  </div>;
}
