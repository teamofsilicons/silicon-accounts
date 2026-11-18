/** Address-book integration only; messaging never crosses this proxy. */
export function contactsProxyRoute(raw:string,method:string):string|null {
  if(!raw || raw.includes('%') || raw.includes('\\') || raw.split('/').some(p=>!p||p==='.'||p==='..'))return null;
  if(raw==='connection'&&['GET','POST','DELETE'].includes(method))return 'v1/integrations/developer/connection';
  if(raw==='lookup'&&method==='GET')return 'v1/integrations/developer/lookup';
  if(raw==='contacts'&&['GET','POST'].includes(method))return 'v1/contacts';
  if(/^contacts\/[A-Za-z0-9_-]+$/.test(raw)&&['GET','PUT','DELETE'].includes(method))return `v1/${raw}`;
  if(/^photos\/[A-Za-z0-9_-]+$/.test(raw)&&method==='GET')return `v1/${raw}`;
  return null;
}
