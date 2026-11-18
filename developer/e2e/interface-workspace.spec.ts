import {test,expect,type Page} from "@playwright/test";
import {mock} from "./fixtures";

async function workspace(page:Page, kind:"unverified"|"verified"="unverified") {
  await mock(page,true);
  let saved:Record<string,unknown>|undefined;
  const item={interface_id:"potato",name:"Potato",logo_url:null,kind,app_ids:["write"],app_descriptions:{},redirect_uris:[],allowed_origins:[],branding:{},signin_config:{},description:"Original description",website_url:null,cover_url:null,images:[],platforms:[],links:[],published:false,revision:1,creators:[],releases:[]};
  await page.route("**/api/interfaces/**",async route=>{
    const request=route.request();const path=new URL(request.url()).pathname;
    if(path==="/api/interfaces/me")return route.fulfill({json:{eligibility:{verified:false,trusted:false},invites:[]}});
    if(path==="/api/interfaces/interfaces/potato"&&request.method()==="PATCH"){saved=request.postDataJSON();Object.assign(item,saved,{revision:item.revision+1});return route.fulfill({json:{interface:item}});}
    if(path==="/api/interfaces/interfaces/potato")return route.fulfill({json:{interface:item}});
    if(path.endsWith("/readiness"))return route.fulfill({json:{ready:false,missing:[]}});
    if(path.endsWith("/uploads"))return route.fulfill({json:{uploads:[]}});
    if(path.endsWith("/history"))return route.fulfill({json:{events:[]}});
    if(path.endsWith("/requests"))return route.fulfill({json:{requests:[]}});
    if(path.endsWith("/invites"))return route.fulfill({json:{invites:[]}});
    return route.fulfill({json:{interfaces:[]}});
  });
  await page.route("**/api/cells/**",route=>route.fulfill({json:route.request().url().includes("/interfaces/")?{cell:null}:{cells:[]}}));
  return ()=>saved;
}

for(const viewport of [{width:1440,height:1000},{width:390,height:844}])test(`Interface workspace keeps drafts and links across tabs at ${viewport.width}px`,async({page},info)=>{
  await page.setViewportSize(viewport);
  const saved=await workspace(page);
  await page.goto("/interfaces/potato#interface-uploads");
  await expect(page.getByRole("tab",{name:"Uploads",exact:true})).toHaveAttribute("data-state","active");
  await expect(page.getByRole("heading",{name:"Uploads",exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Overview",exact:true}).click();
  await expect(page.getByLabel("Interface type")).toHaveCount(0);
  await page.waitForTimeout(600); // Let the Silicon UI selection animation settle before visual capture.
  await page.screenshot({path:info.outputPath(`interface-overview-${viewport.width}.png`),fullPage:true});
  await page.getByLabel("Description",{exact:true}).fill("Keep this draft");
  await page.locator('input[type="file"]').first().setInputFiles({name:"logo.png",mimeType:"image/png",buffer:Buffer.from("fixture")});
  await expect(page.getByText("logo.png",{exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Sign-in",exact:true}).click();
  await expect(page).toHaveURL(/#interface-sign-in$/);
  await page.waitForTimeout(600);
  await page.screenshot({path:info.outputPath(`interface-sign-in-${viewport.width}.png`),fullPage:true});
  await page.getByLabel("Redirect URIs").fill("https://example.test/callback");
  await page.getByRole("tab",{name:"Releases",exact:true}).click();
  await page.getByLabel("Version",{exact:true}).fill("1.2.3");
  await page.goBack();
  await expect(page.getByLabel("Redirect URIs")).toHaveValue("https://example.test/callback");
  await page.goBack();
  await expect(page.getByLabel("Description",{exact:true})).toHaveValue("Keep this draft");
  await expect(page.getByText("logo.png",{exact:true})).toBeVisible();
  await page.goForward();
  await expect(page.getByLabel("Redirect URIs")).toHaveValue("https://example.test/callback");
  await page.goForward();
  await expect(page.getByLabel("Version",{exact:true})).toHaveValue("1.2.3");
  await page.getByRole("button",{name:"Save changes",exact:true}).click();
  await expect.poll(saved).toBeDefined();
  expect(saved()?.description).toBe("Keep this draft");
  expect(saved()?.redirect_uris).toEqual(["https://example.test/callback"]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test("an existing Cell deep link opens the Cell tab",async({page})=>{
  await workspace(page);
  await page.goto("/interfaces/potato#interface-cell");
  await expect(page.getByRole("tab",{name:"Cell",exact:true})).toHaveAttribute("data-state","active");
  await expect(page.getByRole("heading",{name:"Sign in with a cell"})).toBeVisible();
});

test("an existing elevated interface retains its type even when eligibility changes",async({page})=>{
  const saved=await workspace(page,"verified");
  await page.goto("/interfaces/potato");
  await expect(page.getByLabel("Interface type")).toContainText("Verified");
  await page.getByLabel("Name",{exact:true}).fill("New name");
  await page.getByRole("button",{name:"Save changes",exact:true}).click();
  await expect.poll(saved).toBeDefined();
  expect(saved()?.kind).toBe("verified");
});
