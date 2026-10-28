import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";

test("event triggers preserve definitions and keys, paginate safe detail, and gate replay",async({page})=>{
  await mock(page,true);
  const id="12345678-1234-1234-1234-123456789abc",at="2026-10-28T12:00:00Z";
  let created=false,lost=true,detailReads=0,cursor:string|null=null;
  let definition={name:"Profile changed",function:"on-profile",enabled:true,filters:{kinds:["user.updated"],schema:null,table:null,bucket:null},max_attempts:5,backoff_seconds:10};
  const saved={...definition};
  let trigger={...definition,id,version:1,created_at:at,updated_at:at,deleted_at:null as string|null};
  const delivery={id,trigger_id:id,event_id:id,status:"succeeded",attempts:1,manual_replays:0,next_at:at,created_at:at,finished_at:at,last_error:null};
  const mutations:{path:string;method:string;body:Record<string,unknown>|null;key:string|undefined}[]=[];
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace("/api/cells", ""),method=request.method(),body=request.postData()?request.postDataJSON():null;
    if(method!=="GET")mutations.push({path,method,body,key:request.headers()["idempotency-key"]});
    let result:unknown={};
    if(path==="/cells/notes")result={cell:{uuid:id,cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
    else if(path==="/cells/notes/functions")result={functions:[{name:"on-profile",active_version:id}]};
    else if(path==="/cells/notes/triggers"){
      if(method==="POST"){created=true;definition=body;trigger={...trigger,...definition};if(lost){lost=false;return route.abort("failed");}result={trigger};}
      else result={triggers:created&&(!trigger.deleted_at||url.searchParams.get("include_deleted")==="true")?[trigger]:[]};
    }else if(path===`/cells/notes/triggers/${id}`){if(method==="PUT"){definition=body;trigger={...trigger,...definition};result={trigger};}else if(method==="DELETE"){trigger.deleted_at=at;trigger.enabled=false;result={deleted:true};}}
    else if(path.endsWith("/retry")){delivery.status="pending";delivery.manual_replays++;result={queued:true};}
    else if(path.endsWith("/deliveries"))result={deliveries:[delivery],next:null};
    else if(path.endsWith(`/deliveries/${id}`)){detailReads++;cursor=url.searchParams.get("before");result={delivery:{...delivery,payload:{event_id:id,type:"user.updated",data:{new:{display_name:"<script>window.triggerPayloadRan=true</script>"}}},definition:saved},attempts:[{id,delivery_id:id,attempt:1,replay:0,started_at:at,finished_at:at,duration_ms:5,status:"succeeded",response_status:200,invocation_id:id,error:null,logs:[cursor?"older attempt":"<script>window.triggerLogsRan=true</script>"]}],next:cursor?null:id};}
    return route.fulfill({json:result});
  });
  await page.goto("/cells/notes/triggers");
  await page.getByRole("button",{name:"Create trigger",exact:true}).click();
  await page.getByLabel("Trigger name",{exact:true}).fill("Profile changed");
  await page.getByRole("combobox",{name:"Consumer function",exact:true}).click();
  await page.getByRole("option",{name:"on-profile",exact:true}).click();
  await page.getByRole("checkbox",{name:"user.updated",exact:true}).check();
  await page.getByRole("button",{name:"Create event trigger",exact:true}).click();
  await expect(page.getByText("Could not reach Silicon Cells.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Create event trigger",exact:true}).click();
  await expect(page.getByRole("button",{name:"Pause trigger",exact:true})).toBeVisible();
  expect(mutations[0].key).toBeTruthy();expect(mutations[0].key).toBe(mutations[1].key);
  expect(mutations[1].body?.filters).toEqual({kinds:["user.updated"],schema:null,table:null,bucket:null});
  expect(detailReads).toBe(0);
  await page.getByRole("button",{name:"Open event delivery",exact:true}).click();
  await page.getByText("Event envelope and saved definition",{exact:true}).click();
  await page.getByText("Function logs",{exact:true}).click();
  await expect(page.locator("pre").filter({hasText:"<script>window.triggerPayloadRan=true</script>"})).toBeVisible();
  await expect(page.getByText("<script>window.triggerLogsRan=true</script>",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>Object.hasOwn(window,"triggerPayloadRan")||Object.hasOwn(window,"triggerLogsRan"))).toBe(false);
  await page.getByRole("button",{name:"Older event attempts",exact:true}).click();
  await expect.poll(()=>cursor).toBe(id);
  await page.getByRole("button",{name:"Pause trigger",exact:true}).click();
  await expect(page.getByRole("button",{name:"Enable trigger",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Replay event delivery",exact:true})).toBeDisabled();
  expect(Object.keys(mutations.find(item=>item.method==="PUT")!.body!).sort()).toEqual(["name","function","filters","enabled","max_attempts","backoff_seconds"].sort());
  await page.getByRole("button",{name:"Enable trigger",exact:true}).click();
  await expect(page.getByRole("button",{name:"Replay event delivery",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"Replay event delivery",exact:true}).click();
  await page.getByRole("button",{name:"Queue event replay",exact:true}).click();
  await expect.poll(()=>delivery.status).toBe("pending");
  await page.getByRole("button",{name:"Delete trigger",exact:true}).click();
  await page.getByRole("button",{name:"Delete trigger and retain history",exact:true}).click();
  await expect(page.getByText(/Retained history remains available/)).toBeVisible();
  await expect(page.getByRole("button",{name:"Edit trigger",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Replay event delivery",exact:true})).toHaveCount(0);
});
