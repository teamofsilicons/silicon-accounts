import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";
test("realtime author channel controls preserve keys and show metadata without credentials",async({page})=>{
  await mock(page,true);const id="12345678-1234-1234-1234-123456789abc",at="2026-11-01T03:30:00Z",name="team:one/notes";
  let configured=false,definition={private:true,enabled:true},lose=true,includeClosed=false;
  const mutations:{method:string;path:string;body:unknown;key:string|undefined}[]=[];
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace("/api/cells",""),method=request.method();let result:unknown={};
    if(path==="/cells/notes")result={cell:{uuid:id,cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
    else if(path==="/cells/notes/realtime/channels")result={channels:configured?[{name,...definition,created_at:at}]:[]};
    else if(path===`/cells/notes/realtime/channels/${encodeURIComponent(name)}`){
      mutations.push({method,path,body:request.postData()?request.postDataJSON():null,key:request.headers()["idempotency-key"]});
      if(method==="PUT"){configured=true;definition=request.postDataJSON();if(lose){lose=false;return route.abort("failed");}result={channel:{name,...definition,created_at:at}};}
      else{configured=false;result={deleted:true};}
    }else if(path==="/cells/notes/realtime/connections"){
      includeClosed=url.searchParams.get("include_closed")==="true";result={connections:[{id,key_id:id,user_uuid:null,app_id:null,connected_at:at,last_seen:at,closed_at:includeClosed?at:null,close_reason:includeClosed?"<script>window.realtimeRan=true</script>":null,sent_messages:3,received_messages:4}]};
    }else throw new Error(`Unexpected author request ${path}`);
    await route.fulfill({json:result});
  });
  await page.goto("/cells/notes/realtime");await expect(page.getByText("Anonymous · Key",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:"Create channel",exact:true}).click();await page.getByLabel("Channel name",{exact:true}).fill(name);
  await expect(page.getByRole("checkbox",{name:"Private channel",exact:true})).toBeChecked();await page.getByRole("button",{name:"Save channel",exact:true}).click();
  await expect.poll(()=>mutations.length).toBe(1);await page.getByRole("button",{name:"Save channel",exact:true}).click();await expect(page.getByRole("button",{name:`Edit channel ${name}`,exact:true})).toBeVisible();expect(mutations[0]?.key).toBe(mutations[1]?.key);expect(mutations[1]?.body).toEqual({private:true,enabled:true});
  await page.getByRole("button",{name:`Edit channel ${name}`,exact:true}).click();await page.getByRole("checkbox",{name:"Channel enabled",exact:true}).uncheck();await page.getByRole("button",{name:"Save channel",exact:true}).click();await expect.poll(()=>definition.enabled).toBe(false);
  await page.getByRole("checkbox",{name:"Include closed connections",exact:true}).check();await expect.poll(()=>includeClosed).toBe(true);await expect(page.getByText("<script>window.realtimeRan=true</script>",{exact:false})).toBeVisible();expect(await page.evaluate(()=>"realtimeRan" in window)).toBe(false);
  await page.getByRole("button",{name:`Delete channel ${name}`,exact:true}).click();await page.getByRole("button",{name:"Delete channel and permissions",exact:true}).click();await expect(page.getByText("No realtime channels configured.",{exact:true})).toBeVisible();
  expect(mutations.every(mutation=>mutation.key)).toBe(true);expect(await page.locator('input[type="password"]').count()).toBe(0);
});
