import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";

test("queue configuration, stable enqueue retries, private detail, replay and restore work through the BFF",async({page})=>{
  await mock(page,true);
  const id="12345678-1234-1234-1234-123456789abc",at="2026-10-28T12:00:00Z";
  let configured=false,enqueued=false,lost=true,detailReads=0;
  let queue={name:"orders",consumer:"process-orders",enabled:true,batch_size:1,max_attempts:5,backoff_seconds:10,max_backoff_seconds:3600,enqueue_policy:{mode:"closed",users:[]},created_at:at,updated_at:at,deleted_at:null as string|null};
  const message={id,delivery_id:id,queue_name:"orders",source:"api",actor:{author_uuid:id},created_at:at,available_at:at,status:"failed",attempts:1,manual_replays:0,last_error:"function_failed",completed_at:at};
  const mutations:{path:string;method:string;body:Record<string,unknown>|null;key:string|undefined}[]=[];
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace("/api/cells", ""),method=request.method();
    const body=request.postData()?request.postDataJSON():null;
    if(method!=="GET")mutations.push({path,method,body,key:request.headers()["idempotency-key"]});
    let result:unknown={};
    if(path==="/cells/notes")result={cell:{uuid:id,cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
    else if(path==="/cells/notes/functions")result={functions:[{name:"process-orders",active_version:id}]};
    else if(path==="/cells/notes/queues")result={queues:configured&&(!queue.deleted_at||url.searchParams.get("include_deleted")==="true")?[queue]:[],unconfigured:[]};
    else if(path==="/cells/notes/queues/orders"){
      if(method==="PUT"||method==="PATCH"){configured=true;queue={...queue,...body};if(method==="PUT")queue.deleted_at=null;result={queue};}
      else if(method==="DELETE"){queue.deleted_at=at;queue.enabled=false;result={deleted:true};}else result={queue};
    }else if(path.endsWith("/retry")){message.status="pending";message.manual_replays++;result={queued:true};}
    else if(path.endsWith("/messages")){
      if(method==="POST"){enqueued=true;if(lost){lost=false;return route.abort("failed");}result={message_id:id,delivery_id:id,queue:"orders"};}
      else result={messages:enqueued?[message]:[],next:null};
    }else if(path.endsWith(`/messages/${id}`)){detailReads++;result={message:{...message,payload:{value:"<script>window.queuePayloadRan=true</script>"}},attempts:[{run_id:id,attempt:1,replay:0,started_at:at,completed_at:at,status:"failed",error_code:"function_failed",invocation_id:id,response_status:500,logs:["<script>window.queueLogsRan=true</script>"]}],next:null};}
    return route.fulfill({json:result});
  });
  await page.goto("/cells/notes/queues");
  await page.getByRole("button",{name:"Create queue",exact:true}).click();
  await page.getByLabel("Queue name",{exact:true}).fill("orders");
  await page.getByRole("combobox",{name:"Consumer function",exact:true}).click();
  await page.getByRole("option",{name:"process-orders",exact:true}).click();
  await page.getByLabel("Batch size",{exact:true}).fill("4");
  await page.getByRole("dialog").getByRole("button",{name:"Create queue",exact:true}).click();
  await expect(page.getByRole("button",{name:"Enqueue once",exact:true})).toBeVisible();
  expect(queue.batch_size).toBe(4);
  await page.getByLabel("Message payload (JSON)",{exact:true}).fill('{"value":"<script>window.queuePayloadRan=true</script>"}');
  await page.getByRole("button",{name:"Enqueue once",exact:true}).click();
  await expect(page.getByText("Could not reach Silicon Cells.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Enqueue once",exact:true}).click();
  await expect(page.getByText(/Queued message/)).toBeVisible();
  const sent=mutations.filter(mutation=>mutation.path.endsWith("/messages"));expect(sent).toHaveLength(2);expect(sent[0].key).toBeTruthy();expect(sent[0].key).toBe(sent[1].key);
  expect(detailReads).toBe(0);
  await page.getByRole("button",{name:"Open message",exact:true}).click();
  await page.getByText("Message payload and actor",{exact:true}).click();
  await page.getByText("Consumer logs",{exact:true}).click();
  await expect(page.locator("pre").filter({hasText:"<script>window.queuePayloadRan=true</script>"})).toBeVisible();
  await expect(page.getByText("<script>window.queueLogsRan=true</script>",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>Object.hasOwn(window,"queuePayloadRan")||Object.hasOwn(window,"queueLogsRan"))).toBe(false);
  await page.getByRole("button",{name:"Replay failed message",exact:true}).click();
  await page.getByRole("button",{name:"Queue message replay",exact:true}).click();
  await expect.poll(()=>message.status).toBe("pending");
  await page.getByRole("button",{name:"Pause queue",exact:true}).click();
  await expect(page.getByRole("button",{name:"Enable queue",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Delete queue",exact:true}).click();
  await page.getByRole("button",{name:"Delete queue and retain history",exact:true}).click();
  await expect(page.getByRole("button",{name:"Restore queue",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Enqueue once",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Restore queue",exact:true}).click();
  await page.getByRole("button",{name:"Save queue",exact:true}).click();
  await expect.poll(()=>queue.deleted_at).toBeNull();
  const restored=mutations.filter(mutation=>mutation.method==="PUT").at(-1)!;
  expect(Object.keys(restored.body!).sort()).toEqual(["consumer","batch_size","max_attempts","backoff_seconds","max_backoff_seconds","enabled","enqueue_policy"].sort());
  await expect(page.getByRole("button",{name:"Enqueue once",exact:true})).toBeVisible();
});
