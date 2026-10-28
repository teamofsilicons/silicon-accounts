import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";

test("webhooks reveal secrets once, preserve retry keys, and inspect/replay delivery payloads safely",async({page})=>{
  await mock(page,true);
  const id="12345678-1234-1234-1234-123456789abc",deliveryId="12345678-1234-1234-1234-123456789abd",at="2026-10-28T12:00:00Z";
  let exists=false,failCreate=true,detailReads=0;
  let webhook={id,name:"New notes",url:"https://receiver.example/hook?private=query",enabled:true,filters:{kinds:["row.inserted"],schema:"public",table:"notes",bucket:null},version:1,created_at:at,updated_at:at,deleted_at:null as string|null};
  const delivery={id:deliveryId,webhook_id:id,event_id:id,event_type:"row.inserted",status:"failed",attempts:1,manual_replays:0,window_started_at:at,next_at:at,last_error:"http_500",created_at:at,delivered_at:null};
  const mutations:{path:string;body:Record<string,unknown>|null;key:string|undefined}[]=[];
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace("/api/cells", ""),method=request.method();
    const body=request.postData()?request.postDataJSON():null;
    if(method!=="GET")mutations.push({path,body,key:request.headers()["idempotency-key"]});
    let result:unknown={};
    if(path==="/cells/notes")result={cell:{uuid:id,cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
    else if(path==="/cells/notes/webhooks"){
      if(method==="POST"){exists=true;webhook={...webhook,...body};if(failCreate){failCreate=false;return route.abort("failed");}result={webhook,signing_secret:"whsec_create_private"};}
      else result={webhooks:exists||new URL(request.url()).searchParams.get("include_deleted")==="true"?[webhook]:[]};
    }else if(path===`/cells/notes/webhooks/${id}`){if(method==="PATCH"){webhook={...webhook,...body};result={webhook};}else if(method==="DELETE"){exists=false;webhook.deleted_at=at;result={deleted:true};}}
    else if(path.endsWith("/rotate-secret"))result={signing_secret:"whsec_rotated_private"};
    else if(path.endsWith("/retry")){delivery.status="pending";delivery.manual_replays++;result={queued:true};}
    else if(path.endsWith("/deliveries"))result={deliveries:[delivery],next:null};
    else if(path.endsWith(`/deliveries/${deliveryId}`)){detailReads++;result={delivery,payload:{data:{new:{body:"<script>window.webhookPayloadRan=true</script>"}}},attempts:[{id,attempt:1,replay:0,started_at:at,completed_at:at,status:"failed",http_status:500,error:"http_500",duration_ms:5}],next:null};}
    return route.fulfill({json:result});
  });
  await page.goto("/cells/notes/webhooks");
  await page.getByRole("button",{name:"Create webhook",exact:true}).click();
  await page.getByLabel("Webhook name",{exact:true}).fill("New notes");
  await page.getByLabel("Endpoint URL",{exact:true}).fill("https://receiver.example/hook?private=query");
  await page.getByRole("checkbox",{name:"row.inserted",exact:true}).check();
  await page.getByLabel("Schema filter",{exact:true}).fill("public");
  await page.getByLabel("Table filter",{exact:true}).fill("notes");
  await page.getByRole("button",{name:"Create endpoint",exact:true}).click();
  await expect(page.getByText("Could not reach Silicon Cells.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Create endpoint",exact:true}).click();
  const reveal=page.getByRole("group",{name:"Webhook signing secret",exact:true});
  await expect(reveal).toBeVisible();
  await expect(page.getByText("whsec_create_private",{exact:true})).toHaveCount(0);
  await reveal.getByRole("button",{name:"Show the signing secret",exact:true}).click();
  await expect(page.getByText("whsec_create_private",{exact:true})).toBeVisible();
  expect(mutations[0].key).toBeTruthy();expect(mutations[0].key).toBe(mutations[1].key);
  expect(mutations[1].body?.filters).toEqual({kinds:["row.inserted"],schema:"public",table:"notes",bucket:null});
  expect(await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]))).not.toContain("whsec_");
  await reveal.getByRole("button",{name:"I've stored it",exact:true}).click();
  await expect(page.getByText("whsec_create_private",{exact:true})).toHaveCount(0);
  expect(detailReads).toBe(0);
  await page.getByRole("button",{name:"Open delivery",exact:true}).click();
  await page.getByText("Event payload",{exact:true}).click();
  await expect(page.getByText(/<script>window.webhookPayloadRan=true<\/script>/)).toBeVisible();
  expect(await page.evaluate(()=>Object.hasOwn(window,"webhookPayloadRan"))).toBe(false);
  await page.getByRole("button",{name:"Replay delivery",exact:true}).click();
  await page.getByRole("button",{name:"Queue replay",exact:true}).click();
  await expect.poll(()=>delivery.status).toBe("pending");
  await page.getByRole("button",{name:"Pause webhook",exact:true}).click();
  await expect(page.getByRole("button",{name:"Enable webhook",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Rotate signing secret",exact:true}).click();
  await page.getByRole("button",{name:"Rotate secret",exact:true}).click();
  await expect(reveal).toBeVisible();
  await reveal.getByRole("button",{name:"Show the signing secret",exact:true}).click();
  await expect(page.getByText("whsec_rotated_private",{exact:true})).toBeVisible();
  await reveal.getByRole("button",{name:"I've stored it",exact:true}).click();
  await page.getByRole("button",{name:"Delete webhook",exact:true}).click();
  await page.getByRole("button",{name:"Delete endpoint",exact:true}).click();
  await expect(page.getByText(/Delivery history is retained; this endpoint cannot be changed or replayed/)).toBeVisible();
  await expect(page.getByRole("button",{name:"Edit webhook",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Replay delivery",exact:true})).toHaveCount(0);
  await page.getByRole("checkbox",{name:"Show deleted webhooks",exact:true}).uncheck();
  await expect(page.getByText("No outgoing webhooks yet.",{exact:true})).toBeVisible();
});
