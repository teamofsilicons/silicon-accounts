#!/usr/bin/env python3
"""Acceptance against the isolated Organizations dev stack; never production.
Creates unique qaacc identities through public OTP flows and reads delivered
codes from the local messaging mock. Credentials stay in memory, never printed.
"""
import base64, hashlib, html, http.cookiejar, json, re, secrets, time
import urllib.request, urllib.error, urllib.parse
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
API='http://localhost:8649'; SITE='http://localhost:8650'
CONFIG=json.loads((ROOT.parent/'silicon-organizations/.dev/runtime.json').read_text())
SUFFIX=secrets.token_hex(4); ORG='qaacc-'+SUFFIX; RESULTS=[]; OTP_LAST={}
class Browser:
    def __init__(self): self.jar=http.cookiejar.CookieJar(); self.http=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
    def request(self,path,body=None,method=None,basic=None,key=None,bearer=None,form=None):
        headers={'Origin':SITE,'Accept':'application/json'}
        if basic: headers['Authorization']='Basic '+base64.b64encode((':'.join(basic)).encode()).decode()
        if bearer: headers['Authorization']='Bearer '+bearer
        if key: headers['Idempotency-Key']=key
        data=None
        if form is not None: data=urllib.parse.urlencode(form).encode();headers['Content-Type']='application/x-www-form-urlencoded'
        elif body is not None: data=json.dumps(body).encode();headers['Content-Type']='application/json'
        req=urllib.request.Request(API+path,data=data,headers=headers,method=method or ('POST' if data else 'GET'))
        try:
            with self.http.open(req,timeout=30) as r:
                raw=r.read(); return r.status,json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e: return e.code,json.loads(e.read())
def must(result,status=200):
    code,data=result
    assert code==status,(code,data.get('error','unexpected successful response'))
    return data
def bridge(path,body=None,method=None,key=None):
    return service.request('/v1/internal/organizations/'+path,body,method,basic=('silicon-organizations',CONFIG['organizations_secret']),key=key)
def otp(email):
    # Read the captured local delivery, proving the worker actually sent it.
    url='http://localhost:8652/_messages/wait?'+urllib.parse.urlencode({'to':email,'timeout_ms':10000,'after':OTP_LAST.get(email,0)})
    with urllib.request.urlopen(url,timeout=15) as response:
        data=json.loads(response.read())
    message=data if 'code' in data else data['message']
    OTP_LAST[email]=message['seq']
    return message['code']
def flow(b,email,extra=None,signup=False):
    verifier=secrets.token_urlsafe(48)
    body={'app_id':'silicon-accounts','redirect_uri':SITE+'/','state':secrets.token_urlsafe(20),'code_challenge':base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('='),'code_challenge_method':'S256','timezone':'Asia/Kolkata','prompt':'login',**(extra or {})}
    f=must(b.request('/v1/flows',body),201)['flow']; fid=f['id']
    must(b.request(f'/v1/flows/{fid}/email',{'email':email}))
    f=must(b.request(f'/v1/flows/{fid}/verify',{'code':otp(email)}))['flow']
    if signup:
        assert f['step']=='signup',f['step']
        f=must(b.request(f'/v1/flows/{fid}/signup',{'display_name':'QA Accounts '+SUFFIX,'dob':'1993-05-10'}))['flow']
    return f
def slt(b,app,target=None):
    return must(b.request('/v1/me/short-lived-tokens',{'app_id':app,**({'account_uuid':target} if target else {})}),201)['slt']
def exchange(app,secret,grant,key):
    return must(service.request('/v1/oauth/token',basic=(app,secret),key=key,form={'grant_type':'slt','slt':grant}))
def create_guest(handle,email):
    iid='qa-invite-'+secrets.token_hex(6)
    inv=must(bridge(ORG+'/invitations',{'invite_id':iid,'email':email,'handle':handle,'return_to':f'http://localhost:8661/invites/{iid}'},key=iid),201)
    public=Browser();ticket=inv['ticket'];sent=must(public.request(f'/v1/work-invitations/{ticket}/email-code',{}))
    verified=must(public.request(f'/v1/work-invitations/{ticket}/verify',{'challenge_id':sent['challenge_id'],'code':otp(email),'display_name':'QA Work '+handle,'dob':'1993-05-10','timezone':'Asia/Kolkata'}))
    return must(bridge(ORG+'/accounts',{'kind':'carbon','handle':handle,'invitation_id':iid,'invitation_proof':verified['invitation_proof']},key=iid+'-accept'),201)['account']
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None

def raw_local(b,url,fields=None,origin=None):
    assert urllib.parse.urlparse(url).hostname in ('localhost','127.0.0.1')
    opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(b.jar),NoRedirect())
    headers={} if origin is None else {'Origin':origin}
    data=None
    if fields is not None:data=urllib.parse.urlencode(fields).encode();headers['Content-Type']='application/x-www-form-urlencoded'
    try:r=opener.open(urllib.request.Request(url,data=data,headers=headers),timeout=30)
    except urllib.error.HTTPError as error:r=error
    with r:return r.status,r.headers,r.read().decode()

def provider_picker(provider,email,expected):
    browser=Browser();f=must(browser.request('/v1/flows',{'app_id':'silicon-accounts','redirect_uri':SITE+'/','state':secrets.token_urlsafe(20),'prompt':'login'}),201)['flow'];fid=f['id']
    start=must(browser.request(f'/v1/flows/{fid}/oauth/{provider}',{}))
    url=start['authorize_url']+'&'+urllib.parse.urlencode({'_auto':email,'_name':'QA Provider'})
    status,headers,body=raw_local(browser,url)
    if provider=='google':
        assert status==302,status
        callback=headers['Location'];assert callback.startswith(SITE+'/v1/oauth/callback/google')
        status,_,_=raw_local(browser,API+callback[len(SITE):]);assert status==302,status
    else:
        assert status==200,status
        fields={html.unescape(k):html.unescape(v) for k,v in re.findall(r'<input type="hidden" name="([^"]+)" value="([^"]*)"',body)}
        assert 'code' in fields
        status,parked,_=raw_local(Browser(),API+'/v1/oauth/callback/apple',fields,'http://127.0.0.1:8651');assert status in (302,303),status
        location=parked['Location'];assert location.startswith(SITE+'/v1/oauth/callback/apple')
        status,_,_=raw_local(browser,API+location[len(SITE):]);assert status==302,status
    f=must(browser.request(f'/v1/flows/{fid}'))['flow'];assert f['step']=='select_account',(provider,f['step'])
    ids={a['uuid'] for a in f['accounts']};assert expected.issubset(ids)
    return browser,f

def check(name): RESULTS.append(name);print('PASS '+name,flush=True)
service=Browser();a=Browser();email_a=f'qaacc-{SUFFIX}@example.test'
flow(a,email_a,signup=True);personal=must(a.request('/v1/me'));check('Hosted OTP signup creates a personal account')
org_token=exchange('silicon-organizations',CONFIG['organizations_secret'],slt(a,'silicon-organizations'),'qa-org-'+SUFFIX)['access_token']
must(bridge(ORG,{'name':'QA Accounts '+SUFFIX,'version':1},method='PUT',key=ORG))
work=must(bridge(ORG+'/accounts',{'kind':'carbon','handle':'founder','actor_token':org_token},key=ORG+'-founder'),201)['account']
group=must(a.request('/v1/me/linked-accounts'));assert group['main_uuid']==personal['uuid'] and len(group['accounts'])==2
must(a.request('/v1/me/linked-accounts/switch',{'account_uuid':work['uuid']}));view=must(a.request('/v1/me'));assert view['uuid']==work['uuid'] and not view.get('emails')
must(a.request('/v1/me/linked-accounts/switch',{'account_uuid':personal['uuid']}));check('Creator work identity is distinct, linked, and does not steal the personal email')
email_c=f'qaacc-link-{SUFFIX}@example.test';c=create_guest('linked',email_c)
link=must(a.request('/v1/me/linked-accounts/link/start',{}));f=flow(a,email_c,extra={'link_id':link['link_id']})
assert f['step']=='complete',f['step'];assert must(a.request('/v1/me'))['uuid']==personal['uuid']
unrelated=Browser();bad=unrelated.request('/v1/me/linked-accounts/link/complete',{'link_id':link['link_id']});assert bad[0]==401,bad[0]
group=must(a.request('/v1/me/linked-accounts/link/complete',{'link_id':link['link_id']}));assert group['main_uuid']==personal['uuid'] and len(group['accounts'])==3
check('Independent target login preserves the initiator cookie; linking rejects an unauthenticated completer')
email_b=f'qaacc-main-{SUFFIX}@example.test';bwork=create_guest('main',email_b);b=Browser();flow(b,email_b)
assert must(b.request('/v1/me'))['uuid']==bwork['uuid']
body={'id':'c:qa-personal-'+SUFFIX,'display_name':'QA new personal'};new=must(b.request('/v1/me/personal-account',body,key='qa-personal-'+SUFFIX),201)
again=must(b.request('/v1/me/personal-account',body,key='qa-personal-'+SUFFIX),201);assert new==again
group=must(b.request('/v1/me/linked-accounts'));assert group['main_uuid']==new['uuid'] and len(group['accounts'])==2
must(b.request('/v1/me/linked-accounts/switch',{'account_uuid':new['uuid']}));assert not must(b.request('/v1/me')).get('emails')
check('Work-main creates exactly one personal account, becomes linked main, and retains work email ownership')
must(a.request('/v1/me/linked-accounts/switch',{'account_uuid':work['uuid']}));grant=exchange('ting',CONFIG['ting_secret'],slt(a,'ting'),'qa-ting-'+SUFFIX)
policy={'version':2,'mode':'only','apps':[],'extra_apps':['ting'],'excluded_apps':['ting','silicon-accounts','silicon-organizations']}
removed=must(bridge(f'{ORG}/accounts/{work["uuid"]}/policy',policy,method='PUT',key=ORG+'-policy'));assert 'ting' in removed['removed_apps']
assert a.request('/v1/me/short-lived-tokens',{'app_id':'ting'})[0]==403
introspection=must(service.request('/v1/oauth/introspect',basic=('ting',CONFIG['ting_secret']),form={'token':grant['access_token']}));assert introspection['active'] is False
assert must(a.request('/v1/me'))['uuid']==work['uuid'];check('Exclusions override additions, revoke issued app tokens, and preserve Accounts access')
must(a.request('/v1/me/linked-accounts/switch',{'account_uuid':personal['uuid']}))
f=must(a.request('/v1/flows',{'app_id':'ting','redirect_uri':'http://localhost:8662/auth/callback','state':'qa-picker-'+SUFFIX}),201)['flow']
f=must(a.request(f'/v1/flows/{f["id"]}/continue',{}))['flow'];assert f['step']=='select_account',f['step']
choice=next(item for item in f['accounts'] if item['uuid']==work['uuid']);assert choice['allowed'] is False and choice['reason']
assert a.request(f'/v1/flows/{f["id"]}/select-account',{'account_uuid':work['uuid']})[0]==403
check('Hosted picker shows disabled work identity with an organization reason and server rejects selection')
must(a.request('/v1/me/linked-accounts/switch',{'account_uuid':work['uuid']}))
must(bridge(f'{ORG}/accounts/{work["uuid"]}/close',{},key=ORG+'-close'));assert a.request('/v1/me')[0]==401
fresh=Browser();f=flow(fresh,email_a)
if f['step']=='select_account':must(fresh.request(f'/v1/flows/{f["id"]}/select-account',{'account_uuid':personal['uuid']}))
assert must(fresh.request('/v1/me'))['uuid']==personal['uuid']
group=must(fresh.request('/v1/me/linked-accounts'));assert work['uuid'] not in [item['uuid'] for item in group['accounts']] and c['uuid'] in [item['uuid'] for item in group['accounts']]
check('Closing work invalidates its session while preserving personal and other linked work identities')
events=must(bridge('events?after=0&limit=1000'))['items'];mine=[e for e in events if e['org_id']==ORG]
assert mine and all(e['account_uuid']!=personal['uuid'] and e.get('actor_id')!=personal['uuid'] for e in mine)
assert personal['uuid'] not in json.dumps(mine)
check('Organization event stream contains work activity and no personal linked UUID')
for provider in ('google','apple'):
    pb,pf=provider_picker(provider,email_a,{personal['uuid'],c['uuid']})
    must(pb.request(f'/v1/flows/{pf["id"]}/select-account',{'account_uuid':c['uuid']}))
    assert must(pb.request('/v1/me'))['uuid']==c['uuid']
    check(provider.title()+' mock proof reaches linked picker and signs in as the selected work account')
phone='+1202555'+str(secrets.randbelow(10000)).zfill(4)
added=must(fresh.request('/v1/me/phones',{'phone':phone}),201)
must(fresh.request('/v1/me/phones/verify',{'challenge_id':added['challenge_id'],'code':otp(phone)}))
phone_browser=Browser();pf=must(phone_browser.request('/v1/flows',{'app_id':'silicon-accounts','redirect_uri':SITE+'/','state':secrets.token_urlsafe(20),'prompt':'login'}),201)['flow']
must(phone_browser.request(f'/v1/flows/{pf["id"]}/phone',{'phone':phone}))
pf=must(phone_browser.request(f'/v1/flows/{pf["id"]}/verify',{'code':otp(phone)}))['flow'];assert pf['step']=='select_account'
assert {personal['uuid'],c['uuid']}.issubset({entry['uuid'] for entry in pf['accounts']})
check('Verified phone sign-in reaches the same linked account picker')
must(b.request('/v1/me',{'confirm':body['id']},method='DELETE'),204)
assert b.request('/v1/me')[0]==401
survivor=Browser();flow(survivor,email_b);assert must(survivor.request('/v1/me'))['uuid']==bwork['uuid']
assert must(survivor.request('/v1/me/linked-accounts'))['main_uuid']==bwork['uuid']
check('Deleting a personal main preserves and detaches its work account')
email_d=f'qaacc-survivor-{SUFFIX}@example.test';d=create_guest('survivor',email_d)
link=must(survivor.request('/v1/me/linked-accounts/link/start',{}));flow(survivor,email_d,extra={'link_id':link['link_id']})
group=must(survivor.request('/v1/me/linked-accounts/link/complete',{'link_id':link['link_id']}));assert group['main_uuid']==bwork['uuid']
must(bridge(f'{ORG}/accounts/{bwork["uuid"]}/close',{},key=ORG+'-close-main'))
dbrowser=Browser();flow(dbrowser,email_d);group=must(dbrowser.request('/v1/me/linked-accounts'));assert group['main_uuid']==d['uuid'] and len(group['accounts'])==1
check('Closing a work main preserves linked work and elects the survivor as main')
path=ROOT/'docs/operations/evidence/work-accounts-local.json';path.write_text(json.dumps({'date':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'environment':'isolated localhost:8649 / PostgreSQL:5548','organization':ORG,'checks':RESULTS,'count':len(RESULTS)},indent=2)+'\n')
print('Evidence: '+str(path))
