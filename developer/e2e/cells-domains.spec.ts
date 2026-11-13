import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";
test("domain setup shows exact DNS records, preserves uncertain keys and separates requested checks from active status",async({page})=>{
  const browserErrors:string[]=[];page.on("pageerror",error=>browserErrors.push(error.message));page.on("console",message=>{if(message.type()==="error"&&message.text().includes("HTML"))browserErrors.push(message.text());});
  await mock(page,true);
  const id="12345678-1234-1234-1234-123456789abc",at="2026-11-01T03:30:00Z",base="https://notes.cells.example";
  let domain:null|{hostname:string;generation:number;status:string;checks:{type:string;name:string;expected:string;status:string;observed?:string[]}[];error_code:string|null;verified_until:string|null;certificate_expires_at:string|null;checked_at:string|null;next_check_at:string;created_at:string;updated_at:string}=null;
  let lost=true,activate=false;
  const changes:{method:string;path:string;body:unknown;key:string|undefined}[]=[];
  await page.route("**/api/cells/**",async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace("/api/cells",""),method=request.method();let result:unknown={};
    if(path==="/cells/notes")result={cell:{uuid:id,cell_id:"notes",name:"Notes",status:"active",url:domain?.status==="active"?`https://${domain.hostname}`:base,created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
    else if(path==="/cells/notes/domain"&&method==="GET"){
      if(activate&&domain){domain.status="active";domain.error_code=null;domain.verified_until=at;domain.certificate_expires_at=at;domain.checks=domain.checks.map(record=>({...record,status:"valid"}));}
      result={domain,base_url:base,url:domain?.status==="active"?`https://${domain.hostname}`:base};
    }else if(path==="/cells/notes/domain"||path==="/cells/notes/domain/check"){
      changes.push({method,path,body:request.postData()?request.postDataJSON():null,key:request.headers()["idempotency-key"]});
      if(method==="PUT"){
        const hostname=request.postDataJSON().hostname as string;
        domain={hostname,generation:2,status:"waiting",checks:[{type:"CNAME",name:hostname,expected:"notes.cells.example",status:"unchecked"},{type:"TXT",name:`_silicon-cells.${hostname}`,expected:"silicon-cells=fixture-proof",status:"unchecked"}],error_code:null,verified_until:null,certificate_expires_at:null,checked_at:null,next_check_at:at,created_at:at,updated_at:at};
        if(lost){lost=false;return route.abort("failed");}
        result={domain};
      }else if(method==="POST"&&domain){domain.status="failed";domain.error_code="<script>window.domainRan=true</script>";domain.checks[0]!.status="wrong";domain.checks[0]!.observed=["wrong.example"];result={domain};}
      else{domain=null;result={domain:null,url:base};}
    }else throw new Error(`Unexpected request ${path}`);
    await route.fulfill({json:result});
  });
  await page.goto("/cells/notes/domains");await expect(page.getByRole("heading",{name:"Assign a custom hostname",exact:true})).toBeVisible();
  await page.getByLabel("Custom hostname",{exact:true}).fill("https://api.example.com");await page.getByRole("button",{name:"Save hostname",exact:true}).click();await expect(page.getByText("Enter a hostname without a scheme, port, path, wildcard or whitespace.",{exact:true})).toBeVisible();expect(changes).toHaveLength(0);
  await page.getByLabel("Custom hostname",{exact:true}).fill("api.example.com");await page.getByRole("button",{name:"Save hostname",exact:true}).click();await expect.poll(()=>changes.length).toBe(1);
  await page.getByRole("button",{name:"Save hostname",exact:true}).click();await expect(page.getByRole("heading",{name:"Required DNS records",exact:true})).toBeVisible();expect(changes[0]?.key).toBe(changes[1]?.key);
  await expect(page.getByText("silicon-cells=fixture-proof",{exact:true})).toBeVisible();await expect(page.getByText("_silicon-cells.api.example.com",{exact:true})).toBeVisible();await expect(page.getByText("Not verified",{exact:true})).toHaveCount(2);
  await page.getByRole("button",{name:"Check DNS and HTTPS",exact:true}).click();await expect(page.getByText("Verification requested. Refresh status to see the result.",{exact:true})).toBeVisible();await expect(page.getByText("Reason: <script>window.domainRan=true</script>",{exact:true})).toBeVisible();expect(await page.evaluate(()=>"domainRan" in window)).toBe(false);
  activate=true;await page.getByRole("button",{name:"Refresh domain status",exact:true}).click();await expect(page.getByText("https://api.example.com",{exact:true})).toBeVisible();await expect(page.getByText("CNAME · Valid",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Remove custom hostname",exact:true}).click();await page.getByRole("button",{name:"Remove hostname",exact:true}).click();await expect(page.getByRole("heading",{name:"Assign a custom hostname",exact:true})).toBeVisible();await expect(page.getByRole("heading",{name:"Required DNS records",exact:true})).toHaveCount(0);
  expect(browserErrors).toEqual([]);expect(changes.every(change=>change.key)).toBe(true);expect(await page.locator('input[type="password"]').count()).toBe(0);
});
