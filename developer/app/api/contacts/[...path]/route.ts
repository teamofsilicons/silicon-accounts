import {NextRequest} from 'next/server';
import {contactsApiUrl} from '@/lib/server/config';
import {contactsProxyRoute} from '@/lib/server/contacts-routes';
import {integrationProxy} from '@/lib/server/integration-proxy';
export const dynamic='force-dynamic';
function handle(request:NextRequest){return integrationProxy(request,contactsApiUrl(),contactsProxyRoute(request.nextUrl.pathname.slice('/api/contacts/'.length),request.method),'Contacts','Developer');}
export const GET=handle;export const POST=handle;export const PUT=handle;export const DELETE=handle;
