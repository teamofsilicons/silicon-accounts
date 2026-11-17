"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cluster } from "@/components/foundation/layout/layout";
import { Button } from "@/components/silicon-ui/button/button";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { Select, type SelectProps } from "@/components/silicon-ui/select/select";
import { useSession } from "@/lib/query/session";
import { contactsApi, useContactsConnection } from "./api";

export function ContactAccess({ onGranted, onCancel }: { onGranted: () => void; onCancel: () => void }) {
  const { me } = useSession();
  const connection = useContactsConnection();
  const cache = useQueryClient();
  const grant = useMutation({
    mutationFn: () => contactsApi<{ connected: boolean }>("connection", "POST", {}),
    onSuccess: (result) => cache.setQueryData(["contacts", "connection", me?.uuid], result),
  });

  useEffect(() => {
    if (me && connection.data?.connected) onGranted();
  }, [me, connection.data?.connected, onGranted]);

  if (!me || connection.data?.connected) return null;
  return (
    <Dialog open onOpenChange={open => { if (!open && !grant.isPending) onCancel(); }}>
      <DialogContent title="Use your saved contacts?" description="Allow Silicon Developer to read names, photos and trust levels, and to save contacts you choose to add or edit.">
        {connection.error && <p role="alert">{connection.error.message}</p>}
        {grant.error && <p role="alert">{grant.error.message}</p>}
        <Cluster justify="end">
          <Button type="button" variant="ghost" disabled={grant.isPending} onClick={onCancel}>Cancel</Button>
          {connection.isError
            ? <Button type="button" onClick={() => void connection.refetch()}>Retry</Button>
            : <Button type="button" loading={grant.isPending || connection.isPending} onClick={() => grant.mutate()}>Allow access</Button>}
        </Cluster>
      </DialogContent>
    </Dialog>
  );
}

/** Apply the saved-contacts filter only after the signed-in account has granted access. */
export function ScopeSelect(props: SelectProps & { onValueChange: (value: string) => void }) {
  const { me } = useSession();
  const [requesting, setRequesting] = useState(false);
  return <>
    <Select {...props} onValueChange={scope => {
      if (scope === "contacts") setRequesting(!!me);
      else props.onValueChange(scope);
    }}/>
    {requesting && <ContactAccess onCancel={() => setRequesting(false)} onGranted={() => {
      props.onValueChange("contacts");
      setRequesting(false);
    }}/>}
  </>;
}
