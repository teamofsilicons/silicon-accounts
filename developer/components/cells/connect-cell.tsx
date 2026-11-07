"use client";
import {useState} from "react";
import {Stack} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Select} from "@/components/silicon-ui/select/select";
import type {Cell,CellConnectionChoice} from "@/lib/cells/api";
import {CellIdInput} from "./cell-id-input";

export function ConnectCell({cells,selected,onSelect,onConnect,disabled,busy}:{cells:Cell[];selected:string;onSelect:(id:string)=>void;onConnect:(choice:CellConnectionChoice)=>void;disabled:boolean;busy:boolean}){
  const [creating,setCreating]=useState(false),[id,setId]=useState("");
  const options=cells.filter(cell=>cell.status==="active").map(cell=>({value:cell.cell_id,label:`${cell.name} · ${cell.cell_id}`}));
  return <Stack>
    {options.length>0&&<><Select label="Existing cell" value={selected} options={options} onValueChange={onSelect} disabled={disabled||busy}/><div><Button disabled={disabled||!selected} loading={busy} onClick={()=>onConnect({cell_id:selected})}>Use selected cell</Button></div></>}
    {!creating?<div><Button variant="secondary" disabled={disabled||busy} onClick={()=>setCreating(true)}>Create cell</Button></div>:<form onSubmit={event=>{event.preventDefault();onConnect({create_cell_id:id});}}><Stack>
      <CellIdInput value={id} disabled={disabled||busy} onChange={setId}/>
      <p>Cell URL: https://{id||"your-cell-id"}.cells.teamofsilicons.com</p>
      <div><Button type="submit" disabled={disabled} loading={busy}>Create cell and connect</Button>{" "}<Button type="button" variant="ghost" disabled={busy} onClick={()=>setCreating(false)}>Cancel</Button></div>
    </Stack></form>}
  </Stack>;
}
