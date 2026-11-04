"use client";
/* eslint-disable @next/next/no-img-element -- Local file previews use a temporary object URL. */
import Link from "next/link";
import {useEffect, useState, type FormEvent} from "react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {Page, PageHeader, Section, Surface, Stack, Grid} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {SecretReveal} from "@/components/developer/parts/secret-reveal";
import {useCellsLeaveGuard} from "@/components/cells/shared";
import {ApiError} from "@/lib/api/errors";
import {request, type Interface, type Kind, type Me, type Upload} from "./api";
import styles from "./interfaces.module.css";

type Created = {interface:Interface;interface_secret:string};
const appList=(value:string)=>value.split(/[\n,]/).map(x=>x.trim()).filter(Boolean);
const suggestedId=(value:string)=>value.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,30).replace(/-+$/g,"");
const validId=(value:string)=>/^[a-z0-9_-]{3,30}$/.test(value);

export function InterfacesHome() {
  const cache=useQueryClient();
  const list=useQuery({queryKey:["interfaces","list"],queryFn:()=>request<{interfaces:Interface[]}>("interfaces?mine=true")});
  const me=useQuery({queryKey:["interfaces","me"],queryFn:()=>request<Me>("me")});
  const [creating,setCreating]=useState(false); const [step,setStep]=useState(0);
  const [name,setName]=useState(""); const [id,setId]=useState(""); const [idEdited,setIdEdited]=useState(false);
  const [apps,setApps]=useState(""); const [kind,setKind]=useState<Kind>("unverified");
  const eligibility=me.data?.eligibility;
  // Every creator can use unverified; higher types require an explicit grant.
  const kindAvailable=kind==="unverified" || (kind==="verified" && eligibility?.verified) || (kind==="trusted" && eligibility?.trusted);
  const selectedKind:Kind=kindAvailable?kind:"unverified";
  // Clear a revoked selection immediately, so it cannot reappear if grants change again.
  if(eligibility && !kindAvailable)setKind("unverified");
  const [logo,setLogo]=useState<File|null>(null); const [logoPreview,setLogoPreview]=useState(""); const [uploadedLogo,setUploadedLogo]=useState<Upload|null>(null);
  const [created,setCreated]=useState<Created|null>(null);
  const [busy,setBusy]=useState(false); const [failure,setFailure]=useState<unknown>(null); const [logoFailure,setLogoFailure]=useState<unknown>(null);
  useEffect(()=>()=>{if(logoPreview)URL.revokeObjectURL(logoPreview);},[logoPreview]);
  useCellsLeaveGuard(busy || !!created || (creating && (!!name || !!id || !!apps || !!logo)), created?"Save the interface secret before leaving. It is shown only once.":"Your new interface has not been created yet.");
  function chooseLogo(file:File|null) {
    setFailure(null);
    if(file && (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size>10*1024*1024)) {
      setLogo(null); setLogoPreview(""); setFailure(new Error("Choose a PNG, JPEG or WebP image up to 10 MiB.")); return;
    }
    setLogo(file); setLogoPreview(file?URL.createObjectURL(file):"");
  }
  async function attachLogo(result:Created, file:File, previous:Upload|null) {
    const prefix=`interfaces/${encodeURIComponent(result.interface.interface_id)}`;
    const image=previous??(await request<{upload:Upload}>(`${prefix}/uploads?category=image`,{method:"POST",file})).upload;
    setUploadedLogo(image);
    const updated=await request<{interface:Interface}>(prefix,{method:"PATCH",body:{revision:result.interface.revision,logo_url:image.url}});
    setCreated({...result,interface:updated.interface});
    setLogoFailure(null);
  }
  async function retryLogo() {
    if(!created || !logo || busy)return;
    setBusy(true);setLogoFailure(null);
    try {await attachLogo(created,logo,uploadedLogo);} catch(error){setLogoFailure(error);} finally {setBusy(false);}
  }
  async function create(event:FormEvent) {
    event.preventDefault(); if (busy) return;
    if(!name.trim() || new TextEncoder().encode(name.trim()).length>160 || !validId(id)) {setStep(0);setFailure(new Error("Enter a name and an ID of 3–30 lowercase letters, numbers, hyphens or underscores."));return;}
    const selected=appList(apps);
    if(selectedKind!=="trusted" && !selected.length) {setStep(1);setFailure(new Error("Add at least one app ID to continue."));return;}
    if(selected.length>100 || new Set(selected).size!==selected.length || selected.some(x=>!(/^[a-z0-9_-]{3,30}$/.test(x)||/^[a-z][a-z0-9-]{1,39}$/.test(x)))) {setStep(1);setFailure(new Error("Enter up to 100 different app IDs using lowercase letters, numbers, hyphens or underscores."));return;}
    setBusy(true);setFailure(null);
    try {
      const result=await request<Created>("interfaces",{method:"POST",body:{interface_id:id,name:name.trim(),kind:selectedKind,app_ids:selected}});
      // Hold the one-time secret before doing anything else. A failed logo upload must never hide it.
      setCreated(result); void cache.invalidateQueries({queryKey:["interfaces","list"]});
      if(logo)try {await attachLogo(result,logo,null);}catch(error){setLogoFailure(error);}
    } catch(error){setFailure(error);void cache.invalidateQueries({queryKey:["interfaces","list"]});} finally {setBusy(false);}
  }
  function next() {
    setFailure(null);
    if(step===0 && (!name.trim() || new TextEncoder().encode(name.trim()).length>160 || !validId(id))) {setFailure(new Error("Enter a name and an ID of 3–30 lowercase letters, numbers, hyphens or underscores."));return;}
    if(step===1 && selectedKind!=="trusted" && !appList(apps).length) {setFailure(new Error("Add at least one app ID to continue."));return;}
    setStep(value=>Math.min(2,value+1));
  }
  function reset() {setCreated(null);setCreating(false);setStep(0);setName("");setId("");setIdEdited(false);setApps("");setKind("unverified");setLogo(null);setLogoPreview("");setUploadedLogo(null);setLogoFailure(null);setFailure(null);}
  async function invitation(inviteId:string,action:"accept"|"decline") {setFailure(null);try {await request(`invites/${inviteId}/${action}`,{method:"POST",body:{}});void cache.invalidateQueries({queryKey:["interfaces"]});}catch(error){setFailure(error);}}
  const alert=failure!=null && <Alert tone="danger" title={failure instanceof Error && !(failure instanceof ApiError) ? failure.message : ApiError.from(failure).message}>{failure instanceof ApiError ? failure.hint : undefined}</Alert>;
  if(creating) return <Page width="narrow" className={styles.portal}><PageHeader title={created?"Your interface is ready":"Create an interface"} description={created?"Store your secret to finish setup.":"Start with the essentials. You can change the details before publishing."}/>
    {alert}
    {created && !busy ? <SecretReveal title="Save your interface secret" description="Keep this on your server or in a password manager. It will not be shown again." secrets={[{label:"Interface secret",value:created.interface_secret}]} onDone={reset} doneLabel="I’ve saved the secret">
      {logoFailure ? <div className={styles.notice}><p>Your interface was created, but its logo could not be saved. You can retry now or add it in settings later.</p><Button type="button" variant="secondary" onClick={()=>void retryLogo()}>Retry logo upload</Button></div> : <p>{logo?"Your logo is ready. ":"You can add a logo later. "}After saving your secret, open {created.interface.name} to finish setup.</p>}
    </SecretReveal> : busy && created ? <p role="status">Adding your logo… Keep this page open to save your secret.</p> : <Surface className={styles.createCard}>
      <ol className={styles.steps} aria-label="Creation progress">{["Basics","Apps","Review"].map((label,index)=><li key={label} aria-current={step===index?"step":undefined}><span data-sq="surface">{index+1}</span>{label}</li>)}</ol>
      <form onSubmit={event=>void create(event)}><Stack gap={6}>
        {step===0 && <><div className={styles.stepIntro}><h2>Make it yours</h2><p>Give your interface a name and a recognizable logo.</p></div>
          <Input label="Name" value={name} onChange={event=>{setName(event.target.value);if(!idEdited)setId(suggestedId(event.target.value));}} placeholder="e.g. My workspace" maxLength={160} autoComplete="off"/>
          <Input label="Interface ID" value={id} onChange={event=>{setId(event.target.value);setIdEdited(true);}} description="A permanent ID, 3–30 lowercase letters, numbers, hyphens or underscores." autoComplete="off" spellCheck={false}/>
          <div className={styles.logoField}><div className={styles.logoPreview} data-sq="surface">{logoPreview?<img src={logoPreview} alt="Selected logo preview"/>:<span aria-hidden="true">{name.trim().charAt(0).toUpperCase()||"+"}</span>}</div><label className={styles.logoChooser}><strong>Logo <span className={styles.muted}>(optional)</span></strong><span>PNG, JPEG or WebP, up to 10 MiB. You can change it later.</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>chooseLogo(event.target.files?.[0]??null)}/>{logo && <span>{logo.name}</span>}</label></div>
        </>}
        {step===1 && <><div className={styles.stepIntro}><h2>Connect your apps</h2><p>Carbons will see these apps and choose whether to share access when they sign in.</p></div>
          {(eligibility?.verified || eligibility?.trusted) && <label className={styles.field}>Interface type<select value={selectedKind} onChange={event=>setKind(event.target.value as Kind)}><option value="unverified">Unverified</option>{eligibility.verified && <option value="verified">Verified</option>}{eligibility.trusted && <option value="trusted">Trusted</option>}</select><span>Most interfaces start unverified. You can request verification or trust after creation.</span></label>}
          <label className={styles.field}>App IDs<textarea rows={3} value={apps} onChange={event=>setApps(event.target.value)} placeholder="write, ring"/><span>Separate app IDs with commas or new lines. {selectedKind==="trusted"?"A trusted interface can start without a list.":"Add at least one app; you can change the list later."}</span></label>
          <p className={styles.helpLink}><Link href="/docs/interfaces">Learn about interface types and sign-in →</Link></p>
        </>}
        {step===2 && <><div className={styles.stepIntro}><h2>Review and create</h2><p>Your interface starts as a private draft. You can complete publishing and sign-in settings next.</p></div>
          <dl className={styles.review}><div><dt>Name</dt><dd>{name}</dd></div><div><dt>Interface ID</dt><dd>{id}</dd></div><div><dt>Logo</dt><dd>{logo?.name??"Add later"}</dd></div>{(eligibility?.verified || eligibility?.trusted) && <div><dt>Type</dt><dd>{selectedKind}</dd></div>}<div><dt>Apps</dt><dd>{appList(apps).join(", ")||"No fixed app list"}</dd></div></dl>
          <p className={styles.muted}>You’ll receive a secret once after creation. Keep it somewhere secure.</p>
        </>}
        <div className={styles.wizardActions}><Button type="button" variant="secondary" disabled={busy} onClick={()=>{setFailure(null);if(step>0)setStep(step-1);else reset();}}>{step===0?"Cancel":"Back"}</Button>{step<2?<Button key="continue" type="button" onClick={event=>{event.preventDefault();next();}}>Continue</Button>:<Button key="create" type="submit" loading={busy}>Create interface</Button>}</div>
      </Stack></form>
    </Surface>}
  </Page>;
  return <Page className={styles.portal}><PageHeader title="Your interfaces" description="Bring Silicon apps together in a place that feels like yours." actions={<Button onClick={()=>{setCreating(true);setFailure(null);}}>Create interface</Button>}/>
    {alert}
    {list.error && <Alert tone="danger" title={ApiError.from(list.error).message}>{ApiError.from(list.error).hint}</Alert>}
    <Section title="Your interfaces" description="Manage sign-in, creators, publishing and releases.">
      {list.isPending ? <p role="status">Loading interfaces…</p> : list.data?.interfaces.length ? <Grid>{list.data.interfaces.map(item=><Surface key={item.interface_id} className={styles.card}><Link href={`/interfaces/${encodeURIComponent(item.interface_id)}`} className={styles.title}>{item.name}</Link><p className={styles.muted}>{item.interface_id} · {item.pending_operation ? "Save needs attention" : item.published ? "Published" : "Draft"}</p><Link href={`/interfaces/${encodeURIComponent(item.interface_id)}`}>Manage →</Link></Surface>)}</Grid> : !list.error ? <Surface><p>No interfaces yet. Create your first one to get started.</p><Button onClick={()=>{setCreating(true);setFailure(null);}}>Create interface</Button></Surface> : null}
    </Section>
    {me.data?.invites?.filter(x=>x.status==="pending").length ? <Section title="Invitations"><Stack>{me.data.invites.filter(x=>x.status==="pending").map(invite=><Surface key={invite.id}><Stack><strong>{invite.interface_name || invite.interface_id}</strong><div className={styles.actions}><Button size="sm" onClick={()=>void invitation(invite.id,"accept")}>Accept</Button><Button size="sm" variant="secondary" onClick={()=>void invitation(invite.id,"decline")}>Decline</Button></div></Stack></Surface>)}</Stack></Section> : null}
  </Page>;
}
