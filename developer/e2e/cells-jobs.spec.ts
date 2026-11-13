import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";

test("scheduled jobs preview, keep definitions private, retain versions and retry stable manual runs",async({page})=>{
  await mock(page,true);
  const id="12345678-1234-1234-1234-123456789abc",older="22345678-1234-1234-1234-123456789abc",at="2026-11-01T03:30:00Z";
  let definition={schedule:{cron:"0 9 * * *",timezone:"Asia/Kolkata"} as {cron:string;timezone:string}|{at:string},target:{sql:"select 'private-job-source'",execute:false} as {sql:string;execute:boolean}|{function:string;input:unknown},enabled:true,allow_overlap:false,max_attempts:1,backoff_seconds:10,max_backoff_seconds:3600,timeout_seconds:30};
  let configured=false,deleted:string|null=null,revision=1,lostRun=true,queued=false,definitionReads=0,detailReads=0,attemptCursor:string|null=null;
  const run={id,job:"morning",version:id,scheduled_for:at,trigger:"manual",requested_by:id,status:"failed",attempts:1,replays:0,available_at:at,created_at:at,started_at:at,finished_at:at,duration_ms:20,last_error:"sql_failed"};
  const metadata=()=>({name:"morning",version:id,revision,schedule:definition.schedule,target_kind:"sql" in definition.target?"sql":"function",function:"function" in definition.target?definition.target.function:null,enabled:definition.enabled,allow_overlap:definition.allow_overlap,max_attempts:definition.max_attempts,backoff_seconds:definition.backoff_seconds,max_backoff_seconds:definition.max_backoff_seconds,timeout_seconds:definition.timeout_seconds,next_run_at:definition.enabled?at:null,created_at:at,updated_at:at,deleted_at:deleted});
  const mutations:{path:string;method:string;body:Record<string,unknown>|null;key:string|undefined}[]=[];
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace("/api/cells",""),method=request.method(),body=request.postData()?request.postDataJSON():null;
    if(method!=="GET")mutations.push({path,method,body,key:request.headers()["idempotency-key"]});
    let result:unknown={};
    if(path==="/cells/notes")result={cell:{uuid:id,cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
    else if(path==="/cells/notes/functions")result={functions:[{name:"daily-report",active_version:id}]};
    else if(path==="/cells/notes/jobs")result={jobs:configured&&(!deleted||url.searchParams.get("include_deleted")==="true")?[metadata()]:[]};
    else if(path==="/cells/notes/jobs/preview")result={occurrences:[{utc:at,local:"2026-11-01T09:00:00+05:30",timezone:"Asia/Kolkata"}],timezone:"Asia/Kolkata"};
    else if(path==="/cells/notes/jobs/morning"){
      if(method==="PUT"){configured=true;definition=body;deleted=null;revision++;}
      if(method==="PATCH"){definition={...definition,...body};revision++;}
      if(method==="DELETE"){deleted=at;definition.enabled=false;result={deleted:true};}else result={job:metadata()};
    }else if(path.endsWith("/definition")){definitionReads++;result={definition};}
    else if(path.endsWith("/versions"))result={versions:[{...metadata(),id,revision,effective_from:at,effective_until:null,created_by:id}]};
    else if(path.endsWith(`/versions/${id}`)){definitionReads++;result={definition,version:id,revision};}
    else if(path.endsWith("/run")){queued=true;if(lostRun){lostRun=false;return route.abort("failed");}result={run_id:id};}
    else if(path.endsWith("/retry")){run.status="pending";run.replays++;result={run_id:id,replay:run.replays};}
    else if(path.endsWith("/runs"))result={runs:queued?[run]:[],next:null};
    else if(path.endsWith(`/runs/${id}`)){detailReads++;attemptCursor=url.searchParams.get("after");result={run,attempts:[{id:attemptCursor?older:id,attempt:1,replay:0,status:"failed",started_at:at,finished_at:at,duration_ms:20,invocation_id:null,response_status:null,error_code:"sql_failed",output:{text:"<script>window.jobOutputRan=true</script>"},error:{message:"private-job-error"},logs:[attemptCursor?"older-job-log":"<script>window.jobLogRan=true</script>"]}],next:attemptCursor?null:older};}
    return route.fulfill({json:result});
  });
  await page.goto("/cells/notes/jobs");
  await page.getByRole("button",{name:"Create job",exact:true}).click();
  await page.getByLabel("Job name",{exact:true}).fill("morning");
  await page.getByLabel("Timezone",{exact:true}).fill("Asia/Kolkata");
  await page.getByRole("button",{name:"Preview schedule",exact:true}).click();
  await expect(page.getByRole("cell",{name:"2026-11-01T09:00:00+05:30 · Asia/Kolkata",exact:true})).toBeVisible();
  expect(mutations.find(m=>m.path.endsWith("/preview"))?.body).toEqual({schedule:{cron:"0 9 * * *",timezone:"Asia/Kolkata"},count:5});
  await page.getByRole("combobox",{name:"Job target",exact:true}).click();await page.getByRole("option",{name:"SQL",exact:true}).click();
  await page.getByLabel("Job SQL",{exact:true}).fill("select 'private-job-source'");
  await page.getByRole("button",{name:"Create scheduled job",exact:true}).click();
  await expect(page.getByRole("button",{name:"Run job now",exact:true})).toBeVisible();
  expect(definitionReads).toBe(0);expect(detailReads).toBe(0);expect(definition.allow_overlap).toBe(false);
  await expect(page.getByText("private-job-source",{exact:false})).toHaveCount(0);
  await page.getByRole("button",{name:"Run job now",exact:true}).click();
  await page.getByRole("button",{name:"Queue job run",exact:true}).click();
  await expect(page.getByText("Could not reach Silicon Cells.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Queue job run",exact:true}).click();
  await expect(page.getByText(`Queued job run ${id}`,{exact:true})).toBeVisible();
  const starts=mutations.filter(m=>m.path.endsWith("/run"));expect(starts).toHaveLength(2);expect(starts[0].key).toBeTruthy();expect(starts[0].key).toBe(starts[1].key);
  await page.getByRole("button",{name:"Open job run",exact:true}).click();
  await page.getByText("Execution output and error",{exact:true}).click();await page.getByText("Job logs",{exact:true}).click();
  await expect(page.locator("pre").filter({hasText:"private-job-error"})).toBeVisible();
  await expect(page.getByText("<script>window.jobLogRan=true</script>",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>Object.hasOwn(window,"jobOutputRan")||Object.hasOwn(window,"jobLogRan"))).toBe(false);
  await page.getByRole("button",{name:"Older job attempts",exact:true}).click();await expect.poll(()=>attemptCursor).toBe(older);
  await page.getByRole("button",{name:"Pause job",exact:true}).click();await expect(page.getByRole("button",{name:"Resume job",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Replay failed job run",exact:true}).click();await page.getByRole("button",{name:"Queue job replay",exact:true}).click();await expect.poll(()=>run.replays).toBe(1);
  await page.getByRole("button",{name:`Inspect revision ${revision}`,exact:true}).click();await expect(page.getByLabel("Job SQL",{exact:true})).toHaveValue("select 'private-job-source'");expect(definitionReads).toBe(1);
  await page.getByRole("combobox",{name:"Schedule type",exact:true}).click();await page.getByRole("option",{name:"One-off time",exact:true}).click();
  await page.getByLabel("One-off timestamp",{exact:true}).fill("2026-11-01T09:00:00+05:30");
  await page.getByRole("combobox",{name:"Job target",exact:true}).click();await page.getByRole("option",{name:"Cell function",exact:true}).click();
  await page.getByRole("combobox",{name:"Job function",exact:true}).click();await page.getByRole("option",{name:"daily-report",exact:true}).click();
  await page.getByLabel("Function input (JSON)",{exact:true}).fill('{"private":"job-input"}');
  await page.getByRole("button",{name:"Save job version",exact:true}).click();await expect.poll(()=>definition.schedule).toEqual({at:new Date(at).toISOString()});expect(definition.target).toEqual({function:"daily-report",input:{private:"job-input"}});
  await page.getByRole("button",{name:"Delete job",exact:true}).click();await page.getByRole("button",{name:"Delete job and retain history",exact:true}).click();await expect(page.getByRole("button",{name:"Restore job",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Run job now",exact:true})).toHaveCount(0);await expect(page.getByRole("button",{name:"Replay failed job run",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Restore job",exact:true}).click();await page.getByRole("button",{name:"Save job version",exact:true}).click();await expect.poll(()=>deleted).toBeNull();
  const stored=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(stored).not.toContain("private-job-source");expect(stored).not.toContain("private-job-error");expect(stored).not.toContain("job-input");
});
