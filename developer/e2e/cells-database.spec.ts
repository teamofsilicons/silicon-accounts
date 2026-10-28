import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";
test("database editor edits rows, changes schema, saves SQL and keeps source transient",async({page})=>{
 await mock(page,true);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 const at="2026-10-28T12:00:00Z",id="12345678-1234-1234-1234-123456789abc";
 const cell={uuid:id,cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}};
 let rows=[{id:1,value:"<script>private-row</script>"}],saved=false,lost=true,enabled=false,detailReads=0;
 let definition={name:"My query",sql:"SELECT 'private-saved-query'",execute:false};
 const changes:{path:string;body:Record<string,unknown>;key:string|undefined}[]=[];
 const table={name:"notes",kind:"r",rls:true,columns:[{name:"id",data_type:"integer",nullable:false,default:null,identity:"",generated:""},{name:"value",data_type:"text",nullable:true,default:null,identity:"",generated:""}],primary_key:["id"],indexes:[],foreign_keys:[],policies:[]};
 await page.route("**/api/cells/**",async route=>{
  const req=route.request(),path=new URL(req.url()).pathname.replace("/api/cells","");let result:unknown={};
  if(req.method()!=="GET")changes.push({path,body:req.postDataJSON()??{},key:req.headers()["idempotency-key"]});
  if(path==="/cells/notes")result={cell};
  else if(path==="/cells/notes/tables")result={tables:[{...table,columns:table.columns.map(c=>({name:c.name,type:c.data_type,nullable:c.nullable}))}]};
  else if(path==="/cells/notes/database/tables/notes")result=table;
  else if(path==="/cells/notes/database/rows/query")result={rows,snapshots:rows.map(row=>JSON.stringify(row)),cells:rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,JSON.stringify(value)]))),next_offset:null};
  else if(path==="/cells/notes/database/rows/change"){
   if(lost){lost=false;return route.abort("failed");}const body=req.postDataJSON();if(body.action==="update")rows=[{...rows[0]!,...body.values}];else if(body.action==="delete")rows=[];result={rows:[],rows_affected:1};
  }else if(path==="/cells/notes/schema")result={rows:[],rows_affected:0};
  else if(path==="/cells/notes/import")result={rows:[],rows_affected:1};
  else if(path==="/cells/notes/sql")result={rows:[{value:"private-result"}],rows_affected:1};
  else if(path==="/cells/notes/database/queries"&&req.method()==="GET")result={queries:saved?[{id,name:definition.name,execute:false,created_at:at,updated_at:at}]:[]};
  else if(path==="/cells/notes/database/queries"&&req.method()==="POST"){saved=true;definition=req.postDataJSON();result={query:{id,name:definition.name,execute:false,created_at:at,updated_at:at}};}
  else if(path===`/cells/notes/database/queries/${id}`){detailReads++;result={query:{id,name:definition.name,execute:false,created_at:at,updated_at:at},definition};}
  else if(path==="/cells/notes/database/extensions")result={extensions:[{name:"vector",title:"Vectors",available_version:"0.8",installed_version:enabled?"0.8":null,schema:enabled?"extensions":null,enabled}]};
  else if(path==="/cells/notes/database/extensions/vector"){enabled=true;result={extension:{name:"vector",title:"Vectors",available_version:"0.8",installed_version:"0.8",schema:"extensions",enabled}};}
  else if(path==="/cells/notes/database/connections")result={direct:{url:new URL(req.url()).searchParams.get("include_password")==="true"?"postgres://user:private-db-password@localhost/notes":"postgres://user@localhost/notes",mode:"direct"},pooled:null,database_password:new URL(req.url()).searchParams.get("include_password")==="true"?"private-db-password":null};
  else if(path==="/cells/notes/database/reference")result={base_url:"https://notes.cells.example/rest/v1",tables:[],functions:[],authentication:{apikey:"Required"},examples:{read:"GET /notes?limit=100"}};
  else if(path==="/cells/notes/migrations")result={migrations:[{id:1,name:"first",sql:"CREATE TABLE private-migration",source:"sql",author_uuid:id,created_at:at}]};
  else throw new Error(`Unexpected database request ${path}`);await route.fulfill({json:result});
 });
 await page.goto("/cells/notes/database");await page.getByRole("button",{name:"notes",exact:true}).click();await page.getByRole("button",{name:"Load rows",exact:true}).click();await expect(page.getByText("<script>private-row</script>",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Edit row 1",exact:true}).click();const dialog=page.getByRole("dialog");await dialog.getByLabel("value",{exact:true}).fill("updated-row");await dialog.getByRole("button",{name:"Save row",exact:true}).click();await expect(dialog.getByText("Could not reach Silicon Cells.",{exact:true})).toBeVisible();await dialog.getByRole("button",{name:"Save row",exact:true}).click();await expect(page.getByRole("cell",{name:"updated-row",exact:true})).toBeVisible();
 const edits=changes.filter(c=>c.path.endsWith("/rows/change"));expect(edits).toHaveLength(2);expect(edits[0]?.key).toBe(edits[1]?.key);expect(edits[1]?.body).toMatchObject({primary_key:["id"],original:JSON.stringify({id:1,value:"<script>private-row</script>"}),values:{value:"updated-row"}});
 await page.getByLabel("Import table data",{exact:true}).setInputFiles({name:"rows.csv",mimeType:"text/csv",buffer:Buffer.from('id,value\n2,"CSV, value"\n')});await expect(page.getByText("Imported 1 rows.",{exact:true})).toBeVisible();expect(changes.find(change=>change.path.endsWith("/import"))?.body).toEqual({table:"notes",rows:[{id:"2",value:"CSV, value"}],conflict_columns:[]});
 await page.getByRole("button",{name:"Add access rule",exact:true}).click();await dialog.getByLabel("Rule name",{exact:true}).fill("readers");await dialog.getByRole("button",{name:"Apply change",exact:true}).click();expect(changes.at(-1)?.body).toMatchObject({action:"rule",preset:"public_read"});
 await page.getByLabel("SQL statement",{exact:true}).fill("SELECT 'private-saved-query'");await page.getByLabel("Query name",{exact:true}).fill("My query");await page.getByRole("button",{name:"Save query",exact:true}).click();await expect(page.getByText("Query saved.",{exact:true})).toBeVisible();expect(detailReads).toBe(0);
 await page.getByRole("button",{name:"Clear draft",exact:true}).click();await page.getByRole("button",{name:"Load My query",exact:true}).click();await expect(page.getByLabel("SQL statement",{exact:true})).toHaveValue("SELECT 'private-saved-query'");expect(detailReads).toBe(1);
 await page.getByRole("button",{name:"Run SQL",exact:true}).click();await expect(page.getByRole("cell",{name:"private-result",exact:true})).toBeVisible();
 const download=page.waitForEvent("download");await page.getByRole("button",{name:"Export query CSV",exact:true}).click();expect((await download).suggestedFilename()).toBe("notes-query.csv");
 await page.getByRole("button",{name:"Enable extension",exact:true}).click();await expect(page.getByRole("button",{name:"Enabled",exact:true})).toBeDisabled();
 await page.getByRole("button",{name:"Generate API reference",exact:true}).click();await expect(page.getByText("https://notes.cells.example/rest/v1",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Reveal database credentials",exact:true}).click();await expect(page.getByRole("button",{name:"Hide credentials",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain("private-");await page.getByRole("button",{name:"Hide credentials",exact:true}).click();await page.reload();expect(await page.content()).not.toContain("private-saved-query");expect(await page.content()).not.toContain("private-result");expect(errors).toEqual([]);
});
