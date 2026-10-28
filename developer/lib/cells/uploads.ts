import {cellsRequest} from "./api";
import {ApiError} from "@/lib/api/errors";
export interface UploadStatus {
  id:string;object_id:string;bucket:string;name:string;content_type:string;
  can_resume:boolean;status:string;size:number;part_bytes:number;
  parts:{number:number;size:number;sha256:string}[];result:unknown;
}
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
export async function resumeAuthorUpload(cell:string,id:string,file:Blob,signal:AbortSignal,progress:(bytes:number)=>void):Promise<unknown>{
  const base=`/cells/${encodeURIComponent(cell)}/storage-api/uploads/${encodeURIComponent(id)}`;
  const status=await cellsRequest<UploadStatus>(base,{signal});
  if(!status.can_resume)throw new Error("Only the author who started this upload can resume it.");
  if(status.status==="complete")return status.result;
  if(!["creating","uploading","completing"].includes(status.status))throw new Error(`This upload is ${status.status}; it cannot be resumed.`);
  if(file.size!==status.size)throw new Error("Select the original file. Its size differs from this upload.");
  if(!Number.isSafeInteger(status.part_bytes)||status.part_bytes<=0||status.part_bytes>1024**3)throw new Error("The service returned an invalid upload part size.");
  const count=Math.max(1,Math.ceil(file.size/status.part_bytes)),done=new Map<number,number>();
  // Validate every committed part before sending any new bytes. Reselecting a
  // different file of the same size must never splice it onto the old upload.
  for(const part of status.parts){
    signal.throwIfAborted();
    const chunk=file.slice(part.number*status.part_bytes,Math.min((part.number+1)*status.part_bytes,file.size));
    if(part.number<0||part.number>=count||done.has(part.number)||chunk.size!==part.size||hex(await crypto.subtle.digest("SHA-256",await chunk.arrayBuffer()))!==part.sha256)throw new Error("The selected file does not match the parts already uploaded. Select the original file, or cancel this upload.");
    done.set(part.number,part.size);
  }
  let uploaded=Array.from(done.values()).reduce((sum,n)=>sum+n,0);progress(uploaded);
  for(let part=0;part<count;part++){
    signal.throwIfAborted();if(done.has(part))continue;
    const chunk=file.slice(part*status.part_bytes,Math.min((part+1)*status.part_bytes,file.size));
    const response=await fetch(`/api/cells${base}/parts/${part}`,{method:"PUT",body:chunk,signal,credentials:"same-origin",cache:"no-store",redirect:"error",headers:{"content-type":"application/octet-stream"}});
    const value=await response.json().catch(()=>null);
    if(!response.ok)throw new ApiError({status:response.status,code:value?.error?.code??"upload_failed",message:value?.error?.message??"This file part could not be uploaded.",hint:value?.error?.hint??"Resume with the same file to continue."});
    uploaded+=chunk.size;progress(uploaded);
  }
  signal.throwIfAborted();
  return cellsRequest(base+"/complete",{method:"POST",signal});
}
