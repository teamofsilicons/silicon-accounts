"use client";
import {useState} from "react";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Stack} from "@/components/foundation/layout/layout";
import {HostedPreview,previewPages,type PreviewDevice} from "@/components/developer/tabs/hosted-preview";
import {CONTACT_FIELDS,defaultFlowOf,emptyStep,freeStepId,normalizeConfig,reconcileFlow} from "@/components/developer/lib/config";
import {BACKGROUND_STYLES,BRAND_FONTS,DENSITIES,LIMITS,PALETTE_KEYS,normalizeBranding} from "@/lib/branding/defaults";
import type {Branding,ContactField,Palette,SigninConfigView,SigninFlow,SigninFlowStep} from "@/lib/api/types";
import {mediaUrl} from "./api";
import styles from "./interfaces.module.css";

const fieldNames:Record<ContactField,string>={email:"Email",phone:"Phone",dob:"Date of birth",timezone:"Time zone"};
const paletteNames:Record<keyof Palette,string>={primary:"Primary",primary_foreground:"Primary text",background:"Background",surface:"Surface",foreground:"Text",muted:"Muted text",border:"Border",danger:"Error"};
type Props={interfaceId:string;name:string;logo:string|null;config:Record<string,unknown>;branding:Record<string,unknown>;onConfig:(change:Record<string,unknown>)=>void;onBrand:(change:Record<string,unknown>)=>void};

export function InterfaceSigninSettings({interfaceId,name,logo,config,branding,onConfig,onBrand}:Props) {
  const [theme,setTheme]=useState<"light"|"dark">("light");const [device,setDevice]=useState<PreviewDevice>("desktop");const [pageKey,setPageKey]=useState("methods-signin");
  const [domains,setDomains]=useState(()=>Array.isArray(config.allowed_email_domains)?config.allowed_email_domains.filter((value):value is string=>typeof value==="string").join("\n"):"");
  const brand=normalizeBranding(branding as Partial<Branding>);
  const draft=normalizeConfig({...config,branding:brand} as Partial<SigninConfigView>);
  const previewBrand={...draft.branding,logo_url:brand.logo_url?mediaUrl(interfaceId,brand.logo_url):null,logo_dark_url:brand.logo_dark_url?mediaUrl(interfaceId,brand.logo_dark_url):null,background_image_url:brand.background_image_url?mediaUrl(interfaceId,brand.background_image_url):null};
  const previewDraft={...draft,branding:previewBrand};
  const pages=previewPages(draft).filter(item=>item.page.kind!=="buttons");
  const page=pages.find(item=>item.key===pageKey)??pages[0]!;
  const requested=[...draft.required_fields,...draft.optional_fields];
  const flow=draft.flow;
  const changeField=(field:ContactField,mode:string)=>{
    const required=draft.required_fields.filter(item=>item!==field);const optional=draft.optional_fields.filter(item=>item!==field);
    if(mode==="required")required.push(field);if(mode==="optional")optional.push(field);
    onConfig({required_fields:required,optional_fields:optional,flow:reconcileFlow(flow,{required_fields:required,optional_fields:optional})});
  };
  const changeStep=(index:number,change:Partial<SigninFlowStep>)=>{if(!flow)return;onConfig({flow:{...flow,steps:flow.steps.map((step,i)=>i===index?{...step,...change}:step)}});};
  const changeFlow=(next:SigninFlow)=>onConfig({flow:next});
  const changePalette=(mode:"light"|"dark",key:keyof Palette,value:string)=>onBrand({[mode]:{...brand[mode],[key]:value}});
  return <>
    <details><summary>Who can sign in</summary><Stack>
      <label className={styles.field}><span><input type="checkbox" checked={draft.allow_signup} onChange={event=>onConfig({allow_signup:event.target.checked})}/> Allow new accounts</span></label>
      <label className={styles.field}><span><input type="checkbox" checked={draft.remember_browser} onChange={event=>onConfig({remember_browser:event.target.checked})}/> Offer remembered accounts</span></label>
      <label className={styles.field}>Allowed email domains<textarea rows={3} value={domains} onChange={event=>{setDomains(event.target.value);onConfig({allowed_email_domains:event.target.value.split("\n").map(value=>value.trim()).filter(Boolean)});}}/><span>One domain per line. When set, the account needs a verified email at an allowed domain, including when signing in by phone.</span></label>
    </Stack></details>
    <details><summary>Details and sign-in pages</summary><Stack>
      <p>Choose which details the Interface asks for. Each app may separately ask for the details it needs.</p>
      {CONTACT_FIELDS.map(field=><label key={field} className={styles.field}>{fieldNames[field]}<select value={draft.required_fields.includes(field)?"required":draft.optional_fields.includes(field)?"optional":"none"} onChange={event=>changeField(field,event.target.value)}><option value="none">Do not ask</option><option value="required">Required</option><option value="optional">Optional</option></select></label>)}
      <label className={styles.field}><span><input type="checkbox" checked={!!flow} disabled={!requested.length&&!flow} onChange={event=>onConfig({flow:event.target.checked?defaultFlowOf(draft):null})}/> Customize the details pages</span><span>Choose at least one detail to arrange custom pages. Otherwise Accounts uses its default page.</span></label>
      {flow&&<>
        {flow.steps.map((step,index)=><div key={index} className={styles.flowStep}><strong>Page {index+1}</strong>
          <Input label="Page ID" value={step.id} maxLength={40} onChange={event=>changeStep(index,{id:event.target.value})}/>
          <Input label="Title" value={step.title??""} maxLength={80} onChange={event=>changeStep(index,{title:event.target.value||null})}/>
          <Input label="Subtitle" value={step.subtitle??""} maxLength={200} onChange={event=>changeStep(index,{subtitle:event.target.value||null})}/>
          <Input label="Continue button label" value={step.continue_label??""} maxLength={30} onChange={event=>changeStep(index,{continue_label:event.target.value||null})}/>
          <label className={styles.field}>Page layout<select value={step.layout??"inherit"} onChange={event=>changeStep(index,{layout:event.target.value==="inherit"?null:event.target.value as SigninFlowStep["layout"]})}><option value="inherit">Use sign-in layout</option><option value="card">Card</option><option value="split">Split</option><option value="minimal">Minimal</option></select></label>
          <p>Details on this page: {step.fields.map(field=>fieldNames[field]).join(", ")}</p>
          <div className={styles.actions}><Button type="button" size="sm" variant="secondary" disabled={index===0} onClick={()=>{const steps=[...flow.steps];[steps[index-1],steps[index]]=[steps[index]!,steps[index-1]!];changeFlow({...flow,steps});}}>Move up</Button><Button type="button" size="sm" variant="secondary" disabled={index===flow.steps.length-1} onClick={()=>{const steps=[...flow.steps];[steps[index],steps[index+1]]=[steps[index+1]!,steps[index]!];changeFlow({...flow,steps});}}>Move down</Button><Button type="button" size="sm" variant="secondary" disabled={flow.steps.length===1} onClick={()=>{const steps=flow.steps.filter((_,i)=>i!==index);const destination=Math.max(0,index-1);steps[destination]={...steps[destination]!,fields:[...steps[destination]!.fields,...step.fields]};changeFlow({...flow,steps});}}>Remove page</Button></div>
        </div>)}
        {requested.map(field=><label key={field} className={styles.field}>{fieldNames[field]} appears on<select value={String(flow.steps.findIndex(step=>step.fields.includes(field)))} onChange={event=>{const target=Number(event.target.value);const steps=flow.steps.map((step,index)=>({...step,fields:index===target?[...step.fields.filter(item=>item!==field),field]:step.fields.filter(item=>item!==field)})).filter(step=>step.fields.length);changeFlow({...flow,steps});}}>{flow.steps.map((step,index)=><option key={index} value={index}>Page {index+1}{step.title?`: ${step.title}`:""}</option>)}</select></label>)}
        <Button type="button" variant="secondary" disabled={flow.steps.length>=8||!flow.steps.some(step=>step.fields.length>1)} onClick={()=>{const index=flow.steps.findIndex(step=>step.fields.length>1);const source=flow.steps[index]!;const moved=source.fields.at(-1)!;const steps=flow.steps.map((step,i)=>i===index?{...step,fields:step.fields.filter(field=>field!==moved)}:step);steps.push(emptyStep(freeStepId(steps),[moved]));changeFlow({...flow,steps});}}>Add page</Button>
        <label className={styles.field}><span><input type="checkbox" checked={flow.review} onChange={event=>changeFlow({...flow,review:event.target.checked})}/> Show a details review page</span></label>
      </>}
    </Stack></details>
    <details><summary>More sign-in appearance</summary><Stack>
      <label className={styles.field}>Text font<select value={brand.font_family} onChange={event=>onBrand({font_family:event.target.value})}>{BRAND_FONTS.map(font=><option key={font} value={font}>{font}</option>)}</select></label>
      <label className={styles.field}>Heading font<select value={brand.heading_font_family??"inherit"} onChange={event=>onBrand({heading_font_family:event.target.value==="inherit"?null:event.target.value})}><option value="inherit">Use text font</option>{BRAND_FONTS.map(font=><option key={font} value={font}>{font}</option>)}</select></label>
      <label className={styles.field}>Background<select value={brand.background_style} onChange={event=>onBrand({background_style:event.target.value,...(event.target.value==="image"?{}:{background_image_url:null})})}>{BACKGROUND_STYLES.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
      {brand.background_style==="image"&&<Input label="Background image URL" type="url" value={brand.background_image_url??""} onChange={event=>onBrand({background_image_url:event.target.value||null})}/>}
      <Input label="Dark-mode logo URL" type="url" value={brand.logo_dark_url??""} onChange={event=>onBrand({logo_dark_url:event.target.value||null})}/>
      <Input label="Logo height in pixels" type="number" min={LIMITS.logoHeight.min} max={LIMITS.logoHeight.max} value={brand.logo_height} onChange={event=>onBrand({logo_height:Number(event.target.value)})}/>
      <Input label="Corner radius in pixels" type="number" min={LIMITS.radius.min} max={LIMITS.radius.max} value={brand.radius} onChange={event=>onBrand({radius:Number(event.target.value)})}/>
      <label className={styles.field}>Density<select value={brand.density} onChange={event=>onBrand({density:event.target.value})}>{DENSITIES.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
      <label className={styles.field}><span><input type="checkbox" checked={brand.show_app_name} onChange={event=>onBrand({show_app_name:event.target.checked})}/> Show interface name next to the logo</span></label>
      {(["light","dark"] as const).map(mode=><fieldset key={mode} className={styles.field}><legend>{mode==="light"?"Light":"Dark"} colors</legend>{PALETTE_KEYS.map(key=><label key={key} className={styles.colorRow}>{paletteNames[key]} <input type="color" value={brand[mode][key]} onChange={event=>changePalette(mode,key,event.target.value)}/><code>{brand[mode][key]}</code></label>)}</fieldset>)}
    </Stack></details>
    <details><summary>Preview sign-in pages</summary><Stack>
      <p>Preview the Accounts sign-in and details pages with this draft. The Interface’s app consent follows separately.</p>
      <label className={styles.field}>Page<select value={page.key} onChange={event=>setPageKey(event.target.value)}>{pages.map(option=><option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
      <label className={styles.field}>Preview theme<select value={theme} onChange={event=>setTheme(event.target.value as "light"|"dark")}><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label className={styles.field}>Preview device<select value={device} onChange={event=>setDevice(event.target.value as PreviewDevice)}><option value="desktop">Desktop</option><option value="phone">Phone</option></select></label>
      <HostedPreview app={{name,logo_url:logo}} config={previewDraft} theme={theme} page={page.page} device={device} host="accounts.teamofsilicons.com"/>
    </Stack></details>
  </>;
}
