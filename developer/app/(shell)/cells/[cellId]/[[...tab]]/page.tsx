import {notFound} from "next/navigation";
import {CellWorkspace} from "@/components/cells/workspace";
export default async function Page({params}:{params:Promise<{cellId:string;tab?:string[]}>}) {
  const {cellId,tab=[]}=await params;
  if(tab.length>1 || !["overview","database","files","functions","webhooks","queues","triggers","jobs","realtime","services","templates","tings","domains","copies","backups","usage","logs","authors","settings","history"].includes(tab[0]??"overview"))notFound();
  return <CellWorkspace key={cellId} cellId={cellId} tab={tab[0]??"overview"}/>;
}
