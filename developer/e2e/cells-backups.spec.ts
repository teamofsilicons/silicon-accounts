import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";
test("backups require explicit replacement, retain uncertain restore keys and reveal new credentials privately",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await mock(page,true);
  const id="12345678-1234-1234-1234-123456789abc",backup="12345678-1234-1234-1234-123456789abd",operation="12345678-1234-1234-1234-123456789abe",fresh="12345678-1234-1234-1234-123456789abf",at="2026-10-28T12:00:00Z";
  let status="active",lost=true,restored=false;
  const changes:{body:Record<string,unknown>;key:string|undefined}[]=[];
  const cell={uuid:id,cell_id:"notes",name:"Notes",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}};
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace("/api/cells","");let result:unknown={};
    const restore={id:operation,source_cell:id,destination_cell:restored?fresh:id,source_backup:backup,source_point:null,before_backup:restored?null:backup,status:"pending",error_code:null,created_at:at,updated_at:at,completed_at:null};
    if(path==="/cells/notes")result={cell:{...cell,status}};
    else if(path==="/cells/notes/backups"&&request.method()==="GET")result={backups:[{id:backup,kind:"manual",status:"ready",requested_at:at,point_at:at,completed_at:at,expires_at:"2026-11-04T12:00:00Z",size_bytes:1024,sha256:"a".repeat(64),error_code:null}],recovery:{status:"ready",earliest_at:"2026-10-27T12:00:00Z",latest_at:at,error_code:null}};
    else if(path==="/cells/notes/restores")result={restores:changes.length?[restore]:[]};
    else if(path==="/cells/notes/backups/restore"){
      changes.push({body:request.postDataJSON(),key:request.headers()["idempotency-key"]});
      if(lost){lost=false;return route.abort("failed");}
      restored=true;result={restore:{...restore,destination_cell:fresh},created_cell:{cell:{...cell,uuid:fresh,cell_id:"recovered",name:"Recovered",status:"restoring",url:"https://recovered.cells.example"},publishable_key:"fixture-publishable",secret_key:"fixture-private-backup-secret",database_url:"postgres://fixture:private@localhost/recovered",database_password:"fixture-private-password"}};
    }else throw new Error(`Unexpected request ${path}`);
    await route.fulfill({json:result});
  });
  await page.goto("/cells/notes/backups");
  await expect(page.getByRole("heading",{name:"Database backups",exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:"Download database"})).toHaveAttribute("href",`/api/cells/cells/notes/backups/${backup}/download`);
  await page.getByRole("button",{name:"Restore backup",exact:true}).click();
  await page.getByLabel("Confirm current cell ID",{exact:true}).fill("wrong");
  await page.getByRole("button",{name:"Start restore",exact:true}).click();await expect(page.getByText("Type the exact current cell ID to confirm replacement.",{exact:true})).toBeVisible();expect(changes).toHaveLength(0);
  await page.getByRole("combobox",{name:"Recovery source",exact:true}).click();await page.getByRole("option",{name:"Point in time",exact:true}).click();await page.getByLabel("Recovery time (your local timezone)",{exact:true}).fill("2026-10-20T12:00");
  await page.getByRole("button",{name:"Start restore",exact:true}).click();await expect(page.getByText("Choose a time inside the available recovery window.",{exact:true})).toBeVisible();expect(changes).toHaveLength(0);
  await page.getByRole("combobox",{name:"Recovery source",exact:true}).click();await page.getByRole("option",{name:"Saved backup",exact:true}).click();await page.getByRole("combobox",{name:"Destination",exact:true}).click();await page.getByRole("option",{name:"Restore into a new cell",exact:true}).click();await page.getByLabel("New cell name",{exact:true}).fill("Recovered");await page.getByLabel("New cell ID (optional)",{exact:true}).fill("recovered");
  await page.getByRole("button",{name:"Start restore",exact:true}).click();await expect.poll(()=>changes.length).toBe(1);await expect(page.getByText("Could not reach Silicon Cells.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Start restore",exact:true}).click();await expect(page.getByRole("heading",{name:"Save the new cell credentials",exact:true})).toBeVisible();expect(changes[0]?.key).toBe(changes[1]?.key);
  expect(changes[1]?.body).toEqual({source:{type:"backup",id:backup},destination:{type:"new",name:"Recovered",cell_id:"recovered"}});
  expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain("fixture-private");
  await page.getByRole("button",{name:"I’ve saved these credentials",exact:true}).click();await expect(page.getByRole("heading",{name:"Save the new cell credentials",exact:true})).toHaveCount(0);
  status="restoring";await page.reload();await expect(page.getByRole("heading",{name:"Restore history",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Create backup",exact:true})).toBeDisabled();expect(await page.content()).not.toContain("fixture-private");
  expect(errors).toEqual([]);
});

test("failed restore retry survives a lost acknowledgment without replaying a new operation",async({page})=>{
  await mock(page,true);const id="12345678-1234-1234-1234-123456789abc",operation="12345678-1234-1234-1234-123456789abd",backup="12345678-1234-1234-1234-123456789abe",at="2026-10-28T12:00:00Z";
  let lost=true,status="failed";const keys:(string|undefined)[]=[];
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace("/api/cells","");let result:unknown={};
    const restore={id:operation,source_cell:id,destination_cell:id,source_backup:backup,source_point:null,before_backup:null,status,error_code:status==="failed"?"restore_file_unavailable":null,created_at:at,updated_at:at,completed_at:status==="failed"?at:null};
    if(path==="/cells/notes")result={cell:{uuid:id,cell_id:"notes",name:"Notes",url:"https://notes.cells.example",status:"failed",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
    else if(path==="/cells/notes/backups")result={backups:[],recovery:{status:"unavailable",earliest_at:null,latest_at:null,error_code:null}};
    else if(path==="/cells/notes/restores")result={restores:[restore]};
    else if(path===`/cells/notes/restores/${operation}/retry`){keys.push(request.headers()["idempotency-key"]);if(lost){lost=false;return route.abort("failed");}status="queued";result={restore:{...restore,status,error_code:null,completed_at:null}};}
    else throw new Error(`Unexpected request ${path}`);
    await route.fulfill({json:result});
  });
  await page.goto("/cells/notes/backups");await page.getByRole("button",{name:"Retry restore",exact:true}).click();await expect(page.getByRole("heading",{name:"Retry this restore?",exact:true})).toBeVisible();await page.getByRole("button",{name:"Confirm restore retry",exact:true}).click();await expect.poll(()=>keys.length).toBe(1);await expect(page.getByRole("dialog").getByText("Could not reach Silicon Cells.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Confirm restore retry",exact:true}).click();await expect(page.getByText("Restore queued again. Refresh status to follow recovery.",{exact:true})).toBeVisible();expect(keys[0]).toBe(keys[1]);await expect(page.getByRole("button",{name:"Retry restore",exact:true})).toHaveCount(0);
});
