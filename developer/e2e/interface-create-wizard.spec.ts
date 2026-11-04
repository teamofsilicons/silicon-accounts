import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";

test("creation shows review before creating and preserves the secret when logo upload needs a retry",async({page})=>{
  await mock(page,true);
  let created=0, uploaded=0, savedLogo="", createdKind:unknown;
  const item={interface_id:"test-interface",name:"Test Interface",kind:"unverified",app_ids:["dm"],revision:1};
  await page.route("**/api/interfaces/**",async route=>{
    const req=route.request(), path=new URL(req.url()).pathname;
    if(path==="/api/interfaces/me")return route.fulfill({json:{eligibility:{verified:false,trusted:false},invites:[]}});
    if(path==="/api/interfaces/interfaces" && req.method()==="POST") {created++;createdKind=req.postDataJSON().kind;return route.fulfill({json:{interface:item,interface_secret:"sif_test-secret"}});}
    if(path.endsWith("/uploads") && req.method()==="POST") {
      uploaded++;
      if(uploaded===1)return route.fulfill({status:500,json:{error:{message:"Upload interrupted"}}});
      return route.fulfill({json:{upload:{id:"img-1",url:"https://example.test/image.png",filename:"logo.png",category:"image"}}});
    }
    if(path.endsWith("/test-interface") && req.method()==="PATCH") {savedLogo=req.postDataJSON().logo_url;return route.fulfill({json:{interface:{...item,revision:2,logo_url:savedLogo}}});}
    return route.fulfill({json:{interfaces:[]}});
  });
  await page.goto("/interfaces");
  await page.getByRole("button",{name:"Create interface",exact:true}).first().click();
  await page.getByLabel("Name",{exact:true}).fill("Test Interface");
  await expect(page.getByLabel("Interface ID")).toHaveValue("test-interface");
  await page.locator('input[type="file"]').setInputFiles({name:"logo.png",mimeType:"image/png",buffer:Buffer.from("test image")});
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(page.getByLabel("Interface type")).toHaveCount(0);
  await page.getByLabel("App IDs").fill("dm");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Review and create"})).toBeVisible();
  await expect(page.locator("dt",{hasText:"Type"})).toHaveCount(0);
  expect(created).toBe(0);
  await page.getByRole("button",{name:"Back",exact:true}).click();
  await expect(page.getByLabel("App IDs")).toHaveValue("dm");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByRole("button",{name:"Create interface",exact:true}).click();
  await expect(page.getByRole("group",{name:"Save your interface secret"})).toBeVisible();
  await expect(page.getByText(/logo could not be saved/)).toBeVisible();
  await page.getByRole("button",{name:"Retry logo upload"}).click();
  await expect(page.getByText(/Your logo is ready/)).toBeVisible();
  expect(created).toBe(1);expect(createdKind).toBe("unverified");expect(uploaded).toBe(2);expect(savedLogo).toBe("https://example.test/image.png");
});

test("creators with additional eligibility can choose an available type",async({page})=>{
  await mock(page,true);
  let body:Record<string,unknown>|undefined;
  await page.route("**/api/interfaces/**",async route=>{
    const req=route.request(), path=new URL(req.url()).pathname;
    if(path==="/api/interfaces/me")return route.fulfill({json:{eligibility:{verified:false,trusted:true},invites:[]}});
    if(path==="/api/interfaces/interfaces" && req.method()==="POST") {body=req.postDataJSON();return route.fulfill({json:{interface:{interface_id:"trusted-interface",name:"Trusted Interface",kind:"trusted",app_ids:[],revision:1},interface_secret:"sif_test-secret"}});}
    return route.fulfill({json:{interfaces:[]}});
  });
  await page.goto("/interfaces");
  await page.getByRole("button",{name:"Create interface",exact:true}).first().click();
  await page.getByLabel("Name",{exact:true}).fill("Trusted Interface");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  const type=page.getByLabel("Interface type");
  await expect(type).toBeVisible();
  await expect(type.locator("option")).toHaveText(["Unverified","Trusted"]);
  await type.selectOption("trusted");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Review and create"})).toBeVisible();
  await expect(page.locator("dt",{hasText:"Type"})).toBeVisible();
  await page.getByRole("button",{name:"Create interface",exact:true}).click();
  await expect(page.getByRole("group",{name:"Save your interface secret"})).toBeVisible();
  expect(body?.kind).toBe("trusted");expect(body?.app_ids).toEqual([]);
});

for(const scenario of [
  {verified:true,trusted:false,options:["Unverified","Verified"]},
  {verified:true,trusted:true,options:["Unverified","Verified","Trusted"]},
]) test(`type choices reflect eligibility: verified=${scenario.verified}, trusted=${scenario.trusted}`,async({page})=>{
  await mock(page,true);
  await page.route("**/api/interfaces/**",async route=>{
    if(new URL(route.request().url()).pathname==="/api/interfaces/me")return route.fulfill({json:{eligibility:{verified:scenario.verified,trusted:scenario.trusted},invites:[]}});
    return route.fulfill({json:{interfaces:[]}});
  });
  await page.goto("/interfaces");
  await page.getByRole("button",{name:"Create interface",exact:true}).first().click();
  await page.getByLabel("Name",{exact:true}).fill("Example Interface");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(page.getByLabel("Interface type").locator("option")).toHaveText(scenario.options);
  await expect(page.getByLabel("Interface type")).toHaveValue("unverified");
});
