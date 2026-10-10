"use client";

import { EmptyStates } from "@/components/silicon-ui/blocks/empty-states/empty-states";
import { SignIn } from "@/components/silicon-ui/blocks/sign-in/sign-in";
import { notify } from "@/lib/notify";
import { Specimen, Specimens } from "../specimen";

export function Blocks() {
  return (
    <Specimens>
      <Specimen title="Sign-in block (a sample flow: any email, code 123456)">
        <SignIn demoCode="123456" onSignIn={account => notify.success(`Signed in as ${account.name}`, "A sample flow; nothing was signed in.")} />
      </Specimen>
      <Specimen title="Empty states block">
        <EmptyStates />
      </Specimen>
    </Specimens>
  );
}
