import {test,expect,type Page} from "@playwright/test";
import {mock} from "./fixtures";

const at="2026-10-28T12:00:00Z";
const makeCell=(id:string,status="active")=>({uuid:`uuid-${id}`,cell_id:id,name:id,status,url:`https://${id}.cells.teamofsilicons.com`,created_at:at,deleted_at:status==="deleted"?new Date().toISOString():null,settings:{allowed_origins:[],redirect_urls:[]}});
async function interfaceFixture(page:Page){
  const item={interface_id:"potato",name:"Potato",logo_url:null,kind:"unverified",app_ids:["write"],app_descriptions:{},redirect_uris:[],allowed_origins:[],branding:{},signin_config:{},description:"",website_url:null,cover_url:null,images:[],platforms:[],links:[],published:false,revision:1,creators:[],releases:[]};
  await page.route("**/api/interfaces/**",route=>{const path=new URL(route.request().url()).pathname;if(path==="/api/interfaces/me")return route.fulfill({json:{eligibility:{verified:false,trusted:false},invites:[]}});if(path==="/api/interfaces/interfaces/potato")return route.fulfill({json:{interface:item}});if(path.endsWith("/readiness"))return route.fulfill({json:{ready:false,missing:[]}});if(path.endsWith("/uploads"))return route.fulfill({json:{uploads:[]}});if(path.endsWith("/history"))return route.fulfill({json:{events:[]}});if(path.endsWith("/requests"))return route.fulfill({json:{requests:[]}});if(path.endsWith("/invites"))return route.fulfill({json:{invites:[]}});return route.fulfill({json:{interfaces:[]}});});
}
for(const kind of ["app","interface"] as const)test(`${kind} requires an explicit Cell ID to create and can connect an existing Cell`,async({page})=>{
  await mock(page,true);if(kind==="interface")await interfaceFixture(page);
  const requests:unknown[]=[];let linked:ReturnType<typeof makeCell>|null=null;
  await page.route("**/api/cells/**",route=>{const req=route.request(),path=new URL(req.url()).pathname;
    if(path.endsWith("/availability"))return route.fulfill({json:{available:true}});
    if(path==="/api/cells/cells")return route.fulfill({json:{cells:[makeCell("existing"),...(linked&&linked.cell_id!=="existing"?[linked]:[])]}});
    if(path.endsWith(kind==="app"?"/apps/test-app/cell":"/interfaces/potato/cell")){
      if(req.method()==="POST"){const body=req.postDataJSON() as {cell_id?:string;create_cell_id?:string};requests.push(body);linked=makeCell(body.cell_id??body.create_cell_id!);}
      return route.fulfill({json:{cell:linked,sign_in_links:[]}});
    }return route.fulfill({json:{}});
  });
  await page.goto(kind==="app"?"/apps/test-app/sign-in":"/interfaces/potato#interface-cell");
  const section=kind==="app"?page.getByRole("region",{name:"Your app’s backend"}):page.getByRole("region",{name:"Sign in with a cell"});
  await expect(section.getByRole("button",{name:"Create cell",exact:true})).toBeVisible();
  expect(requests).toEqual([]);
  await section.getByRole("button",{name:"Create cell",exact:true}).click();
  await section.getByLabel("Cell ID",{exact:true}).fill("my-cell");
  await expect(section.getByText("Cell URL: https://my-cell.cells.teamofsilicons.com")).toBeVisible();
  await expect(section.getByText("This Cell ID is available.")).toBeVisible();
  await section.getByRole("button",{name:"Create cell and connect"}).click();
  await expect.poll(()=>requests.length).toBe(1);expect(requests[0]).toEqual({create_cell_id:"my-cell"});
  await expect(section.getByRole("link",{name:/Open this cell/})).toBeVisible();
  await section.getByLabel("Existing cell").click();await page.getByRole("option",{name:"existing · existing"}).click();
  await section.getByRole("button",{name:"Use selected cell"}).click();
  await expect.poll(()=>requests.length).toBe(2);expect(requests[1]).toEqual({cell_id:"existing"});
});

test("deleted Cells are separate and restore from the banner",async({page})=>{
  await mock(page,true);let status="deleted",restores=0;
  await page.route("**/api/cells/**",route=>{const req=route.request(),path=new URL(req.url()).pathname;
    if(path==="/api/cells/cells")return route.fulfill({json:{cells:[makeCell("live"),makeCell("old",status)]}});
    if(path==="/api/cells/invitations")return route.fulfill({json:{invitations:[]}});
    if(path==="/api/cells/cells/old/restore"&&req.method()==="POST"){restores++;status="active";return route.fulfill({json:{cell:makeCell("old")}});}
    if(path==="/api/cells/cells/old")return route.fulfill({json:{cell:makeCell("old",status)}});
    return route.fulfill({json:{}});
  });
  await page.goto("/cells");const deleted=page.getByRole("region",{name:"Deleted cells"});await expect(deleted.getByText("old",{exact:true}).first()).toBeVisible();
  await deleted.getByRole("link",{name:"View deleted cell"}).click();
  const banner=page.getByRole("status").filter({hasText:"This cell is deleted."});await expect(banner).toBeVisible();await banner.getByRole("button",{name:"Restore cell"}).click();await expect.poll(()=>restores).toBe(1);await expect(banner).toHaveCount(0);
});

test("Cell ID change uses the admin endpoint and opens the returned address",async({page})=>{
  await mock(page,true);let rename:unknown,renameKey:string|undefined;let finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;});
  await page.route("**/api/cells/**",async route=>{const req=route.request(),path=new URL(req.url()).pathname;
    if(path==="/api/cells/cells/availability")return route.fulfill({json:{available:true}});
    if(path==="/api/cells/cells/old/rename"&&req.method()==="POST"){rename=req.postDataJSON();renameKey=req.headers()["idempotency-key"];await pending;return route.fulfill({json:{cell:makeCell("resolved-id"),changed:true}});}
    if(path==="/api/cells/cells/old"||path==="/api/cells/cells/resolved-id")return route.fulfill({json:{cell:makeCell(path.endsWith("old")?"old":"resolved-id")}});
    if(path.endsWith("/keys"))return route.fulfill({json:{keys:[]}});if(path.endsWith("/secrets"))return route.fulfill({json:{secrets:[]}});
    return route.fulfill({json:{}});
  });
  await page.goto("/cells/old/settings");
  await expect(page.getByText("Only the Cell admin can change its ID.")).toBeVisible();
  await page.getByLabel("New Cell ID").fill("new-id");
  await expect(page.getByText("New Cell URL: https://new-id.cells.teamofsilicons.com")).toBeVisible();
  await page.getByRole("button",{name:"Change Cell ID"}).click();
  await expect(page.getByLabel("New Cell ID")).toBeDisabled();finish();
  await expect(page).toHaveURL(/\/cells\/resolved-id\/settings$/);expect(rename).toEqual({cell_id:"new-id"});expect(renameKey).toBeTruthy();
});

test("a denied or expired restore stays deleted and shows the server reason",async({page})=>{
  await mock(page,true);
  await page.route("**/api/cells/**",route=>{const req=route.request(),path=new URL(req.url()).pathname;
    if(path==="/api/cells/cells/old/restore")return route.fulfill({status:409,json:{error:{code:"restore_expired",message:"The restoration period has ended."}}});
    if(path==="/api/cells/cells/old")return route.fulfill({json:{cell:makeCell("old","deleted")}});
    return route.fulfill({json:{}});
  });
  await page.goto("/cells/old");await page.getByRole("button",{name:"Restore cell"}).click();
  await expect(page.getByRole("alert").filter({hasText:"The restoration period has ended."})).toBeVisible();
  await expect(page.getByText("This cell is deleted.")).toBeVisible();
});


test("a denied Cell ID change keeps the current page and shows the error",async({page})=>{
  await mock(page,true);
  await page.route("**/api/cells/**",route=>{const path=new URL(route.request().url()).pathname;
    if(path==="/api/cells/cells/availability")return route.fulfill({json:{available:true}});
    if(path==="/api/cells/cells/old/rename")return route.fulfill({status:403,json:{error:{code:"forbidden",message:"Only the Cell admin can change its ID."}}});
    if(path==="/api/cells/cells/old")return route.fulfill({json:{cell:makeCell("old")}});
    if(path.endsWith("/keys"))return route.fulfill({json:{keys:[]}});if(path.endsWith("/secrets"))return route.fulfill({json:{secrets:[]}});return route.fulfill({json:{}});
  });
  await page.goto("/cells/old/settings");await page.getByLabel("New Cell ID").fill("new-id");await page.getByRole("button",{name:"Change Cell ID"}).click();
  await expect(page.getByRole("alert").filter({hasText:"Only the Cell admin can change its ID."})).toBeVisible();
  await expect(page).toHaveURL(/\/cells\/old\/settings$/);await expect(page.getByLabel("New Cell ID")).toBeEnabled();
});

test("a renamed Cell shows its stable cookie sign-in address when different",async({page})=>{
  await mock(page,true);
  await page.route("**/api/cells/**",route=>{const path=new URL(route.request().url()).pathname;
    if(path==="/api/cells/cells/renamed")return route.fulfill({json:{cell:{...makeCell("renamed"),auth_url:"https://original.cells.teamofsilicons.com"}}});
    if(path==="/api/cells/cells/unchanged")return route.fulfill({json:{cell:{...makeCell("unchanged"),auth_url:"https://unchanged.cells.teamofsilicons.com"}}});
    return route.fulfill({json:{}});
  });
  await page.goto("/cells/renamed");await expect(page.getByText("Authentication URL",{exact:true})).toBeVisible();
  await expect(page.getByText("Use this address for cookie-based sign-in; it stays the same when the Cell ID changes.")).toBeVisible();
  await page.goto("/cells/unchanged");await expect(page.getByText("Authentication URL",{exact:true})).toHaveCount(0);
});
