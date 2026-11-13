"use client";
/* eslint-disable @next/next/no-img-element -- Authenticated image previews use the sealed-session BFF. */
import {useEffect, useMemo, useState} from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {Page,PageHeader,Section,Surface,Stack} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Textarea} from "@/components/silicon-ui/textarea/textarea";
import {Select} from "@/components/silicon-ui/select/select";
import {FileDropzone} from "@/components/silicon-ui/file-dropzone/file-dropzone";
import {Badge} from "@/components/silicon-ui/badge/badge";
import {CopyButton} from "@/components/silicon-ui/copy-button/copy-button";
import {Tabs,TabsContent,TabsList,TabsTrigger} from "@/components/silicon-ui/tabs/tabs";
import {AppIcon} from "@/components/developer/parts/app-icon";
import {ArrowLeft} from "lucide-react";
import appStyles from "@/components/developer/app/app.module.css";
import {SecretReveal} from "@/components/developer/parts/secret-reveal";
import {Failure,useCellsLeaveGuard} from "@/components/cells/shared";
import {request,mediaUrl,type Interface,type Kind,type Me,type Upload,type AccessRequest,type History} from "./api";
import styles from "./interfaces.module.css";
import {InterfaceCellSection} from "./cell";
import {InterfaceSigninSettings} from "./signin-settings";

const sections = [
  {value:"overview", label:"Overview", hash:"#interface-details"},
  {value:"publishing", label:"Publishing", hash:"#interface-publishing"},
  {value:"releases", label:"Releases", hash:"#interface-releases"},
  {value:"uploads", label:"Uploads", hash:"#interface-uploads"},
  {value:"creators", label:"Creators", hash:"#interface-creators"},
  {value:"history", label:"History", hash:"#interface-history"},
  {value:"sign-in", label:"Sign-in", hash:"#interface-sign-in"},
  {value:"cell", label:"Cell", hash:"#interface-cell"},
  {value:"verification", label:"Verification", hash:"#interface-access"},
] as const;
type InterfaceTab = typeof sections[number]["value"];
const tabForHash = (hash:string):InterfaceTab => sections.find(section=>section.hash===hash)?.value ?? "overview";
const platforms=["web","macos","windows","linux","android","ios"] as const;
const signInMethods=["google","apple","email","phone"] as const;
const lines=(text:string)=>text.split("\n").map(x=>x.trim()).filter(Boolean);
const list=(values:string[]|undefined)=>(values??[]).join("\n");

export function InterfaceWorkspace({interfaceId,cellsEnabled}:{interfaceId:string;cellsEnabled:boolean}) {
  const cache=useQueryClient();const router=useRouter();const prefix=`interfaces/${encodeURIComponent(interfaceId)}`;
  const detail=useQuery({queryKey:["interface",interfaceId],queryFn:()=>request<{interface:Interface}>(prefix)});
  const uploads=useQuery({queryKey:["interface",interfaceId,"uploads"],queryFn:()=>request<{uploads:Upload[]}>(`${prefix}/uploads`)});
  const readiness=useQuery({queryKey:["interface",interfaceId,"readiness"],queryFn:()=>request<{ready:boolean;missing:string[]}>(`${prefix}/readiness`)});
  const requests=useQuery({queryKey:["interface",interfaceId,"requests"],queryFn:()=>request<{requests:AccessRequest[]}>(`${prefix}/requests`)});
  const history=useQuery({queryKey:["interface",interfaceId,"history"],queryFn:()=>request<{events:History[]}>(`${prefix}/history`)});
  const me=useQuery({queryKey:["interfaces","me"],queryFn:()=>request<Me>("me")});
  const invitations=useQuery({queryKey:["interface",interfaceId,"invitations"],queryFn:()=>request<{invites:{id:string;target:{id:string;display_name:string};status:string;created_at:string}[]}>(`${prefix}/invites`)});
  const [tab,setTab]=useState<InterfaceTab>("overview");
  useEffect(()=>{
    const sync=()=>setTab(tabForHash(window.location.hash));
    sync();window.addEventListener("hashchange",sync);window.addEventListener("popstate",sync);
    return()=>{window.removeEventListener("hashchange",sync);window.removeEventListener("popstate",sync);};
  },[]);
  const openTab=(value:string)=>{
    const next=sections.find(section=>section.value===value);
    if(!next || next.value===tab)return;
    window.history.pushState(null,"",`${window.location.pathname}${window.location.search}${next.hash}`);
    setTab(next.value);
  };
  const [error,setError]=useState<unknown>(null);const [busy,setBusy]=useState(false);const [secret,setSecret]=useState("");
  const [draft,setDraft]=useState<Interface|null>(null);const [dirty,setDirty]=useState(false);const [branding,setBranding]=useState("");
  const [appIds,setAppIds]=useState(""); const [redirects,setRedirects]=useState(""); const [origins,setOrigins]=useState("");const [images,setImages]=useState("");
  const [target,setTarget]=useState("");const [reason,setReason]=useState("");const [requestKind,setRequestKind]=useState("verified");
  const [version,setVersion]=useState("");const [notes,setNotes]=useState("");const [assets,setAssets]=useState<Record<string,string>>({});
  const [logoFile,setLogoFile]=useState<File|null>(null);
  const [uploadFile,setUploadFile]=useState<File|null>(null);const [category,setCategory]=useState<"image"|"release">("image");
  const [logoSelection,setLogoSelection]=useState(0);const [uploadSelection,setUploadSelection]=useState(0);
  // Reconcile an externally refreshed server revision only while there is no local draft to lose.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{if(detail.data && !dirty){const item=detail.data.interface;setDraft(item);setBranding(JSON.stringify(item.branding??{},null,2));setAppIds(list(item.app_ids));setRedirects(list(item.redirect_uris));setOrigins(list(item.allowed_origins));setImages(list(item.images));}},[detail.data,dirty]);
  useCellsLeaveGuard(busy||!!secret||dirty||!!logoFile||!!uploadFile||!!version.trim()||!!notes.trim()||!!target.trim()||!!reason.trim()||Object.values(assets).some(Boolean),secret?"Save the secret before leaving. It is shown only once.":"Your interface changes are not saved yet.");
  const refresh=()=>Promise.all([cache.invalidateQueries({queryKey:["interface",interfaceId]}),cache.invalidateQueries({queryKey:["interfaces","list"]})]);
  async function run(action:()=>Promise<unknown>){if(busy)return;setBusy(true);setError(null);try {await action();await refresh();}catch(failure){setError(failure);await refresh();}finally{setBusy(false);}}
  const patch=(value:Partial<Interface>)=>{setDirty(true);setDraft(current=>current?{...current,...value}:current);};
  const setText=(value:string,set:(v:string)=>void)=>{set(value);setDirty(true);};
  const brandValue=()=>{try {const value:unknown=JSON.parse(branding);return value && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:null;}catch{return null;}};
  const updateBrand=(change:Record<string,unknown>)=>{const current=brandValue();if(!current){setError(new Error("Fix the branding JSON before changing these settings."));return;}setBranding(JSON.stringify({...current,...change},null,2));setDirty(true);};
  const changeBrand=(key:string,value:unknown)=>updateBrand({[key]:value});
  const imageUploads=useMemo(()=>uploads.data?.uploads.filter(upload=>upload.category==="image")??[],[uploads.data]);
  const releaseUploads=useMemo(()=>uploads.data?.uploads.filter(upload=>upload.category==="release")??[],[uploads.data]);
  if(detail.isPending) return <Page><p role="status">Loading interface…</p></Page>;
  if(!draft) return <Page><PageHeader title="Interface" back={{href:"/interfaces",label:"Your interfaces"}}/><Failure error={detail.error}/></Page>;
  const signin=draft.signin_config??{};
  const pendingOperation=detail.data?.interface.pending_operation??draft.pending_operation;
  const showType=Boolean(me.data?.eligibility?.verified || me.data?.eligibility?.trusted || detail.data?.interface.kind!=="unverified");
  const methods=(signin.methods && typeof signin.methods==="object" ? signin.methods : {}) as Record<string,unknown>;
  const copy=(signin.copy && typeof signin.copy==="object" ? signin.copy : {}) as Record<string,unknown>;
  const order=Array.isArray(signin.method_order) ? [...signin.method_order.filter((item):item is string=>typeof item==="string" && signInMethods.includes(item as typeof signInMethods[number])),...signInMethods.filter(item=>!(signin.method_order as unknown[]).includes(item))] : [...signInMethods];
  const setSignin=(value:Record<string,unknown>)=>patch({signin_config:{...signin,...value}});
  const save=()=>run(async()=>{let parsed:unknown;try {parsed=JSON.parse(branding);} catch {throw new Error("Branding must be a valid JSON object.");}if(!parsed||Array.isArray(parsed)||typeof parsed!=="object")throw new Error("Branding must be a JSON object.");
    const ids=lines(appIds);const descriptions=Object.fromEntries(Object.entries(draft.app_descriptions??{}).filter(([id])=>ids.includes(id)));
    const result=await request<{interface:Interface}>(prefix,{method:"PATCH",body:{revision:draft.revision,name:draft.name,logo_url:draft.logo_url,kind:draft.kind,app_ids:ids,app_descriptions:descriptions,redirect_uris:lines(redirects),allowed_origins:lines(origins),branding:parsed,signin_config:draft.signin_config??{},description:draft.description,website_url:draft.website_url,cover_url:draft.cover_url,images:lines(images),platforms:draft.platforms,links:draft.links}});cache.setQueryData(["interface",interfaceId],result);setDirty(false);});
  async function uploadLogo() {
    if(!logoFile || busy)return;
    if(!["image/png","image/jpeg","image/webp"].includes(logoFile.type) || logoFile.size>10*1024*1024) {setError(new Error("Choose a PNG, JPEG or WebP image up to 10 MiB."));return;}
    setBusy(true);setError(null);
    try {
      const {upload}=await request<{upload:Upload}>(`${prefix}/uploads?category=image`,{method:"POST",file:logoFile});
      patch({logo_url:upload.url});setLogoFile(null);setLogoSelection(value=>value+1);
      void cache.invalidateQueries({queryKey:["interface",interfaceId,"uploads"]});
    } catch(failure) {setError(failure);} finally {setBusy(false);}
  }
  const mutation=(name:string,body:Record<string,unknown>={})=>run(async()=>{await request(`${prefix}/${name}`,{method:"POST",body:{revision:draft.revision,...body}});});
  return <Page>
    <header className={appStyles.header}>
      <Link href="/interfaces" className={appStyles.back}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true"/>Your interfaces</Link>
      <div className={appStyles.identity}>
        <AppIcon name={draft.name} src={draft.logo_url?mediaUrl(interfaceId,draft.logo_url):null} size={64} decorative/>
        <div className={appStyles.identityText}><h1 className={appStyles.title}>{draft.name}</h1><div className={appStyles.facts}>
          <span className={appStyles.appId}>{draft.interface_id}<CopyButton value={draft.interface_id} label="Copy interface ID" iconOnly variant="plain"/></span>
          <span className={appStyles.factDivider} aria-hidden="true"/><Badge size="sm" tone={draft.published?"success":"neutral"}>{draft.published?"Published":"Draft"}</Badge>
          {showType && <><span className={appStyles.factDivider} aria-hidden="true"/><span>{draft.kind}</span></>}
        </div></div>
      </div>
    </header>
    <Failure error={error??detail.error}/>
    {secret && <SecretReveal title="Your interface secret" description="Keep this secure. It will not be shown again." secrets={[{label:"Interface secret",value:secret}]} onDone={()=>setSecret("")}/>}
    {pendingOperation && <Section title="Finish the pending save" description="A previous change is waiting for Accounts. Finish it before making another change."><Surface><Stack><p>Operation: {pendingOperation.action.replaceAll("_"," ")}</p>{pendingOperation.can_resume?<Button loading={busy} onClick={()=>void run(async()=>{const result=await request<{interface:Interface;interface_secret?:string}>(`${prefix}/resume`,{method:"POST",body:{}});if(result.interface_secret)setSecret(result.interface_secret);cache.setQueryData(["interface",interfaceId],{interface:result.interface});setDirty(false);})}>Resume pending save</Button>:<p>The creator who started this change can resume it.</p>}</Stack></Surface></Section>}
    <fieldset disabled={!!pendingOperation} className={styles.editor}>
    <Tabs value={tab} onValueChange={openTab} activationMode="manual" className={appStyles.tabs}>
      <TabsList aria-label={`${draft.name} sections`}>{sections.map(section=><TabsTrigger key={section.value} value={section.value}>{section.label}</TabsTrigger>)}</TabsList>
      <TabsContent value={tab} forceMount className={`${appStyles.panel} ${styles.tabPanel}`}>
    <div hidden={tab!=="overview"}>
    <Section id="interface-details" title="Details" description="Describe your interface and how people can find it."><Surface><fieldset disabled={busy} className={styles.editor}><Stack>
      <Link href="/docs/interfaces#interface-sign-in">Read the interface sign-in guide →</Link>
      <Input label="Name" value={draft.name??""} onChange={event=>patch({name:event.target.value})}/>
      {showType && <Select label="Interface type" description="Verified and trusted types are available after your request is reviewed and eligibility is granted." value={draft.kind} onValueChange={value=>patch({kind:value as Kind})} options={[{value:"unverified",label:"Unverified"},...((me.data?.eligibility?.verified||detail.data?.interface.kind==="verified")?[{value:"verified",label:"Verified"}]:[]),...((me.data?.eligibility?.trusted||detail.data?.interface.kind==="trusted")?[{value:"trusted",label:"Trusted"}]:[])]}/>}
      <Failure error={me.error}/>
      <div className={styles.logoField}><div className={styles.logoPreview} data-sq="surface">{draft.logo_url?<img src={mediaUrl(interfaceId,draft.logo_url)} alt="Current logo preview"/>:<span aria-hidden="true">{draft.name?.charAt(0).toUpperCase()||"+"}</span>}</div><div className={styles.logoChooser}><strong>Logo</strong><FileDropzone key={logoSelection} label="Choose a logo file" description="PNG, JPEG or WebP, up to 10 MiB." accept="image/png,image/jpeg,image/webp" note="PNG, JPEG or WebP" maxSize={10*1024*1024} multiple={false} onFilesChange={files=>setLogoFile(files[0] && files[0].size<=10*1024*1024?files[0]:null)}/><Button type="button" variant="secondary" size="sm" disabled={!logoFile} loading={busy} onClick={()=>void uploadLogo()}>Upload logo</Button><span>Save changes to use the uploaded logo.</span></div></div>
      <details><summary>Use a logo URL instead</summary><Input label="Logo URL" type="url" value={draft.logo_url??""} onChange={event=>patch({logo_url:event.target.value||null})}/></details>
      {imageUploads.length>0&&<Select label="Use an uploaded image as the logo" placeholder="Choose image" value="" onValueChange={value=>patch({logo_url:value})} options={imageUploads.map(upload=>({value:upload.url,label:upload.filename}))}/>}
      <Textarea label="Description" rows={4} value={draft.description??""} onChange={event=>patch({description:event.target.value})}/>
      <Input label="Website URL" type="url" value={draft.website_url??""} onChange={event=>patch({website_url:event.target.value||null})}/>
      <Input label="Cover image URL" type="url" value={draft.cover_url??""} onChange={event=>patch({cover_url:event.target.value||null})}/>
      {imageUploads.length>0&&<Select label="Use an uploaded image as the cover" placeholder="Choose image" value="" onValueChange={value=>patch({cover_url:value})} options={imageUploads.map(upload=>({value:upload.url,label:upload.filename}))}/>}
      <Textarea label="Gallery image URLs" description="One URL per line. Uploaded image URLs appear in Uploads." rows={3} value={images} onChange={event=>setText(event.target.value,setImages)}/>
      </Stack></fieldset></Surface></Section>
    </div>
    <div hidden={tab!=="sign-in"}>
    <Section id="interface-sign-in" title="Sign-in" description="Choose apps, sign-in methods and the experience people see."><Surface><fieldset disabled={busy} className={styles.editor}><Stack gap={4}>
      <Link href="/docs/interfaces#interface-sign-in">Read the interface sign-in guide →</Link>
      <Textarea label="App IDs" description="One app ID per line. Trusted interfaces may leave this empty." rows={3} value={appIds} onChange={event=>setText(event.target.value,setAppIds)}/>
      {lines(appIds).map(id=><Input key={id} label={`Why ${id} is needed`} value={draft.app_descriptions?.[id]??""} maxLength={500} onChange={event=>patch({app_descriptions:{...draft.app_descriptions,[id]:event.target.value}})}/>)}
      <Textarea label="Redirect URIs" description="One exact URI per line, such as https://example.com/callback." rows={3} value={redirects} onChange={event=>setText(event.target.value,setRedirects)}/>
      <Textarea label="Allowed origins" description="One origin per line, such as https://example.com. For Cell sign-in, include the origin of each redirect URI." rows={3} value={origins} onChange={event=>setText(event.target.value,setOrigins)}/>
      <label className={styles.field}><span><input type="checkbox" checked={draft.signin_config?.public_client !== false} onChange={event=>patch({signin_config:{...draft.signin_config,public_client:event.target.checked}})}/> Allow browser and native clients</span><span>Public clients use S256 PKCE without a secret. Turn this off when only your trusted backend should exchange, inspect or revoke tokens using the interface secret.</span></label>
      <fieldset className={styles.field}><legend>Sign-in methods</legend><span>Choose the methods and the order they appear. Google and Apple use Silicon Accounts’ managed providers.</span>{order.map((method,index)=><div key={method} className={styles.actions}><label><input type="checkbox" checked={typeof methods[method]==="boolean" ? Boolean(methods[method]) : method==="email"} onChange={event=>setSignin({methods:{...methods,[method]:event.target.checked}})}/> {method[0]!.toUpperCase()+method.slice(1)}</label><Button type="button" variant="secondary" size="sm" disabled={index===0} aria-label={`Move ${method} up`} onClick={()=>{const next=[...order];[next[index-1],next[index]]=[next[index]!,next[index-1]!];setSignin({method_order:next});}}>↑</Button><Button type="button" variant="secondary" size="sm" disabled={index===order.length-1} aria-label={`Move ${method} down`} onClick={()=>{const next=[...order];[next[index],next[index+1]]=[next[index+1]!,next[index]!];setSignin({method_order:next});}}>↓</Button></div>)}</fieldset>
      <details><summary>Sign-in page text</summary><Stack>{([{key:"title",label:"Sign-in title",max:80},{key:"subtitle",label:"Sign-in subtitle",max:200},{key:"signup_title",label:"Sign-up title",max:80},{key:"signup_subtitle",label:"Sign-up subtitle",max:200},{key:"opening_title",label:"Opening provider title",max:80},{key:"terms_url",label:"Terms URL",max:2048},{key:"privacy_url",label:"Privacy URL",max:2048},{key:"support_email",label:"Support email",max:254}] as const).map(field=><Input key={field.key} label={field.label} maxLength={field.max} value={typeof copy[field.key]==="string"?String(copy[field.key]):""} onChange={event=>setSignin({copy:{...copy,[field.key]:event.target.value||null}})}/>)}</Stack></details>
      <Select label="Sign-in appearance" value={String(brandValue()?.theme??"auto")} onValueChange={value=>changeBrand("theme",value)} options={[{value:'auto',label:'Follow the device'},{value:'light',label:'Light'},{value:'dark',label:'Dark'}]}/>
      <Select label="Sign-in layout" value={String(brandValue()?.layout??"card")} onValueChange={value=>changeBrand("layout",value)} options={[{value:'card',label:'Card'},{value:'split',label:'Split'},{value:'minimal',label:'Minimal'}]}/>
      <Select label="Corners" value={String(brandValue()?.corner_style??"squircle")} onValueChange={value=>changeBrand("corner_style",value)} options={[{value:'squircle',label:'Squircle'},{value:'rounded',label:'Rounded'},{value:'sharp',label:'Sharp'}]}/>
      <Select label="Buttons" value={String(brandValue()?.button_style??"solid")} onValueChange={value=>changeBrand("button_style",value)} options={[{value:'solid',label:'Solid'},{value:'soft',label:'Soft'},{value:'outline',label:'Outline'}]}/>
      <Input label="Sign-in logo URL" type="url" value={String(brandValue()?.logo_url??"")} onChange={event=>changeBrand("logo_url",event.target.value||null)}/>
      <details><summary>Advanced sign-in branding</summary><label className={styles.field}>Accounts branding settings<textarea className={styles.code} rows={6} value={branding} onChange={event=>setText(event.target.value,setBranding)}/><span>Edit the full JSON object. <Link href="/docs/interfaces">Read the authentication guide</Link>.</span></label></details>
      <InterfaceSigninSettings key={`${interfaceId}-${draft.revision}`} interfaceId={interfaceId} name={draft.name} logo={draft.logo_url?mediaUrl(interfaceId,draft.logo_url):null} config={signin} branding={brandValue()??{}} onConfig={setSignin} onBrand={updateBrand}/>
      </Stack></fieldset></Surface></Section>
    </div>
    <div hidden={tab!=="overview"}>
    <Section title="Availability and links" description="Choose platforms and add useful links for your listing."><Surface><fieldset disabled={busy} className={styles.editor}><Stack>
      <fieldset className={styles.field}><legend>Platforms</legend><div className={styles.actions}>{platforms.map(platform=><label key={platform}><input type="checkbox" checked={draft.platforms?.includes(platform)??false} onChange={event=>patch({platforms:event.target.checked?[...(draft.platforms??[]),platform]:(draft.platforms??[]).filter(value=>value!==platform)})}/> {platform}</label>)}</div></fieldset>
      <div><strong>Additional links</strong>{(draft.links??[]).map((link,index)=><div key={index} className={styles.linkRow}><Input label={`Link ${index+1} label`} value={link.label} onChange={event=>patch({links:draft.links.map((value,i)=>i===index?{...value,label:event.target.value}:value)})}/><Input label="URL" type="url" value={link.url} onChange={event=>patch({links:draft.links.map((value,i)=>i===index?{...value,url:event.target.value}:value)})}/><Button type="button" variant="secondary" size="sm" onClick={()=>patch({links:draft.links.filter((_,i)=>i!==index)})}>Remove</Button></div>)}<Button type="button" variant="secondary" size="sm" onClick={()=>patch({links:[...(draft.links??[]),{label:"",url:""}]})}>Add link</Button></div>
    </Stack></fieldset></Surface></Section>
    </div>
    <div hidden={tab!=="cell"} id="interface-cell">{cellsEnabled?<InterfaceCellSection interfaceId={interfaceId} disabled={dirty||busy} publicClient={detail.data?.interface.signin_config?.public_client!==false}/>:<Section title="Sign in with a cell"><Surface><p>Cell sign-in for interfaces is temporarily unavailable. Use Silicon Accounts sign-in directly while this integration is unavailable.</p></Surface></Section>}</div>
    <div hidden={tab!=="uploads"}><Section id="interface-uploads" title="Uploads" description="Upload images for your listing and release files for supported platforms."><Surface><Stack>
      <Select label="Upload type" value={category} onValueChange={value=>{setCategory(value as "image"|"release");setUploadFile(null);}} options={[{value:"image",label:"Image · PNG, JPEG or WebP, up to 10 MiB"},{value:"release",label:"Release file · up to 512 MiB"}]}/>
      <FileDropzone key={`${category}-${uploadSelection}`} label="Choose a file" description={category==="image"?"PNG, JPEG or WebP, up to 10 MiB.":"Release file, up to 512 MiB."} accept={category==="image"?"image/png,image/jpeg,image/webp":undefined} maxSize={(category==="image"?10:512)*1024*1024} multiple={false} onFilesChange={files=>setUploadFile(files[0] && files[0].size<=(category==="image"?10:512)*1024*1024?files[0]:null)}/>
      <Button disabled={!uploadFile||dirty} loading={busy} onClick={()=>void run(async()=>{if(!uploadFile)return;await request(`${prefix}/uploads?category=${category}`,{method:"POST",file:uploadFile});setUploadFile(null);setUploadSelection(value=>value+1);})}>Upload file</Button>
      {dirty && <span className={styles.muted}>Save your changes before uploading.</span>}
      <Failure error={uploads.error}/>
      {(uploads.data?.uploads??[]).map(upload=><div key={upload.id} className={styles.upload}><strong>{upload.filename}</strong><span>{upload.category} · {(upload.size/1024/1024).toFixed(2)} MiB</span>{upload.category==="image"&&<><img className={styles.preview} src={mediaUrl(interfaceId,upload.url)} alt={`Preview of ${upload.filename}`}/><code>{upload.url}</code><Button type="button" variant="secondary" size="sm" onClick={()=>{setImages(value=>[...lines(value),upload.url].join("\n"));setDirty(true);}}>Add to gallery</Button></>}</div>)}
    </Stack></Surface></Section>
    </div><div hidden={tab!=="releases"}><Section id="interface-releases" title="Releases" description="Attach the files you uploaded to a version."><Surface><Stack>
      <Input label="Version" value={version} onChange={event=>setVersion(event.target.value)}/>
      <Textarea label="Release notes" rows={4} value={notes} onChange={event=>setNotes(event.target.value)}/>
      {platforms.filter(p=>p!=="web").map(platform=><Select key={platform} label={platform} value={assets[platform]||"none"} onValueChange={value=>setAssets({...assets,[platform]:value==="none"?"":value})} options={[{value:"none",label:"No file"},...releaseUploads.map(upload=>({value:upload.id,label:upload.filename}))]}/>)}
      <Button disabled={!version.trim()||!Object.values(assets).some(Boolean)||dirty} loading={busy} onClick={()=>void run(async()=>{await request(`${prefix}/releases`,{method:"POST",body:{revision:draft.revision,version,notes,assets:Object.entries(assets).filter(([,id])=>id).map(([platform,upload_id])=>({platform,upload_id}))}});setVersion("");setNotes("");setAssets({});})}>Create release</Button>
      {(draft.releases??[]).map(release=><div key={release.id} className={styles.upload}><strong>{release.version}</strong><span>{release.created_at}</span><p>{release.notes}</p>{release.assets.map(asset=><div key={asset.upload_id}>{asset.platform}: {asset.filename} · {asset.sha256}</div>)}</div>)}
    </Stack></Surface></Section>
    </div><div hidden={tab!=="publishing"}><Section id="interface-publishing" title="Publishing" description="Make this interface discoverable to Carbons and Silicons."><Surface><Stack>
      <Failure error={readiness.error}/>{readiness.data && <div><strong>{readiness.data.ready?"Ready to publish":"Before publishing"}</strong>{readiness.data.missing?.map(item=><p key={item}>{item}</p>)}</div>}
      <Button disabled={dirty||(!draft.published&&!readiness.data?.ready)} loading={busy} onClick={()=>void mutation(draft.published?"unpublish":"publish")}>{draft.published?"Unpublish":"Publish interface"}</Button>
    </Stack></Surface></Section>
    </div><div hidden={tab!=="creators"}><Section id="interface-creators" title="Creators" description="Invite another Carbon or Silicon to help manage this interface."><Surface><Stack>
      {(draft.creators??[]).map(creator=><p key={creator.uuid}>{creator.display_name} · {creator.id}</p>)}
      <Failure error={invitations.error}/>{invitations.data?.invites.map(invite=><p key={invite.id}>{invite.target.display_name} · {invite.target.id} · {invite.status}</p>)}
      <Input label="Carbon or Silicon ID" placeholder="c:example or si:example" value={target} onChange={event=>setTarget(event.target.value)}/>
      <Button disabled={!target.trim()||dirty} loading={busy} onClick={()=>void run(async()=>{await request(`${prefix}/invites`,{method:"POST",body:{target:target.trim()}});setTarget("");})}>Invite creator</Button>
      <Button variant="secondary" disabled={dirty} loading={busy} onClick={()=>{if(window.confirm("Leave this interface? You may need another creator to invite you again."))void run(async()=>{await request(`${prefix}/leave`,{method:"POST",body:{revision:draft.revision}});router.push("/interfaces");});}}>Leave interface</Button>
    </Stack></Surface></Section>
    </div><div hidden={tab!=="verification"}><Section id="interface-access" title="Verification and trust" description="Request eligibility to create a verified or trusted interface. Requests are reviewed."><Surface><Stack>
      <p>A trusted interface can obtain the signed-in Carbon’s full authority granted by each target app, including management capabilities exposed by that app.</p>
      <Select label="Request type" value={requestKind} onValueChange={setRequestKind} options={[{value:"verified",label:"Verified"},{value:"trusted",label:"Trusted"}]}/>
      <Textarea label="Why are you requesting this?" rows={3} value={reason} onChange={event=>setReason(event.target.value)}/>
      <Button disabled={!reason.trim()||dirty} loading={busy} onClick={()=>void run(async()=>{await request(`${prefix}/requests`,{method:"POST",body:{kind:requestKind,reason}});setReason("");})}>Submit request</Button>
      <Failure error={requests.error}/>{requests.data?.requests.map(item=><p key={item.id}>{item.kind} · {item.status} · {item.created_at}</p>)}
    </Stack></Surface></Section>
    </div><div hidden={tab!=="history"}><Section id="interface-history" title="Secret and history"><Surface><Stack>
      <Button variant="secondary" disabled={dirty} loading={busy} onClick={()=>{if(window.confirm("Rotate the interface secret? Update your server to use the new secret."))void run(async()=>{const result=await request<{interface_secret:string}>(`${prefix}/rotate-secret`,{method:"POST",body:{revision:draft.revision}});setSecret(result.interface_secret);});}}>Rotate secret</Button>
      <Failure error={history.error}/>{history.data?.events.map(item=><div key={item.id} className={styles.upload}><strong>{item.action}</strong><span>{item.actor_uuid} · {item.created_at}</span><span>{typeof item.detail==="string"?item.detail:JSON.stringify(item.detail)}</span></div>)}
    </Stack></Surface></Section></div>
      </TabsContent>
    </Tabs>
    {dirty && <div className={styles.saveBar} data-sq="surface" role="status"><span>Unsaved changes</span><Button disabled={busy} loading={busy} onClick={()=>void save()}>Save changes</Button></div>}
    </fieldset>
  </Page>;
}
