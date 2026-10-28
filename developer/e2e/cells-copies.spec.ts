import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";
test("test copies retain uncertain create keys, keep credentials transient and require reset confirmation",async({page})=>{
  await mock(page,true);
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  const parent="12345678-1234-1234-1234-123456789abc",id="12345678-1234-1234-1234-123456789abd",operation="12345678-1234-1234-1234-123456789abe",at="2026-10-28T12:00:00Z";
  const cell={uuid:parent,cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}};
  let exists=false,lost=true,paused=true,status="active";
  const changes:{method:string;path:string;body:unknown;key:string|undefined}[]=[];
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace("/api/cells","");
    let result:unknown={};
    const copy={parent_uuid:parent,parent_cell_id:"notes",copy:"qa",cell:{...cell,uuid:id,cell_id:"notes--qa",name:"QA",status,url:"https://notes--qa.cells.example"},background_paused:paused,last_operation:operation,prerequisites:["apps_require_explicit_link"],created_at:at,updated_at:at};
    if(path==="/cells/notes")result={cell};
    else if(path==="/cells/notes/copies"&&request.method()==="GET")result={copies:exists?[copy]:[]};
    else if(path==="/cells/notes/copies"&&request.method()==="POST"){
      changes.push({method:request.method(),path,body:request.postDataJSON(),key:request.headers()["idempotency-key"]});
      if(lost){lost=false;return route.abort("failed");}
      exists=true;result={copy,operation:{id:operation,status:"queued",error_code:null},created_cell:{cell:copy.cell,publishable_key:"fixture-publishable",secret_key:"fixture-private-copy-secret",database_url:"postgres://fixture:private@localhost/qa",database_password:"fixture-private-copy-password"}};
    }else if(path==="/cells/notes/copies/qa"&&request.method()==="PATCH"){
      changes.push({method:request.method(),path,body:request.postDataJSON(),key:request.headers()["idempotency-key"]});paused=request.postDataJSON().background_paused;result={copy:{...copy,background_paused:paused}};
    }else if(path==="/cells/notes/copies/qa/reset"){
      changes.push({method:request.method(),path,body:request.postDataJSON(),key:request.headers()["idempotency-key"]});paused=true;status="restoring";result={copy:{...copy,background_paused:true,cell:{...copy.cell,status}},operation:{id:operation,status:"queued",error_code:null}};
    }else throw new Error(`Unexpected copies request ${path}`);
    await route.fulfill({json:result});
  });
  await page.goto("/cells/notes/copies");await expect(page.getByRole("heading",{name:"Test copies",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Create test copy",exact:true}).click();await page.getByLabel("Copy name",{exact:true}).fill("qa--nested");
  await page.getByRole("button",{name:"Create copy",exact:true}).click();await expect(page.getByText("Use a copy name of 1–30 lowercase letters, digits or hyphens, without consecutive hyphens.",{exact:true})).toBeVisible();expect(changes).toHaveLength(0);
  await page.getByLabel("Copy name",{exact:true}).fill("qa");await page.getByLabel("Display name (optional)",{exact:true}).fill("QA");await page.getByRole("button",{name:"Create copy",exact:true}).click();await expect(page.getByText("Could not reach Silicon Cells.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Create copy",exact:true}).click();await expect(page.getByRole("heading",{name:"Save the copy credentials",exact:true})).toBeVisible();expect(changes[0]?.key).toBe(changes[1]?.key);expect(changes[1]?.body).toEqual({copy:"qa",name:"QA"});
  expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain("fixture-private-copy");
  await page.getByRole("button",{name:"I’ve saved these credentials",exact:true}).click();expect(await page.content()).not.toContain("fixture-private-copy");
  await page.getByRole("button",{name:"Resume background work",exact:true}).click();await expect(page.getByRole("heading",{name:"Resume background work?",exact:true})).toBeVisible();await page.getByRole("button",{name:"Confirm background resume",exact:true}).click();await expect(page.getByRole("button",{name:"Pause background work",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Reset copy",exact:true}).click();await page.getByLabel("Confirm test-copy cell ID",{exact:true}).fill("notes");await page.getByRole("button",{name:"Confirm copy reset",exact:true}).click();await expect(page.getByText("Type the exact test-copy cell ID to confirm.",{exact:true})).toBeVisible();expect(changes).toHaveLength(3);
  await page.getByLabel("Confirm test-copy cell ID",{exact:true}).fill("notes--qa");await page.getByRole("button",{name:"Confirm copy reset",exact:true}).click();await expect(page.getByRole("cell",{name:"restoring Background paused Recovery status",exact:true})).toBeVisible();expect(changes.at(-1)?.body).toEqual({confirm_cell_id:"notes--qa"});
  await page.reload();expect(await page.content()).not.toContain("fixture-private-copy");expect(errors).toEqual([]);
});

test("copy-only authors manage background work without fetching the parent",async({page})=>{
  await mock(page,true);
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  const at="2026-10-28T12:00:00Z";
  const cell={uuid:"12345678-1234-1234-1234-123456789abd",cell_id:"notes--qa",name:"QA",status:"active",url:"https://notes--qa.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}};
  let paused=true;
  const changes:unknown[]=[];
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace("/api/cells","");
    if(path==="/cells/notes--qa")return route.fulfill({json:{cell}});
    if(path!=="/cells/notes--qa/copy")throw new Error(`Copy-only session fetched ${path}`);
    if(request.method()==="PATCH"){changes.push(request.postDataJSON());paused=request.postDataJSON().background_paused;expect(request.headers()["idempotency-key"]).toBeTruthy();}
    await route.fulfill({json:{copy:{parent_uuid:"12345678-1234-1234-1234-123456789abc",parent_cell_id:"notes",copy:"qa",cell,background_paused:paused,last_operation:null,prerequisites:[],created_at:at,updated_at:at}}});
  });
  await page.goto("/cells/notes--qa/copies");
  await expect(page.getByRole("heading",{name:"Test copy",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Resume background work",exact:true}).click();
  expect(changes).toHaveLength(0);
  await page.getByRole("button",{name:"Confirm background resume",exact:true}).click();
  await page.getByRole("button",{name:"Pause background work",exact:true}).click();
  await expect(page.getByRole("button",{name:"Resume background work",exact:true})).toBeVisible();
  expect(changes).toEqual([{background_paused:false},{background_paused:true}]);expect(errors).toEqual([]);
});
