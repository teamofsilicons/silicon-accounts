"use client";
import Link from "next/link";
import {paths} from "@/lib/navigation";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Section, Surface } from "@/components/foundation/layout/layout";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Button } from "@/components/silicon-ui/button/button";
import { Select } from "@/components/silicon-ui/select/select";
import { CopyButton } from "@/components/silicon-ui/copy-button/copy-button";
import { CopyField } from "@/components/developer/parts/copy-field";
import { SecretReveal } from "@/components/developer/parts/secret-reveal";
import { ApiError } from "@/lib/api/errors";
import { cellsApi, type Credentials } from "@/lib/cells/api";
import styles from "./cells.module.css";

export function AppCellSection({appId}: {appId: string}) {
  const cache = useQueryClient();
  const connection = useQuery({queryKey: ["cells", "app", appId], queryFn: ({signal}) => cellsApi.app(appId, signal)});
  const list = useQuery({queryKey: ["cells", "list"], queryFn: ({signal}) => cellsApi.list(signal)});
  const [choice, setChoice] = useState("new");
  const [redirect, setRedirect] = useState("");
  const [privateValues, setPrivateValues] = useState<Credentials | null>(null);
  const operation = useRef<{choice: string; key: string} | null>(null);
  const cell = connection.data?.cell;
  const selected = choice === "new" && cell ? cell.cell_id : choice;
  const enable = useMutation({
    mutationFn: async () => {
      if (operation.current?.choice !== selected) operation.current = {choice: selected, key: crypto.randomUUID()};
      const {credentials, ...publicResult} = await cellsApi.enable(appId, selected === "new" ? null : selected, operation.current.key);
      if (credentials) setPrivateValues(credentials);
      return publicResult;
    },
    onSuccess: result => {
      // One-time credentials live only in this component, never in the query cache.
      cache.setQueryData(["cells", "app", appId], result);
      void cache.invalidateQueries({queryKey: ["cells", "list"]});
      setChoice(result.cell?.cell_id ?? "new");
      operation.current = null;
    },
    meta: {toast: false},
  });
  const failure = enable.error ?? connection.error ?? list.error;
  const options = [
    ...(!cell ? [{value: "new", label: "Create a cell for this app"}] : []),
    ...(list.data?.cells ?? []).filter(c => c.status === "active").map(c => ({value: c.cell_id, label: `${c.name} · ${c.cell_id}`})),
  ];
  const links = connection.data?.sign_in_links ?? [];
  const link = links.find(l => l.redirect_to === redirect) ?? links[0];
  const snippet = cell && connection.data?.publishable_key ? `import { createClient } from '@teamofsilicons/cells';\n\nconst cell = createClient(${JSON.stringify(cell.url)}, {\n  publishableKey: ${JSON.stringify(connection.data.publishable_key)},\n});\n\n// Finish sign-in when the user returns to your frontend.\nawait cell.consumeCallback();\n${link ? `\nconst signIn = cell.signInUrl({\n  app: ${JSON.stringify(appId)},\n  redirectTo: ${JSON.stringify(link.redirect_to)},\n});` : ""}` : "";
  return <Section id="signin-cell" title="Your app’s backend" description="Enable sign-in with a cell, which finishes Accounts sign-in and gives your frontend its database. You can also choose a cell you already co-author.">
    <div className={styles.stack}>
      {failure && <Alert tone="danger" title={ApiError.from(failure).message}>{ApiError.from(failure).hint}</Alert>}
      {connection.isPending ? <p role="status">Loading the app’s cell…</p> : <>
        <Select label="Cell" value={selected} options={options} onValueChange={setChoice} disabled={enable.isPending || list.isPending} />
        <div><Button loading={enable.isPending} disabled={!!connection.error || list.isPending || !!list.error} onClick={() => enable.mutate()}>{cell ? "Use selected cell" : "Enable sign-in"}</Button></div>
      </>}
      {cell && <>
        <Link href={paths.cell(cell.cell_id)}>Open this cell</Link>
        <CopyField label="Cell URL" value={cell.url} />
        {connection.data?.publishable_key && <CopyField label="Publishable key" value={connection.data.publishable_key} description="Use this in your frontend. Tables apply the signed-in user’s access rules." />}
        {links.length > 1 && <Select label="Frontend redirect" value={link?.redirect_to ?? ""} options={links.map(l => ({value: l.redirect_to, label: l.redirect_to}))} onValueChange={setRedirect} />}
        {link ? <><CopyField label="Sign-in link" value={link.sign_in} /><CopyField label="Sign-up link" value={link.sign_up} /></> : <p>Add your frontend’s exact redirect URL below, save it, then use “Use selected cell” to copy it to the cell.</p>}
        {snippet && <Surface className={styles.code}><pre><code>{snippet}</code></pre><CopyButton value={snippet} label="Copy JavaScript" /></Surface>}
      </>}
      {privateValues && <SecretReveal title="Save these server credentials"
        description="Keep these on your server. Your frontend uses the publishable key above."
        secrets={[{label: "Secret key", value: privateValues.secret_key}, {label: "Database connection", value: privateValues.database_url}]}
        onDone={() => setPrivateValues(null)} doneLabel="I’ve saved these credentials" />}
    </div>
  </Section>;
}
