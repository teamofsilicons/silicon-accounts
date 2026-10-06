/**
 * /authorize/flow/:id — the hosted sign-in, driven by FlowView.step, painted with the app's branding. Foundation
 * version (frame only); the web-auth builder owns this file and builds every step.
 */
import { useParams } from "@solidjs/router";
import { Show } from "solid-js";
import { Alert } from "../../arc/alert/alert";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { api, createApiResource } from "../../api";
import type { FlowView } from "../../api";
import { BrandAside, BrandPanel, BrandStage, BrandingScope, PoweredBy, brandLogo, resolveBrandTheme, type PaintTheme } from "../../branding";
import { theme } from "../../theme/theme";
import styles from "./auth.module.css";

/** Logo and app name, as the branding asks (shown in the aside and at the top of the panel). */
function AppHeader(props: { flow: FlowView; paint: PaintTheme }) {
  return (
    <div class="sa-brand-header">
      <Show when={brandLogo(props.flow.app.branding, props.flow.app, props.paint)}>{logo => <img class="sa-brand-logo" src={logo()} alt="" />}</Show>
      <Show when={props.flow.app.branding.show_app_name}><span class="sa-brand-name">{props.flow.app.name}</span></Show>
    </div>
  );
}

export default function Flow() {
  const params = useParams<{ id: string }>();
  const [flow] = createApiResource(() => params.id, id => api.flows.get(id));
  const paint = () => resolveBrandTheme(flow()?.app.branding.theme, theme());
  const title = (current: FlowView) => current.app.copy.title ?? `Sign in to ${current.app.name}`;
  return (
    <div class={styles.hosted}>
      <BrandingScope branding={flow()?.app.branding} theme={paint()}>
        <BrandStage>
          <Show when={flow()}>
            {current => (
              <BrandAside>
                <AppHeader flow={current()} paint={paint()} />
                <div>
                  <h2 class="sa-brand-title">{title(current())}</h2>
                  <Show when={current().app.copy.subtitle}>{subtitle => <p class="sa-brand-subtitle">{subtitle()}</p>}</Show>
                </div>
              </BrandAside>
            )}
          </Show>
          <BrandPanel>
            <Show when={!flow.error} fallback={<Alert tone="danger" title="This sign-in has ended">{flow.error?.message} {flow.error?.hint}</Alert>}>
              <Show when={flow()} fallback={<SkeletonBlock width="100%" height="180px" radius="var(--radius-panel)" />}>
                {current => (
                  <>
                    <AppHeader flow={current()} paint={paint()} />
                    <h1 class="sa-brand-title">{title(current())}</h1>
                    <Show when={current().app.copy.subtitle}>{subtitle => <p class="sa-brand-subtitle">{subtitle()}</p>}</Show>
                    <div class="sa-brand-body">
                      <p class="sa-brand-subtitle">Step: {current().step}</p>
                    </div>
                    <Show when={current().app.copy.terms_url || current().app.copy.privacy_url}>
                      <p class="sa-brand-legal">
                        By continuing you accept the{" "}
                        <Show when={current().app.copy.terms_url}>{url => <a href={url()} target="_blank" rel="noopener">terms</a>}</Show>
                        <Show when={current().app.copy.terms_url && current().app.copy.privacy_url}> and </Show>
                        <Show when={current().app.copy.privacy_url}>{url => <a href={url()} target="_blank" rel="noopener">privacy policy</a>}</Show>
                        {" "}of {current().app.name}.
                      </p>
                    </Show>
                  </>
                )}
              </Show>
            </Show>
          </BrandPanel>
        </BrandStage>
      </BrandingScope>
      <PoweredBy theme={paint()} overlay />
    </div>
  );
}
