/**
 * The branding runtime in the style guide: the same mini sign-in card painted with four apps' branding variables
 * (values from testkit/fake-apps.json), each with the un-removable "Powered by Silicon Accounts" line.
 */
import { For, Show } from "solid-js";
import type { Branding } from "../../api/types";
import { Button } from "../../arc/button/button";
import { Input } from "../../arc/input/input";
import { ProviderButton, SignInDivider } from "../../arc/blocks/sign-in/sign-in";
import { BrandAside, BrandPanel, BrandStage, BrandingScope, PoweredBy, brandingContrastIssues, formatRatio, contrastRatio, normalizeBranding, resolveBrandTheme } from "../../branding";
import { useSquircle } from "../../arc/lib/squircle";
import { theme } from "../../theme/theme";
import styles from "./kitchen.module.css";

interface Sample {
  name: string;
  note: string;
  title: string;
  branding: Partial<Branding>;
}

const SAMPLES: Sample[] = [
  { name: "Briefcase", note: "Default look: card, squircles, Geist", title: "Sign in to Briefcase", branding: {} },
  {
    name: "Acme Notes",
    note: "Dark, Fraunces headings, radius 28, split, grain",
    title: "Welcome back to Acme Notes",
    branding: { theme: "dark", font_family: "Inter", heading_font_family: "Fraunces", radius: 28, layout: "split", background_style: "grain", light: { primary: "#8A4F0F", primary_foreground: "#FFFBF5", background: "#FBF7F0", surface: "#FFFFFF", foreground: "#2B2118", muted: "#6E5E4C", border: "#E9DFD0", danger: "#B42318" }, dark: { primary: "#E8B04B", primary_foreground: "#1A1410", background: "#16130F", surface: "#211D18", foreground: "#F3ECE2", muted: "#B3A796", border: "#3A332B", danger: "#F97066" } },
  },
  {
    name: "Pixel Studio",
    note: "Loud: sharp corners, outline buttons, Space Grotesk, dots",
    title: "Sign in to Pixel Studio",
    branding: { theme: "light", font_family: "Space Grotesk", heading_font_family: "Space Grotesk", corner_style: "sharp", radius: 0, button_style: "outline", layout: "minimal", background_style: "dots", light: { primary: "#E5007E", primary_foreground: "#FFFFFF", background: "#FFF5FA", surface: "#FFFFFF", foreground: "#1D0B16", muted: "#7D4A66", border: "#F5B8D6", danger: "#C00021" }, dark: { primary: "#FF4FAE", primary_foreground: "#1D0B16", background: "#1D0B16", surface: "#2A1221", foreground: "#FFE8F4", muted: "#E2A3C4", border: "#5A2A44", danger: "#FF6B6B" } },
  },
  {
    name: "Orbit Games",
    note: "Dark, soft buttons, compact, gradient",
    title: "Play with your account",
    branding: { theme: "dark", font_family: "DM Sans", heading_font_family: "DM Sans", radius: 22, button_style: "soft", background_style: "gradient", density: "compact", light: { primary: "#4338CA", primary_foreground: "#FFFFFF", background: "#F5F6FF", surface: "#FFFFFF", foreground: "#14123A", muted: "#55528A", border: "#DADCF5", danger: "#BE123C" }, dark: { primary: "#22D3EE", primary_foreground: "#06222B", background: "#0B0A1F", surface: "#15133A", foreground: "#EEF2FF", muted: "#A5B4FC", border: "#2E2A6B", danger: "#FB7185" } },
  },
];

function MiniFlow(props: { sample: Sample }) {
  const branding = () => normalizeBranding(props.sample.branding);
  const paint = () => resolveBrandTheme(branding().theme, theme());
  const ratio = () => contrastRatio(branding()[paint()].primary_foreground, branding()[paint()].primary);
  return (
    <div>
      <div ref={el => useSquircle(el)} class={styles.brandFrame}>
        <BrandingScope branding={branding()} theme={paint()}>
          <BrandStage>
            <BrandAside>
              <span class="sa-brand-name">{props.sample.name}</span>
              <h2 class="sa-brand-title">{props.sample.title}</h2>
            </BrandAside>
            <BrandPanel as="section">
              <div class="sa-brand-header"><span class="sa-brand-name">{props.sample.name}</span></div>
              <h2 class="sa-brand-title">{props.sample.title}</h2>
              <div class="sa-brand-body">
                <Input label="Email" placeholder="name@example.com" />
                <Button class="sa-wide" style={{ width: "100%" }}>Continue</Button>
                <SignInDivider />
                <ProviderButton provider="google" />
              </div>
            </BrandPanel>
          </BrandStage>
        </BrandingScope>
        <PoweredBy theme={paint()} overlay />
      </div>
      <p class={styles.brandCaption}>
        <span>{props.sample.note}</span>
        <span>button text {formatRatio(ratio())}<Show when={brandingContrastIssues(branding()).length}> · contrast issue</Show></span>
      </p>
    </div>
  );
}

export function Brandings() {
  return (
    <div class={styles.brandGrid}>
      <For each={SAMPLES}>{sample => <MiniFlow sample={sample} />}</For>
    </div>
  );
}
