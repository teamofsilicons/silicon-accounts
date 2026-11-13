import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";

test("functions keep unsaved source, retry one invocation, and render response bytes as text",async({page})=>{
  await mock(page,true);
  const version="12345678-1234-1234-1234-123456789abc",older="12345678-1234-1234-1234-123456789abd";
  const at="2026-10-28T12:00:00Z";
  let active:string|null=version,created=false,failed=false;
  const mutations:{path:string;method:string;body:Record<string,unknown>|null;key:string|undefined}[]=[];
  const summary=()=>({name:"hello",active_version:active,created_at:at,updated_at:at});
  let definition={runtime:"javascript",entrypoint:"index.ts",files:{"index.ts":Buffer.from("export default () => new Response('hello');").toString("base64")},timeout_ms:30000,memory_mb:128,allowed_origins:[] as string[],routes:[] as {method:string;path:string}[]};
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace("/api/cells", ""),method=request.method();
    const body=request.postData()?request.postDataJSON():null;
    if(method!=="GET")mutations.push({path,method,body,key:request.headers()["idempotency-key"]});
    let result:unknown={};
    if(path==="/cells/notes")result={cell:{uuid:version,cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
    else if(path==="/cells/notes/functions")result={functions:created?[summary()]:[]};
    else if(path==="/cells/notes/functions/hello"){
      if(method==="PUT"){definition=body;created=true;active=version;result={function:summary(),version};}
      else if(method==="DELETE"){active=null;result={disabled:true};}
      else result={function:summary(),versions:[{id:version,created_at:at,created_by:"c:author"},{id:older,created_at:at,created_by:"c:author"}]};
    }else if(path.includes("/versions/"))result={version,definition};
    else if(path.endsWith("/invocations"))result={invocations:[]};
    else if(path.endsWith("/activate")){active=body.version;result={function:summary()};}
    else if(path.endsWith("/invoke")){
      if(!failed){failed=true;return route.abort("failed");}
      result={status:200,headers:{"content-type":"text/html"},body:Buffer.from('<script>window.functionResponseRan=true</script><b>private result</b>').toString("base64"),invocation_id:version};
    }
    return route.fulfill({json:result});
  });
  await page.goto("/cells/notes/functions");
  await page.getByRole("button",{name:"Create function",exact:true}).click();
  await page.getByLabel("Function name",{exact:true}).fill("hello");
  await page.getByLabel("Source: index.ts",{exact:true}).fill("export default () => new Response('saved');");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading",{name:"Discard these changes?"})).toBeVisible();
  await page.getByRole("button",{name:"Keep editing",exact:true}).click();
  await expect(page.getByLabel("Function name",{exact:true})).toHaveValue("hello");
  await page.getByRole("button",{name:"Deploy version",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Invoke",exact:true})).toBeVisible();
  const deployed=mutations.find(item=>item.method==="PUT");
  expect(deployed?.key).toBeTruthy();
  expect(Buffer.from((deployed?.body?.files as Record<string,string>)["index.ts"],"base64").toString()).toContain("'saved'");
  await page.getByRole("button",{name:"Invoke once",exact:true}).click();
  await expect(page.getByText("Could not reach Silicon Cells.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Invoke once",exact:true}).click();
  await expect(page.getByText(/HTTP 200 · Invocation/)).toBeVisible();
  expect(mutations.filter(item=>item.path.endsWith("/invoke")).map(item=>item.key)).toEqual([expect.any(String),mutations.find(item=>item.path.endsWith("/invoke"))!.key]);
  await expect(page.getByText('<script>window.functionResponseRan=true</script><b>private result</b>',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>Object.hasOwn(window,"functionResponseRan"))).toBe(false);
  await page.getByRole("button",{name:"Activate",exact:true}).last().click();
  await expect.poll(()=>active).toBe(older);
  await page.getByRole("button",{name:"Disable function",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Disable function",exact:true}).click();
  await expect.poll(()=>active).toBeNull();
  await expect(page.getByRole("button",{name:"Invoke once",exact:true})).toHaveCount(0);
});

test("compiled Wasm uploads preserve binary bytes through retry and version editing",async({page})=>{
 await mock(page,true);
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
 const version="12345678-1234-1234-1234-123456789abc",at="2026-10-28T12:00:00Z";
 const command=Buffer.from([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,10,1,6,95,115,116,97,114,116,0,0,10,4,1,2,0,11]);
 const opaque=Buffer.concat([command,Buffer.from([0,7,1,120,0,255,128,192,254])]);
 type Definition={runtime:string;entrypoint:string;files:Record<string,string>;timeout_ms:number;memory_mb:number;allowed_origins:string[];routes:unknown[]};
 let definition:Definition|null=null,lost=true;
 const requests:{body:Definition;key:string|undefined}[]=[];
 const summary=()=>({name:"compiled",active_version:version,created_at:at,updated_at:at});
 await page.route("**/api/cells/**",async route=>{
  const request=route.request(),path=new URL(request.url()).pathname.replace("/api/cells", ""),method=request.method();let result:unknown={};
  if(path==="/cells/notes")result={cell:{uuid:version,cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
  else if(path==="/cells/notes/functions")result={functions:definition?[summary()]:[],max_timeout_ms:100000};
  else if(path==="/cells/notes/functions/compiled"){
   if(method==="PUT"){
    definition=request.postDataJSON();requests.push({body:definition!,key:request.headers()["idempotency-key"]});
    if(lost){lost=false;return route.abort("failed");}
    result={function:summary(),version};
   }else result={function:summary(),versions:[{id:version,created_at:at,created_by:"c:author"}]};
  }else if(path.endsWith(`/versions/${version}`))result={version,definition};
  else if(path.endsWith("/invocations"))result={invocations:[]};
  else throw new Error(`Unexpected Wasm request ${method} ${path}`);
  await route.fulfill({json:result});
 });
 await page.goto("/cells/notes/functions");
 await page.getByRole("button",{name:"Upload WebAssembly",exact:true}).click();
 const dialog=page.getByRole("dialog");
 await dialog.getByLabel("Function name",{exact:true}).fill("compiled");
 await expect(dialog.getByRole("button",{name:"Deploy version",exact:true})).toBeDisabled();
 const picker=dialog.getByLabel("Compiled WebAssembly file",{exact:true});
 await picker.setInputFiles({name:"native.wasm",mimeType:"application/wasm",buffer:Buffer.from([127,69,76,70,1,0,0,0])});
 await expect(dialog.getByText("Choose a compiled core WebAssembly module, not source text, a component or a native executable.",{exact:true})).toBeVisible();
 await expect(dialog.getByRole("button",{name:"Deploy version",exact:true})).toBeDisabled();expect(requests).toHaveLength(0);
 await picker.setInputFiles({name:"endpoint.wasm",mimeType:"application/wasm",buffer:opaque});
 await expect(dialog.getByRole("status")).toContainText("endpoint.wasm");
 await expect(dialog.getByRole("textbox",{name:/Source:/})).toHaveCount(0);
 await dialog.getByRole("button",{name:"Deploy version",exact:true}).click();
 await expect(dialog.getByText("Could not reach Silicon Cells.",{exact:true})).toBeVisible();
 await dialog.getByRole("button",{name:"Deploy version",exact:true}).click();
 await expect(page.getByRole("heading",{name:"Invoke",exact:true})).toBeVisible();
 expect(requests).toHaveLength(2);expect(requests[0]?.key).toBeTruthy();expect(requests[1]?.key).toBe(requests[0]?.key);
 for(const {body} of requests){expect(body.runtime).toBe("wasm");expect(body.entrypoint).toBe("endpoint.wasm");expect(Object.keys(body.files)).toEqual(["endpoint.wasm"]);expect(Buffer.from(body.files["endpoint.wasm"]!,"base64")).toEqual(opaque);}
 await page.getByRole("button",{name:"Edit active version",exact:true}).click();
 await expect(dialog.getByRole("textbox",{name:/Source:/})).toHaveCount(0);
 await picker.setInputFiles({name:"clean.wasm",mimeType:"application/wasm",buffer:command});
 await expect(dialog.getByRole("status")).toContainText("clean.wasm");
 await dialog.getByRole("button",{name:"Deploy version",exact:true}).click();
 await expect(dialog).toHaveCount(0);
 expect(Object.keys(requests[2]!.body.files)).toEqual(["clean.wasm"]);expect(Buffer.from(requests[2]!.body.files["clean.wasm"]!,"base64")).toEqual(command);
 // A valid module can contain only UTF-8 bytes; it must still never become an editable text source.
 await page.getByRole("button",{name:"Inspect source",exact:true}).click();
 await expect(dialog.getByRole("status")).toContainText("Binary preserved unchanged");
 await expect(dialog.getByRole("textbox",{name:/Source:/})).toHaveCount(0);
 await dialog.getByLabel("Memory (MiB)",{exact:true}).fill("256");
 await dialog.getByRole("button",{name:"Deploy version",exact:true}).click();
 await expect(dialog).toHaveCount(0);
 expect(requests[3]!.body.memory_mb).toBe(256);expect(Buffer.from(requests[3]!.body.files["clean.wasm"]!,"base64")).toEqual(command);
 expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain(opaque.toString("base64"));
 expect(errors).toEqual([]);
});
