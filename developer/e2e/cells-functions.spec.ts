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
