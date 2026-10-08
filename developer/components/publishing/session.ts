"use client";

import { useSession as useDeveloperSession } from "@/lib/query/session";
export function useSession() {
  const { me, status, refetch } = useDeveloperSession();
  return {
    account: me ? { uuid: me.uuid, id: me.id || me.uuid, display_name: me.display_name } : null,
    loading: status === "loading",
    refresh: refetch,
  };
}
