'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useQueryClient} from '@tanstack/react-query';
import {paths} from '@/lib/navigation';
import {api,useMutation,useResource} from './api';
import {Button,Section,ErrorNotice,date} from './ui';
import {DeleteResourceForm} from '@/components/developer/parts/delete-resource-form';
import type {App} from './types';
export function AppLifecycle({app}:{app:App}) {
  const mutation=useMutation();
  const router=useRouter();
  const cache=useQueryClient();
  if (["silicon-apps","silicon-accounts","developer"].includes(app.app_id)) {
    return <Section title="App settings"><p>This platform registration is protected from deletion.</p></Section>;
  }
  if (!app.is_admin) {
    return <Section title="App settings"><p>Deleting this app requires management permission.</p></Section>;
  }
  async function remove() {
    const result=await mutation.run(()=>api(`/apps/${app.app_id}`,{method:"DELETE"}));
    if (result) {
      await cache.invalidateQueries();
      router.push(paths.developer);
    }
  }
  return <DeleteResourceForm kind="app" id={app.app_id}
    description="Deletion stops discovery, downloads and Accounts sign-in. You can restore the app within 30 days. Its ID stays reserved."
    pending={mutation.pending} error={<ErrorNotice error={mutation.error}/>} remove={()=>void remove()}/>;
}

export function DeletedApps(){const [now,setNow]=useState(()=>Date.now());useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60_000);return()=>clearInterval(timer);},[]);const resource=useResource<{items:App[]}>('/apps?mine=true&deleted=true'),mutation=useMutation(resource.reload),cache=useQueryClient();if(!resource.data?.items.length&&!resource.error)return null;return <Section title='Deleted apps' description='Restore an app within 30 days. App IDs stay reserved.'><ErrorNotice error={resource.error}/><ErrorNotice error={mutation.error}/>{resource.data?.items.map(app=><div key={app.app_id} className='row between'><div><strong>{app.name}</strong><p>{app.app_id} · {app.restore_until?`Recover until ${date(app.restore_until)}`:'Deleted'}</p></div><Button disabled={!app.is_admin||!!app.restore_until&&Date.parse(app.restore_until)<=now} loading={mutation.pending} onClick={async()=>{if(await mutation.run(()=>api(`/apps/${app.app_id}/restore`,{method:'POST'})))await cache.invalidateQueries();}}>Restore app</Button></div>)}</Section>;}
