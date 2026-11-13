import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";
test("event Tings keep recipients and payloads explicit while preserving retry and history controls",async({page})=>{
  await mock(page,true);
  const id="12345678-1234-1234-1234-123456789abc",delivery="22345678-1234-1234-1234-123456789abc",recipient="32345678-1234-1234-1234-123456789abc",extra="42345678-1234-1234-1234-123456789abc",at="2026-11-01T03:30:00Z",marker="<script>window.tingRan=true</script>";
  let definition={name:"Orders",recipients:[recipient],filters:{kinds:["row.inserted"],schema:"public",table:"orders",bucket:null},enabled:true},created=false,deleted=false,version=1,lose=true,definitionReads=0,detailReads=0,olderAttempts=false,retried=false;
  const mutations:{path:string;method:string;body:unknown;key:string|undefined}[]=[];
  const summary=()=>({id,name:definition.name,enabled:definition.enabled,filters:definition.filters,recipient_count:definition.recipients.length,version,created_at:at,updated_at:at,deleted_at:deleted?at:null});
  const message=()=>({id:delivery,event_id:id,event_type:"row.inserted",subscription_version:1,status:retried?"pending":"failed",attempts:2,manual_replays:retried?1:0,window_started_at:at,next_at:at,last_error:"ting_rejected",created_at:at,delivered_at:null});
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace("/api/cells",""),method=request.method();let result:unknown={};
    if(path==="/cells/notes")result={cell:{uuid:id,cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
    else if(path==="/cells/notes/ting-subscriptions"&&method==="GET")result={subscriptions:created&&(!deleted||url.searchParams.get("include_deleted")==="true")?[summary()]:[]};
    else if(path===`/cells/notes/ting-subscriptions/${id}/definition`){definitionReads++;result={definition,version};}
    else if(path===`/cells/notes/ting-subscriptions/${id}/deliveries`)result={deliveries:[message()],next:null};
    else if(path===`/cells/notes/ting-subscriptions/${id}/deliveries/${delivery}`){detailReads++;olderAttempts=url.searchParams.has("before");result={delivery:message(),recipient,event:{data:{new:{private:marker}}},attempts:[{id,attempt:olderAttempts?1:2,replay:0,started_at:at,completed_at:at,status:"failed",error:marker,duration_ms:3}],next:olderAttempts?null:id};}
    else if(method!=="GET"&&path.startsWith("/cells/notes/ting-subscriptions")){
      mutations.push({path,method,body:request.postData()?request.postDataJSON():null,key:request.headers()["idempotency-key"]});
      if(path.endsWith("/retry")){retried=true;result={queued:true,delivery_id:delivery};}
      else if(method==="POST"){created=true;definition=request.postDataJSON();if(lose){lose=false;return route.abort("failed");}result={subscription:summary()};}
      else if(method==="DELETE"){deleted=true;definition.enabled=false;result={subscription:summary()};}
      else {const body=request.postDataJSON();if(body.restore)deleted=false;definition={...definition,...body};version++;result={subscription:summary()};}
    }else throw new Error(`Unexpected request ${path}`);
    await route.fulfill({json:result});
  });
  await page.goto("/cells/notes/tings");await page.getByRole("button",{name:"Create Ting subscription",exact:true}).click();
  await page.getByLabel("Ting subscription name",{exact:true}).fill("Orders");await page.getByLabel("Recipient account UUIDs",{exact:true}).fill(recipient);await page.getByRole("checkbox",{name:"row.inserted",exact:true}).check();await page.getByLabel("Schema filter",{exact:true}).fill("public");await page.getByLabel("Table filter",{exact:true}).fill("orders");
  await page.getByRole("button",{name:"Create subscription",exact:true}).click();await expect.poll(()=>mutations.length).toBe(1);await page.getByRole("button",{name:"Create subscription",exact:true}).click();await expect(page.getByRole("button",{name:"Open Orders",exact:true})).toBeVisible();expect(mutations[0]?.key).toBe(mutations[1]?.key);expect(definitionReads).toBe(0);expect(detailReads).toBe(0);await expect(page.getByText(recipient,{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Open recipients and configuration",exact:true}).click();await expect(page.getByLabel("Recipient account UUIDs",{exact:true})).toHaveValue(recipient);expect(definitionReads).toBe(1);await page.getByLabel("Recipient account UUIDs",{exact:true}).fill(`${recipient}\n${extra}`);await page.getByRole("button",{name:"Save Ting subscription",exact:true}).click();await expect(page.getByText("Enabled · 2 recipients · Version 2",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Open Ting delivery",exact:true}).click();await expect(page.getByText(`Recipient UUID: ${recipient}`,{exact:true})).toBeVisible();await page.getByText("Ting event payload",{exact:true}).click();await expect(page.locator("pre")).toContainText(marker);expect(await page.evaluate(()=>"tingRan" in window)).toBe(false);
  await page.getByRole("button",{name:"Older Ting attempts",exact:true}).click();await expect.poll(()=>olderAttempts).toBe(true);
  await page.getByRole("button",{name:"Retry failed Ting delivery",exact:true}).click();await page.getByRole("button",{name:"Queue Ting retry",exact:true}).click();await expect.poll(()=>retried).toBe(true);await expect(page.getByRole("button",{name:"Retry failed Ting delivery",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Close Ting detail",exact:true}).click();await expect(page.getByText(`Recipient UUID: ${recipient}`,{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Pause Ting subscription",exact:true}).click();await expect(page.getByRole("button",{name:"Enable Ting subscription",exact:true})).toBeVisible();await page.getByRole("button",{name:"Enable Ting subscription",exact:true}).click();
  await page.getByRole("button",{name:"Delete Ting subscription",exact:true}).click();await page.getByRole("button",{name:"Delete subscription and cancel pending deliveries",exact:true}).click();await expect(page.getByRole("checkbox",{name:"Show deleted Ting subscriptions",exact:true})).toBeChecked();await expect(page.getByRole("button",{name:"Restore future events",exact:true})).toBeVisible();await page.getByRole("button",{name:"Restore future events",exact:true}).click();await expect(page.getByRole("button",{name:"Pause Ting subscription",exact:true})).toBeVisible();
  expect(mutations.every(mutation=>mutation.key)).toBe(true);expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain(recipient);expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain(marker);
});
