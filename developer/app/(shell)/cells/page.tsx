import type {Metadata} from "next";
import {CellsHome} from "@/components/cells/home";
export const metadata:Metadata={title:"Your cells"};
export default function Page(){return <CellsHome/>;}
