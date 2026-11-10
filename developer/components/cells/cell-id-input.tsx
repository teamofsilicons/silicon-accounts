"use client";
import {useQuery} from "@tanstack/react-query";
import {Input} from "@/components/silicon-ui/input/input";
import {cellsRequest} from "@/lib/cells/api";

export function CellIdInput({value,onChange,disabled=false,label="Cell ID"}:{value:string;onChange:(value:string)=>void;disabled?:boolean;label?:string}){
  const valid=/^(?!.*--)[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(value);
  const availability=useQuery({queryKey:["cells","availability",value],queryFn:({signal})=>cellsRequest<{available:boolean}>(`/cells/availability?cell_id=${encodeURIComponent(value)}`,{signal}),enabled:valid,staleTime:0,retry:false});
  return <><Input label={label} required pattern="(?!.*--)[a-z][a-z0-9\-]{1,28}[a-z0-9]" value={value} disabled={disabled} onChange={event=>onChange(event.target.value)} description="3–30 lowercase letters, digits or hyphens. Start with a letter, end with a letter or digit, and avoid consecutive hyphens."/>{valid&&<p role="status">{availability.isFetching?"Checking availability…":availability.isError?"Could not check availability. The ID will be checked when you submit.":availability.data?.available?"This Cell ID is available.":"This Cell ID is unavailable."}</p>}</>;
}
