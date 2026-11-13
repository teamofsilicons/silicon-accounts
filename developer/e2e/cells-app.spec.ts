import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";

test("app setup uses the published Cells SDK namespace and the selected cell",async({page})=>{
  await mock(page,true);
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  const cell={uuid:"12345678-1234-1234-1234-123456789abc",cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:"2026-10-28T12:00:00Z",deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}};
  await page.route("**/api/cells/**",async route=>{
    const path=new URL(route.request().url()).pathname.replace("/api/cells","");
    if(path==="/cells")return route.fulfill({json:{cells:[cell]}});
    if(path==="/apps/test-app/cell")return route.fulfill({json:{cell,publishable_key:"fixture-publishable",sign_in_links:[{redirect_to:"https://frontend.example/callback",sign_in:"https://notes.cells.example/auth/login?app=test-app",sign_up:"https://notes.cells.example/auth/signup?app=test-app"}]}});
    throw new Error(`Unexpected Cells request ${path}`);
  });
  await page.goto("/apps/test-app/sign-in");
  const section=page.getByRole("region",{name:"Your app’s backend",exact:true});
  await expect(section.locator("pre")).toContainText("import { createClient } from '@teamofsilicons/cells'");
  await expect(section.locator("pre")).toContainText('createClient("https://notes.cells.example"');
  await expect(section.locator("pre")).toContainText('app: "test-app"');
  await expect(section.locator("pre")).not.toContainText("@silicon/cells");
  await expect(section.getByRole("button",{name:"Copy JavaScript",exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
