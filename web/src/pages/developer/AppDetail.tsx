/**
 * /developer/:appId/:tab? — one app's sign-in setup. Placeholder from the web foundation; the web-developer builder
 * owns this file. The tab lives in the URL (DEVELOPER_TABS in src/app/navigation.ts); an unknown tab shows Overview.
 */
import { useNavigate, useParams } from "@solidjs/router";
import { For } from "solid-js";
import { Tabs, TabsList, TabsTrigger } from "../../arc/tabs/tabs";
import { api, createApiResource } from "../../api";
import { PagePlaceholder } from "../../app/PagePlaceholder";
import { DEVELOPER_TABS, DEVELOPER_TAB_LABELS, paths, type DeveloperTab } from "../../app/navigation";

export default function AppDetail() {
  const params = useParams<{ appId: string; tab?: string }>();
  const navigate = useNavigate();
  const tab = (): DeveloperTab => (DEVELOPER_TABS.includes(params.tab as DeveloperTab) ? (params.tab as DeveloperTab) : "overview");
  // The app's name once it loads; the app id until then (and when it cannot be read).
  const [app] = createApiResource(() => params.appId, appId => api.apps.get(appId));
  const name = () => (app.error ? undefined : app()?.name) ?? params.appId;
  return (
    <PagePlaceholder
      title={name()}
      description="Sign-in methods, branding, users, imports, webhooks, proofs and embed code for this app."
      note={`The ${DEVELOPER_TAB_LABELS[tab()]} tab of ${name()}.`}
      back={{ href: paths.developer, label: "Your apps" }}
      width="default"
    >
      <Tabs value={tab()} onValueChange={next => navigate(paths.developerApp(params.appId, next as DeveloperTab))}>
        <TabsList aria-label="App sections">
          <For each={DEVELOPER_TABS}>{value => <TabsTrigger value={value}>{DEVELOPER_TAB_LABELS[value]}</TabsTrigger>}</For>
        </TabsList>
      </Tabs>
    </PagePlaceholder>
  );
}
