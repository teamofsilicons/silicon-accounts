"use client";

import { useState } from "react";
import { Select } from "@/components/silicon-ui/select/select";
import { Button } from "@/components/silicon-ui/button/button";
import { Cluster, Surface } from "@/components/foundation/layout/layout";
import { useSession } from "@/lib/query/session";
import { useContacts } from "./api";
import { ScopeSelect } from "./contact-access";
import { FilterMenu } from "./filter-menu";
import { PersonField } from "./person-field";

export type ResourceOwner = {
  organization_id?: string | null;
  publisher?: { name?: string };
  created_by?: string | null;
  shared_with_me?: boolean;
  authors?: { uuid: string }[];
  creators?: { uuid: string }[];
};

const scopes = [
  { value: "all", label: "All resources" },
  { value: "mine", label: "Created by me" },
  { value: "shared", label: "Shared with me" },
  { value: "contacts", label: "From saved contacts" },
];

export function useResourceFilter() {
  const { me } = useSession();
  const [scope, setScope] = useState("all");
  const [publisher, setPublisher] = useState("all");
  const [person, setPerson] = useState("");
  const [uuid, setUuid] = useState("");
  const { contacts } = useContacts(scope === "contacts");
  const contactIds = new Set(contacts.data?.filter(contact => !contact.blocked).map(contact => contact.uuid));
  const count = Number(scope !== "all") + Number(publisher !== "all") + Number(!!uuid);

  function clear() {
    setScope("all");
    setPublisher("all");
    setPerson("");
    setUuid("");
  }

  function matches(resource?: ResourceOwner) {
    if (!resource) return count === 0;
    if (publisher !== "all" && publisher !== (resource.organization_id ? `org:${resource.organization_id}` : "personal")) return false;
    const authors = resource.creators ?? resource.authors ?? [];
    const creator = resource.created_by || authors[0]?.uuid;
    const peers = new Set(authors.map(author => author.uuid));
    if (creator) peers.add(creator);
    if (uuid && !peers.has(uuid)) return false;
    switch (scope) {
      case "mine": return !!creator && creator === me?.uuid;
      case "shared": return resource.shared_with_me ?? (!!creator && creator !== me?.uuid);
      case "contacts": return [...peers].some(id => contactIds.has(id));
      default: return true;
    }
  }

  function controls(resources: ResourceOwner[]) {
    const orgs = new Map<string, string>();
    for (const resource of resources) {
      const id = resource.organization_id;
      if (id) orgs.set(id, resource.publisher?.name || orgs.get(id) || id);
    }
    return (
      <FilterMenu count={count} clear={clear}>
        <ScopeSelect label="Show resources" value={scope} onValueChange={setScope} options={scopes}/>
        <Select label="Publisher" value={publisher} onValueChange={setPublisher} options={[
          { value: "all", label: "All publishers" },
          { value: "personal", label: "Personal accounts" },
          ...[...orgs].sort((a, b) => a[1].localeCompare(b[1])).map(([id, label]) => ({ value: `org:${id}`, label })),
        ]}/>
        <PersonField label="Filter by person" value={person} onChange={value => { setPerson(value); setUuid(""); }} onSelect={choice => setUuid(choice.uuid)} allowContactEditing={false}/>
      </FilterMenu>
    );
  }

  function empty(noun: string) {
    return <Surface padding="sm"><Cluster justify="between">
      <p role="status">{scope === "contacts" && contacts.isFetching ? "Loading saved contacts…" : contacts.error && scope === "contacts" ? contacts.error.message : `No ${noun} match your filters.`}</p>
      <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button>
    </Cluster></Surface>;
  }
  return { count, matches, controls, empty };
}
