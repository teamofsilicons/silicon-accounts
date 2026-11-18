import {InterfaceInvitations} from "@/components/interfaces/invitations";
import {CellInvitations} from "@/components/cells/invitations";
import { Invitations } from "@/components/publishing/Management";
import { Page } from "@/components/foundation/layout/layout";
export const metadata = { title: "Invitations · Silicon Developer" };
export default function PageContent() { return <Page><div className="publishing-panel"><Invitations /></div><InterfaceInvitations/><CellInvitations/></Page>; }
