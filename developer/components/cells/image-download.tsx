"use client";
import Image from "next/image";
import {useEffect,useRef,useState} from "react";
import {Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Select} from "@/components/silicon-ui/select/select";
import {ApiError} from "@/lib/api/errors";
import {cellPath,Failure,bytes} from "./shared";
import styles from "./cells.module.css";

export function ImageDownload({cellId,file}:{cellId:string;file:{bucket:string;name:string}}){
  const [width,setWidth]=useState("800"),[height,setHeight]=useState(""),[fit,setFit]=useState("contain"),[format,setFormat]=useState("webp"),[quality,setQuality]=useState("85");
  const [result,setResult]=useState<{url:string;size:number;name:string}|null>(null),[failure,setFailure]=useState<unknown>(null),[busy,setBusy]=useState(false);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  useEffect(()=>()=>{if(result)URL.revokeObjectURL(result.url);},[result]);
  function change(set:(value:string)=>void,value:string){set(value);setResult(null);}
  async function preview(){
    if(controller.current)return;
    const control=new AbortController();controller.current=control;setBusy(true);setFailure(null);setResult(null);
    try{
      const params=new URLSearchParams({format});
      if(width)params.set("width",width);if(height)params.set("height",height);
      if(width||height)params.set("fit",fit);if(format==="jpeg")params.set("quality",quality);
      const path=cellPath(cellId,`/storage-api/object/${encodeURIComponent(file.bucket)}/${file.name.split("/").map(encodeURIComponent).join("/")}?${params}`);
      const response=await fetch(`/api/cells${path}`,{credentials:"same-origin",cache:"no-store",redirect:"error",signal:control.signal});
      if(!response.ok){const body=await response.json().catch(()=>null);throw new ApiError({status:response.status,code:body?.error?.code??"image_failed",message:body?.error?.message??"The image could not be created.",hint:body?.error?.hint});}
      const blob=await response.blob();
      control.signal.throwIfAborted();
      if(!["image/png","image/jpeg","image/webp"].includes(blob.type)||blob.size>32*1024*1024)throw new Error("The image response was invalid.");
      const stem=(file.name.split("/").at(-1)??"image").replace(/\.[^.]+$/,"");
      setResult({url:URL.createObjectURL(blob),size:blob.size,name:`${stem}.${format==="jpeg"?"jpg":format}`});
    }catch(error){if(!control.signal.aborted)setFailure(error);}
    finally{controller.current=null;setBusy(false);}
  }
  return <form onSubmit={event=>{event.preventDefault();void preview();}}><Stack>
    <p>Resize, crop or convert a copy to download. Leave both dimensions empty to keep the original size.</p>
    <Failure error={failure}/>
    <Cluster><Input label="Width in pixels" type="number" min={1} max={4096} value={width} disabled={busy} onChange={e=>change(setWidth,e.target.value)}/><Input label="Height in pixels" type="number" min={1} max={4096} value={height} disabled={busy} onChange={e=>change(setHeight,e.target.value)}/></Cluster>
    <Select label="Fit" value={fit} disabled={busy} onValueChange={value=>change(setFit,value)} options={[{value:"contain",label:"Keep proportions"},{value:"cover",label:"Crop to fill"},{value:"fill",label:"Stretch to size"}]}/>
    {fit!=="contain"&&<p className={styles.muted}>Crop and stretch need both width and height.</p>}
    <Select label="Format" value={format} disabled={busy} onValueChange={value=>change(setFormat,value)} options={[{value:"webp",label:"WebP"},{value:"png",label:"PNG"},{value:"jpeg",label:"JPEG"}]}/>
    {format==="jpeg"?<Input label="JPEG quality" type="number" min={1} max={100} required value={quality} disabled={busy} onChange={e=>change(setQuality,e.target.value)}/>:<p className={styles.muted}>PNG and WebP preserve transparency. JPEG uses a white background.</p>}
    <Button type="submit" loading={busy} disabled={fit!=="contain"&&(!width||!height)}>Preview image</Button>
    {result&&<Stack><Image unoptimized src={result.url} alt={`Preview of ${file.name}`} width={480} height={360} className={styles.imagePreview}/><Cluster><a href={result.url} download={result.name}>Download {result.name}</a><span className={styles.muted}>{bytes(result.size)}</span></Cluster></Stack>}
  </Stack></form>;
}
