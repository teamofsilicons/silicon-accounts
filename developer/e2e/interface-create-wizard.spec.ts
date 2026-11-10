import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";

test("creation shows review before creating and preserves the secret when logo upload needs a retry",async({page})=>{
  await mock(page,true);
  let created=0, uploaded=0, savedLogo="";
  const item={interface_id:"test-interface",name:"Test Interface",kind:"unverified",app_ids:["dm"],revision:1};
  await page.route("**/api/interfaces/**",async route=>{
    const req=route.request(), path=new URL(req.url()).pathname;
    if(path==="/api/interfaces/me")return route.fulfill({json:{eligibility:{verified:false,trusted:false},invites:[]}});
    if(path==="/api/interfaces/interfaces" && req.method()==="POST") {created++;return route.fulfill({json:{interface:item,interface_secret:"sif_test-secret"}});}
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
  await page.getByLabel("App IDs").fill("dm");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Review and create"})).toBeVisible();
  expect(created).toBe(0);
  await page.getByRole("button",{name:"Back",exact:true}).click();
  await expect(page.getByLabel("App IDs")).toHaveValue("dm");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByRole("button",{name:"Create interface",exact:true}).click();
  await expect(page.getByRole("group",{name:"Save your interface secret"})).toBeVisible();
  await expect(page.getByText(/logo could not be saved/)).toBeVisible();
  await page.getByRole("button",{name:"Retry logo upload"}).click();
  await expect(page.getByText(/Your logo is ready/)).toBeVisible();
  expect(created).toBe(1);expect(uploaded).toBe(2);expect(savedLogo).toBe("https://example.test/image.png");
});
