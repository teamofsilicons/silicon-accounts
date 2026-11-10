import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";

test("Interface sign-in settings save detailed pages and preview the draft",async({page})=>{
  await mock(page,true);
  let saved:Record<string,unknown>|undefined;
  const item={interface_id:"potato",name:"Potato",logo_url:"http://localhost:8670/v1/interfaces/potato/uploads/abc-123",kind:"unverified",app_ids:["write"],app_descriptions:{},redirect_uris:[],allowed_origins:[],branding:{},signin_config:{},description:"",website_url:null,cover_url:null,images:[],platforms:[],links:[],published:false,revision:1,creators:[],releases:[]};
  await page.route("**/api/interfaces/**",async route=>{
    const request=route.request();const path=new URL(request.url()).pathname;
    if(path==="/api/interfaces/me")return route.fulfill({json:{eligibility:{verified:false,trusted:false},invites:[]}});
    if(path==="/api/interfaces/interfaces/potato"&&request.method()==="PATCH"){saved=request.postDataJSON();Object.assign(item,saved,{revision:2});return route.fulfill({json:{interface:item}});}
    if(path==="/api/interfaces/interfaces/potato")return route.fulfill({json:{interface:item}});
    if(path.endsWith("/readiness"))return route.fulfill({json:{ready:false,missing:[]}});
    if(path.endsWith("/uploads"))return route.fulfill({json:{uploads:[]}});
    if(path.endsWith("/history"))return route.fulfill({json:{events:[]}});
    if(path.endsWith("/requests"))return route.fulfill({json:{requests:[]}});
    if(path.endsWith("/invites"))return route.fulfill({json:{invites:[]}});
    return route.fulfill({json:{interfaces:[]}});
  });
  await page.route("**/api/cells/**",route=>route.fulfill({json:route.request().url().includes("/interfaces/")?{cell:null}:{cells:[]}}));
  await page.goto("/interfaces/potato");
  await page.getByRole("tab",{name:"Sign-in",exact:true}).click();
  await page.getByText("Who can sign in",{exact:true}).click();
  await page.getByLabel("Allow new accounts").uncheck();
  await page.getByLabel("Allowed email domains").fill("example.test\nother.test");
  await page.getByText("Details and sign-in pages",{exact:true}).click();
  await page.getByRole("combobox",{name:"Email",exact:true}).selectOption("required");
  await page.getByRole("combobox",{name:"Phone",exact:true}).selectOption("optional");
  await page.getByLabel("Customize the details pages").check();
  await page.getByRole("button",{name:"Add page"}).click();
  await page.getByLabel("Title",{exact:true}).first().fill("Contact details");
  await page.getByLabel("Show a details review page").check();
  await page.getByText("More sign-in appearance",{exact:true}).click();
  await page.getByRole("combobox",{name:/^Text font/}).selectOption("Inter");
  await page.getByText("Preview sign-in pages",{exact:true}).click();
  await expect(page.getByLabel(/Preview of the Potato sign-in/)).toBeVisible();
  await expect(page.getByLabel(/Preview of the Potato sign-in/).locator("img").first()).toHaveAttribute("src","/api/interfaces/interfaces/potato/uploads/abc-123");
  await page.getByRole("button",{name:"Save changes",exact:true}).click();
  await expect.poll(()=>saved).toBeDefined();
  const signin=saved!.signin_config as {allow_signup:boolean;allowed_email_domains:string[];required_fields:string[];optional_fields:string[];flow:{review:boolean;steps:{title:string|null}[]}};
  expect(signin.allow_signup).toBe(false);
  expect(signin.allowed_email_domains).toEqual(["example.test","other.test"]);
  expect(signin.required_fields).toEqual(["email"]);expect(signin.optional_fields).toEqual(["phone"]);
  expect(signin.flow.review).toBe(true);expect(signin.flow.steps).toHaveLength(2);expect(signin.flow.steps[0]?.title).toBe("Contact details");
  for(const excluded of ["google","apple","branding","device_flow"])expect(signin).not.toHaveProperty(excluded);
  expect((saved!.branding as {font_family:string}).font_family).toBe("Inter");
});
