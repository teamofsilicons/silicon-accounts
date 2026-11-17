import {test,expect,type Page} from '@playwright/test';
import {mock,makeApp,account} from './fixtures';
const peer='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const member={uuid:peer,id:'si:assistant',display_name:'Assistant',pfp_url:'https://example.test/avatar.png'};
async function platform(page:Page,initial:Parameters<typeof mock>[2]={}){
 await mock(page,true,initial);
 const writes:{path:string;body:Record<string,unknown>}[]=[];
 const org={org_id:'example',name:'Example Organization',admin:true,teams:['drafts'],permissions:{apps:['create','manage'],interfaces:['create','manage'],cells:['create','manage']}};
 let contact={uuid:peer,account:member,name:'Saved Assistant',trust:200,note:'Keep my note',photo_id:'portrait'};
 await page.route('**/api/contacts/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;
  if(req.method()!=='GET')writes.push({path,body:req.postDataJSON()});
  if(path.endsWith('/connection'))return route.fulfill({json:{connected:true}});
  if(path.includes('/photos/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>'});
  if(path.endsWith('/lookup'))return route.fulfill({json:member});
  if(req.method()==='POST'){contact={...contact,...req.postDataJSON()};return route.fulfill({json:contact});}
  return route.fulfill({json:{items:[contact],total:1}});
 });
 await page.route('**/api/organizations/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;
  if(req.method()!=='GET'){writes.push({path,body:req.postDataJSON()});return route.fulfill({json:{ok:true}});}
  return route.fulfill({json:path.endsWith('/publishing')?{account_uuid:account.uuid,organizations:[org]}:path.endsWith('/publishing-policy')?{publishing_policy:{grants:[]}}:{members:[member],teams:[{id:'drafts',name:'Draft team'}]}});
 });
 for(const service of ['apps','interfaces','cells'])await page.route(`**/api/${service}/people`,route=>route.fulfill({json:{items:service==='apps'?[{...member,sent:3,received:0,last_invited_at:'2026-01-01T00:00:00Z'},{uuid:other,id:'c:recent',display_name:'Recent Person',sent:0,received:5,last_invited_at:'2026-11-01T00:00:00Z'}]:[]}}));
 return writes;
}
test('organization publishing grants apply to all resource kinds',async({page})=>{
 const writes=await platform(page);await page.goto('/organizations');
 await expect(page.getByRole('heading',{name:'Organization publishing'})).toBeVisible();
 await page.getByRole('button',{name:'Draft team Team',exact:true}).click();
 await page.getByRole('button',{name:'Add permission grant'}).click();
 await page.getByRole('checkbox',{name:'Publish and deploy',exact:true}).check();
 await page.getByRole('button',{name:'Save publishing permissions'}).click();
 await expect(page.getByText('Publishing permissions saved.')).toBeVisible();
 expect(writes.at(-1)?.body).toEqual({action:'publishing_policy_update',publishing_policy:{grants:[{subject:{type:'team',id:'drafts'},resources:[],permissions:['create','publish']}]}});
});
test('invites rank sent invitations twice and display saved names, photos and trust',async({page})=>{
 const writes=await platform(page);await page.goto('/apps/test-app/authors');
 const input=page.getByRole('combobox',{name:'Invite an author'});await input.focus();
 await expect(page.getByRole('listbox',{name:'People suggestions'}).getByRole('option').first()).toContainText('Saved Assistant');
 await input.fill('assistnt');await page.getByRole('option',{name:/Saved Assistant/}).click();
 await expect(input).toHaveValue('si:assistant');
 await expect(page.locator('img[src="/api/contacts/photos/portrait"]').first()).toBeVisible();
 await page.getByRole('button',{name:'Edit saved contact'}).click();
 await page.getByLabel('Trust (1–255)').fill('240');await page.getByRole('button',{name:'Save contact',exact:true}).click();
 await expect(page.getByText('si:assistant · Trust 240')).toBeVisible();
 expect(writes.find(w=>w.path==='/api/contacts/contacts')?.body).toMatchObject({id:peer,trust:240,name:'Saved Assistant',note:'Keep my note',photo_id:'portrait'});
});
test('delete requires app ID and supports restore in the workspace',async({page})=>{
 await platform(page);let deleted=false,restored=false;const app=makeApp();
 await page.route('**/api/apps/apps**',async route=>{const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/api/apps/apps'&&url.searchParams.get('deleted')==='true')return route.fulfill({json:{items:deleted?[{...app,deleted_at:'2026-11-17T00:00:00Z',restore_until:'2099-12-17T00:00:00Z'}]:[]}});
  if(url.pathname==='/api/apps/apps/test-app'&&req.method()==='DELETE'){deleted=true;return route.fulfill({json:{deleted:true}});}
  if(url.pathname.endsWith('/restore')){deleted=false;restored=true;return route.fulfill({json:{app}});}
  return route.fallback();
 });
 await page.goto('/apps/test-app/authors');
 const remove=page.getByRole('button',{name:'Delete app',exact:true});await expect(remove).toBeDisabled();
 await page.getByLabel('Type test-app to confirm deletion').fill('test-app');await remove.click();
 await expect(page).toHaveURL(/\/apps$/);await expect(page.getByRole('heading',{name:'Deleted apps'})).toBeVisible();
 await page.getByRole('button',{name:'Restore app'}).click();await expect(page.getByRole('heading',{name:'Deleted apps'})).toHaveCount(0);expect(restored).toBe(true);
});
test('organization cell creation preserves publisher and omits credential reveal on mobile',async({page})=>{
 await page.setViewportSize({width:390,height:844});await platform(page);let body:Record<string,unknown>|undefined;
 await page.route('**/api/cells/**',async route=>{const req=route.request(),url=new URL(req.url());
  if(url.pathname.endsWith('/people'))return route.fallback();
  if(url.pathname.endsWith('/availability'))return route.fulfill({json:{available:true}});
  if(url.pathname==='/api/cells/cells'&&req.method()==='POST'){body=req.postDataJSON();return route.fulfill({json:{cell:{uuid:peer,cell_id:'org-cell',name:'Org Cell',organization_id:'example',status:'active',url:'https://org-cell.cells.example',created_at:'2026-11-17',settings:{allowed_origins:[],redirect_urls:[]}},publishable_key:'pk_fixture'}});}
  return route.fulfill({json:{cells:[],invitations:[]}});
 });
 await page.goto('/cells');await page.getByRole('button',{name:'Create cell',exact:true}).click();
 await page.getByRole('combobox',{name:'Publisher',exact:true}).click();await page.getByRole('option',{name:'Example Organization'}).click();
 await page.getByLabel('Name',{exact:true}).fill('Org Cell');await page.getByLabel('Cell ID',{exact:true}).fill('org-cell');
 await page.getByRole('dialog').getByRole('button',{name:'Create cell',exact:true}).click();
 await expect(page.getByText(/Organization cell created/)).toBeVisible();expect(body?.organization_id).toBe('example');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('organization readers can filter shared files by saved contact without editing access',async({page})=>{
 await platform(page);
 const queries:Record<string,unknown>[]=[];
 const cell={uuid:other,cell_id:'shared-cell',name:'Shared Cell',organization_id:'example',permissions:{read:true,edit:false,publish:false,manage:false},status:'active',url:'https://shared-cell.cells.example',created_at:'2026-11-17',settings:{allowed_origins:[],redirect_urls:[]}};
 await page.route('**/api/cells/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(path.endsWith('/people'))return route.fallback();
  if(path==='/api/cells/cells/shared-cell')return route.fulfill({json:{cell}});
  if(path.endsWith('/storage/buckets'))return route.fulfill({json:{buckets:[{id:'documents'}]}});
  if(path.endsWith('/storage-api/files/documents/query')){
   expect(req.method()).toBe('POST');queries.push(req.postDataJSON());
   return route.fulfill({json:{files:[{id:'file',bucket:'documents',name:'shared.txt',owner_id:peer,size:12,content_type:'text/plain',updated_at:'2026-11-17'}],next:null}});
  }
  return route.fulfill({json:{}});
 });
 await page.goto('/cells/shared-cell/files');
 await expect(page.getByRole('cell',{name:'shared.txt text/plain'})).toBeVisible();
 await expect(page.getByRole('cell').filter({hasText:'Saved Assistant'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Upload file',exact:true})).toBeDisabled();
 await expect(page.getByRole('link',{name:'Download',exact:true})).toBeVisible();
 await page.getByRole('combobox',{name:'Show files'}).click();await page.getByRole('option',{name:'Shared with me',exact:true}).click();
 await expect.poll(()=>queries.at(-1)?.shared_with_me).toBe(true);
 await page.getByRole('combobox',{name:'Show files'}).click();await page.getByRole('option',{name:'From saved contacts',exact:true}).click();
 await expect.poll(()=>queries.at(-1)?.owner_ids).toBe(peer);
 expect(queries.at(-1)?.shared_with_me).toBe(false);
});

test('private personal app sharing keeps selected contact names and photos visible',async({page})=>{
 await platform(page,{visibility:'private'});
 await page.goto('/apps/test-app/publishing?step=2');
 await page.getByRole('combobox',{name:'Add a Carbon or Silicon'}).fill('assistnt');
 await page.getByRole('option',{name:/Saved Assistant/}).click();
 await expect(page.getByLabel('Share with accounts')).toHaveValue('si:assistant');
 await expect(page.getByText('Saved Assistant',{exact:true})).toBeVisible();
 await expect(page.locator('img[src="/api/contacts/photos/portrait"]').first()).toBeVisible();
});

test('exact lookup previews the requested account alongside higher trust saved contacts',async({page})=>{
 await platform(page);
 const fresh={uuid:'44444444-4444-4444-8444-444444444444',id:'c:new-person',display_name:'New Person',pfp_url:'https://example.test/new-person.png'};
 await page.route('**/api/contacts/lookup?*',route=>route.fulfill({json:fresh}));
 await page.goto('/apps/test-app/authors');
 await page.getByRole('combobox',{name:'Invite an author'}).fill('c:new-person');
 await page.getByRole('option',{name:/New Person/}).click();
 await expect(page.getByText('New Person',{exact:true})).toBeVisible();
 await expect(page.locator('img[src="https://example.test/new-person.png"]')).toHaveCount(1);
 await expect(page.getByRole('button',{name:'Save to Contacts',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Edit saved contact',exact:true})).toHaveCount(0);
});
