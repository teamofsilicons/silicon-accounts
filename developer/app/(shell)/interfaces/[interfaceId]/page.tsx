import {InterfaceWorkspace} from "@/components/interfaces/workspace";
export default async function Page({params}:{params:Promise<{interfaceId:string}>}) {const {interfaceId}=await params; return <InterfaceWorkspace key={interfaceId} interfaceId={interfaceId}/>;}
