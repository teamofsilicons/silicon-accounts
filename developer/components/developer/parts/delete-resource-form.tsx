"use client";

import { useState, type ReactNode } from "react";
import { Section, Stack } from "@/components/foundation/layout/layout";
import { Button } from "@/components/silicon-ui/button/button";
import { Input } from "@/components/silicon-ui/input/input";

type Props = {
  kind: "app" | "interface";
  id: string;
  description: string;
  pending: boolean;
  disabled?: boolean;
  error: ReactNode;
  remove: (id: string) => void;
};

export function DeleteResourceForm({ kind, id, description, pending, disabled, error, remove }: Props) {
  const [confirmation, setConfirmation] = useState("");
  const canDelete = confirmation === id && !pending && !disabled;

  return <Section title={`Delete ${kind}`} description={description}>
    <form onSubmit={event => {
      event.preventDefault();
      if (canDelete) remove(confirmation);
    }}>
      <Stack>
        <Input label={`Type ${id} to confirm deletion`} value={confirmation}
          onChange={event => setConfirmation(event.target.value)} disabled={pending || disabled} />
        {error}
        <div><Button type="submit" variant="danger" disabled={!canDelete} loading={pending}>Delete {kind}</Button></div>
      </Stack>
    </form>
  </Section>;
}
