"use client";

import { Cpu, LayoutGrid, ShieldCheck } from "lucide-react";
import { BottomSheet } from "@/components/arc/bottom-sheet/bottom-sheet";
import { Button } from "@/components/arc/button/button";
import { CommandPalette } from "@/components/arc/command-palette/command-palette";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/arc/dialog/dialog";
import { Drawer, DrawerContent, DrawerTrigger } from "@/components/arc/drawer/drawer";
import { Input } from "@/components/arc/input/input";
import { DescriptionItem, DescriptionList } from "@/components/foundation/layout/layout";
import { notify } from "@/lib/notify";
import { Specimen, Specimens, kitchenStyles as styles } from "../specimen";

const icon = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

export function Overlays() {
  return (
    <Specimens>
      <Specimen title="Dialog: a decision that must interrupt" single>
        <div className={styles.row}>
          <Dialog>
            <DialogTrigger asChild><Button variant="secondary">Delete your account</Button></DialogTrigger>
            <DialogContent title="Delete your account?" description="Every app you signed into is told, and your id stays reserved for 10 days.">
              <p className={styles.prose}>You are custodian of no Silicons, so nothing blocks this.</p>
              <div className={styles.row}>
                <DialogClose asChild><Button variant="ghost">Keep my account</Button></DialogClose>
                <Button variant="danger">Delete account</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </Specimen>
      <Specimen title="Drawer: record details beside the page" single>
        <div className={styles.row}>
          <Drawer>
            <DrawerTrigger asChild><Button variant="secondary">Open user details</Button></DrawerTrigger>
            <DrawerContent title="Saket Dev" description="briefcase:a8K · signed in 2 minutes ago">
              <DescriptionList>
                <DescriptionItem label="Id"><span className={styles.mono}>c:saket</span></DescriptionItem>
                <DescriptionItem label="Email">saketdev12@gmail.com</DescriptionItem>
                <DescriptionItem label="Shared">Profile, email, timezone</DescriptionItem>
              </DescriptionList>
            </DrawerContent>
          </Drawer>
        </div>
      </Specimen>
      <Specimen title="BottomSheet: tasks on phones" single>
        <div className={styles.row}>
          <BottomSheet title="Transfer si:scout" description="The new custodian has 14 days to accept." trigger={<Button variant="secondary">Open sheet</Button>}>
            <Input label="New custodian" placeholder="c:shubham or name@example.com" />
          </BottomSheet>
        </div>
      </Specimen>
      <Specimen title="CommandPalette (the ⌘K menu's body)" single>
        <CommandPalette
          label="Sample command palette"
          onSelect={item => notify.info(item.label, "A sample command (nothing happened).")}
          items={[
            { id: "apps", label: "Apps", description: "Apps you signed into", group: "Go to", icon: <LayoutGrid {...icon} />, shortcut: "3" },
            { id: "proofs", label: "User verification", description: "App actions on your behalf", group: "Go to", icon: <ShieldCheck {...icon} />, shortcut: "5" },
            { id: "silicon", label: "Create a Silicon", group: "Silicons", icon: <Cpu {...icon} /> },
          ]}
        />
      </Specimen>
    </Specimens>
  );
}
