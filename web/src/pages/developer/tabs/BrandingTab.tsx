/**
 * Branding: every Branding variable of the hosted pages as a control on the left, and the real hosted sign-in page,
 * painted with the draft, on the right (light or dark, desktop or phone, any step). Colours show their contrast live
 * and the 3:1 rule the server enforces; saving uses the config version so a concurrent change is caught.
 */
import { For, Show, createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { History, Laptop, Moon, RotateCcw, Smartphone, Sun, Upload } from "lucide-solid";
import type { BrandFont, Palette } from "../../../api";
import { Badge } from "../../../arc/badge/badge";
import { Button } from "../../../arc/button/button";
import { ColorPicker } from "../../../arc/color-picker/color-picker";
import { Input } from "../../../arc/input/input";
import { RadioCards } from "../../../arc/radio-cards/radio-cards";
import { SegmentedControl } from "../../../arc/segmented-control/segmented-control";
import { Select } from "../../../arc/select/select";
import { Switch } from "../../../arc/switch/switch";
import { useSquircle } from "../../../arc/lib/squircle";
import { BRAND_FONTS, DEFAULT_BRANDING, DEFAULT_DARK, DEFAULT_LIGHT, FONT_STACKS, LIMITS, contrastRatio, formatRatio, loadBrandFont, resolveBrandTheme, wcagLevel, type PaintTheme } from "../../../branding";
import { theme as siteTheme } from "../../../theme/theme";
import { useDeveloperApp } from "../lib/context";
import { messageFor } from "../lib/editor";
import { clone } from "../lib/paths";
import { MAX_INLINE_LOGO_BYTES } from "../lib/validate";
import { EditorAlerts } from "../parts/EditorAlerts";
import { HistoryDrawer } from "../parts/HistoryDrawer";
import { RangeSlider } from "../parts/RangeSlider";
import { SaveBar } from "../parts/SaveBar";
import { HostedPreview, PREVIEW_STEPS, type PreviewDevice, type PreviewStep } from "./HostedPreview";
import styles from "./branding.module.css";

const COLOURS: Array<{ key: keyof Palette; label: string; against: keyof Palette; againstLabel: string }> = [
  { key: "primary", label: "Primary", against: "primary_foreground", againstLabel: "against the button text" },
  { key: "primary_foreground", label: "Text on primary", against: "primary", againstLabel: "on the primary colour" },
  { key: "background", label: "Page background", against: "foreground", againstLabel: "against the text" },
  { key: "surface", label: "Card", against: "foreground", againstLabel: "against the text" },
  { key: "foreground", label: "Text", against: "background", againstLabel: "on the page background" },
  { key: "muted", label: "Muted text", against: "surface", againstLabel: "on the card" },
  { key: "border", label: "Borders", against: "surface", againstLabel: "against the card" },
  { key: "danger", label: "Errors", against: "surface", againstLabel: "on the card" },
];

const CHECKS: Array<{ label: string; fg: keyof Palette; bg: keyof Palette }> = [
  { label: "Button text on primary", fg: "primary_foreground", bg: "primary" },
  { label: "Text on the page background", fg: "foreground", bg: "background" },
];

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];

const FONT_KIND: Record<BrandFont, string> = {
  Geist: "Sans", Inter: "Sans", "IBM Plex Sans": "Sans", "DM Sans": "Sans", "Space Grotesk": "Sans",
  "Source Serif 4": "Serif", Fraunces: "Serif", "Instrument Serif": "Serif", "JetBrains Mono": "Mono", System: "The device's own",
};

function LayoutIcon(props: { layout: "card" | "split" | "minimal" }) {
  return (
    <svg class={styles.layoutIcon} viewBox="0 0 56 40" aria-hidden="true">
      <rect x="0.5" y="0.5" width="55" height="39" rx="6" fill="none" stroke="currentColor" stroke-opacity=".35" />
      {props.layout === "card" && <rect x="18" y="8" width="20" height="24" rx="4" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-opacity=".5" />}
      {props.layout === "split" && <><rect x="0.5" y="0.5" width="27" height="39" rx="6" fill="currentColor" fill-opacity=".12" /><rect x="34" y="11" width="16" height="3" rx="1.5" fill="currentColor" fill-opacity=".5" /><rect x="34" y="18" width="16" height="5" rx="2" fill="currentColor" fill-opacity=".3" /><rect x="34" y="26" width="16" height="5" rx="2" fill="currentColor" fill-opacity=".5" /></>}
      {props.layout === "minimal" && <><rect x="20" y="11" width="16" height="3" rx="1.5" fill="currentColor" fill-opacity=".5" /><rect x="20" y="18" width="16" height="5" rx="2" fill="currentColor" fill-opacity=".3" /><rect x="20" y="26" width="16" height="5" rx="2" fill="currentColor" fill-opacity=".5" /></>}
    </svg>
  );
}

function Group(props: { title: string; description?: JSX.Element; children: JSX.Element; actions?: JSX.Element }) {
  return (
    <fieldset class={styles.group}>
      <legend class="sr-only">{props.title}</legend>
      <div class={styles.groupHead} aria-hidden="true">
        <span class={styles.groupTitle}>{props.title}</span>
        <Show when={props.actions}><span class={styles.groupActions}>{props.actions}</span></Show>
      </div>
      <Show when={props.description}><p class={styles.groupDescription}>{props.description}</p></Show>
      {props.children}
    </fieldset>
  );
}

export default function BrandingTab() {
  const ctx = useDeveloperApp();
  const editor = ctx.editor;
  const branding = () => editor.draft.branding;
  const set = editor.setDraft;
  const fields = () => editor.fieldErrors("branding");
  const error = (path: string) => messageFor(fields(), path);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [palette, setPalette] = createSignal<PaintTheme>(siteTheme());
  const [visitorTheme, setVisitorTheme] = createSignal<PaintTheme>(siteTheme());
  const [device, setDevice] = createSignal<PreviewDevice>(typeof window !== "undefined" && window.innerWidth < 720 ? "phone" : "desktop");
  const [step, setStep] = createSignal<PreviewStep>("methods");
  const [logoError, setLogoError] = createSignal<{ which: "logo_url" | "logo_dark_url"; message: string } | null>(null);
  const [maxHeight, setMaxHeight] = createSignal(720);

  // The palette being edited is the one the preview shows (when the app follows the visitor's theme).
  createEffect(on(palette, value => setVisitorTheme(value), { defer: true }));
  const paint = () => resolveBrandTheme(branding().theme, visitorTheme());
  const forced = () => branding().theme !== "auto";

  onMount(() => {
    const measure = () => setMaxHeight(Math.max(420, Math.min(820, window.innerHeight - 190)));
    measure();
    window.addEventListener("resize", measure);
    onCleanup(() => window.removeEventListener("resize", measure));
    // Fonts load on demand; fetch the allowlist's stylesheets once the editor is idle, so picking a font repaints the
    // specimen and the preview at once instead of after a download.
    const timer = window.setTimeout(() => { for (const font of BRAND_FONTS) void loadBrandFont(font); }, 900);
    onCleanup(() => window.clearTimeout(timer));
  });

  const pickLogo = (which: "logo_url" | "logo_dark_url") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = LOGO_TYPES.join(",");
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      setLogoError(null);
      if (!LOGO_TYPES.includes(file.type)) {
        setLogoError({ which, message: `${file.name} is ${file.type || "an unknown type"}; logos can be PNG, JPEG, WebP, GIF or SVG.` });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result ?? "");
        if (url.length > MAX_INLINE_LOGO_BYTES) {
          setLogoError({ which, message: `${file.name} becomes ${Math.ceil(url.length / 1024)} KB inline; inline logos can be at most 128 KB (about 95 KB of image). Use a smaller file, or host it and paste an https URL.` });
          return;
        }
        set("branding", which, url);
      };
      reader.onerror = () => setLogoError({ which, message: `${file.name} could not be read by the browser. Try another file.` });
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const logoField = (which: "logo_url" | "logo_dark_url", label: string, description: string) => {
    const value = () => branding()[which] ?? "";
    const inline = () => value().startsWith("data:");
    return (
      <div class={styles.logoField}>
        <div class={styles.logoRow}>
          <span ref={el => useSquircle(el, { mode: "clip" })} class={styles.logoThumb} data-theme={which === "logo_dark_url" ? "dark" : "light"}>
            <Show when={value()} fallback={<span class={styles.logoNone}>None</span>}><img src={value()} alt="" /></Show>
          </span>
          <Show
            when={!inline()}
            fallback={
              <div class={styles.inlineLogo}>
                <span class={styles.inlineLabel}>{label}</span>
                <span class={styles.inlineMeta}>Uploaded image, {Math.ceil(value().length / 1024)} KB inline</span>
              </div>
            }
          >
            <Input label={label} mono type="url" placeholder="https://example.com/logo.svg" value={value()} onInput={event => set("branding", which, event.currentTarget.value || null)} error={error(`branding.${which}`)} />
          </Show>
        </div>
        <div class={styles.logoActions}>
          <Button size="sm" variant="secondary" onClick={() => pickLogo(which)}><Upload size={14} stroke-width={1.75} aria-hidden="true" />Upload</Button>
          <Show when={value()}><Button size="sm" variant="ghost" onClick={() => set("branding", which, null)}>Remove</Button></Show>
          <span class={styles.logoHint}>{description}</span>
        </div>
        <Show when={logoError()?.which === which}><p class={styles.fieldError} role="alert">{logoError()?.message}</p></Show>
        <Show when={inline() && error(`branding.${which}`)}>{message => <p class={styles.fieldError} role="alert">{message()}</p>}</Show>
      </div>
    );
  };

  // Option lists that hold JSX are built once here, not on every read.
  const paletteOptions = [{ value: "light" as const, label: "Light palette", icon: <Sun size={14} stroke-width={1.75} /> }, { value: "dark" as const, label: "Dark palette", icon: <Moon size={14} stroke-width={1.75} /> }];
  const themeOptions = [{ value: "light" as const, label: "Light", icon: <Sun size={14} stroke-width={1.75} /> }, { value: "dark" as const, label: "Dark", icon: <Moon size={14} stroke-width={1.75} /> }];
  const deviceOptions = [{ value: "desktop" as const, label: "Desktop", icon: <Laptop size={14} stroke-width={1.75} /> }, { value: "phone" as const, label: "Phone", icon: <Smartphone size={14} stroke-width={1.75} /> }];
  const layoutOptions = [
    { value: "card", label: "Card", description: "A centred card", icon: <LayoutIcon layout="card" /> },
    { value: "split", label: "Split", description: "Your side, then the form (folds to a card on phones)", icon: <LayoutIcon layout="split" /> },
    { value: "minimal", label: "Minimal", description: "The form alone, no card", icon: <LayoutIcon layout="minimal" /> },
  ];

  const resetPalette = () => set("branding", palette(), clone(palette() === "light" ? DEFAULT_LIGHT : DEFAULT_DARK));

  return (
    <div class={styles.layout} data-room={editor.dirty("branding") || undefined}>
      <div class={styles.controls}>
        <div class={styles.controlsHead}>
          <span class={styles.version}>Stored version {editor.version()}</span>
          <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}><History size={14} stroke-width={1.75} aria-hidden="true" />History</Button>
        </div>
        <EditorAlerts section="branding" editor={editor} />

        <Group title="Theme" description="Light, dark, or whichever the visitor's device uses.">
          <SegmentedControl
            label="Theme"
            value={branding().theme}
            onValueChange={value => set("branding", "theme", value)}
            options={[{ value: "auto", label: "Visitor's choice" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          />
        </Group>

        <Group
          title="Colours"
          description="Each theme has its own palette. Button text and page text need at least 3:1 contrast."
          actions={<Button size="sm" variant="ghost" onClick={resetPalette}><RotateCcw size={14} stroke-width={1.75} aria-hidden="true" />Reset</Button>}
        >
          <SegmentedControl
            label="Palette"
            size="sm"
            value={palette()}
            onValueChange={setPalette}
            options={paletteOptions}
          />
          <div class={styles.colours}>
            <For each={COLOURS}>
              {colour => (
                <div class={styles.colour} data-problem={error(`branding.${palette()}.${colour.key}`) ? "" : undefined}>
                  <ColorPicker
                    class={styles.picker}
                    label={colour.label}
                    value={branding()[palette()][colour.key]}
                    onValueChange={hex => set("branding", palette(), colour.key, hex.slice(0, 7).toUpperCase())}
                    background={branding()[palette()][colour.against]}
                    backgroundLabel={colour.againstLabel}
                  />
                </div>
              )}
            </For>
          </div>
          <div ref={el => useSquircle(el)} class={styles.checks} role="table" aria-label="Contrast checks">
            <div class={styles.checkRow} role="row">
              <span role="columnheader" class={styles.checkHead}>Contrast</span>
              <span role="columnheader" class={styles.checkHead}>Light</span>
              <span role="columnheader" class={styles.checkHead}>Dark</span>
            </div>
            <For each={CHECKS}>
              {check => (
                <div class={styles.checkRow} role="row">
                  <span role="rowheader" class={styles.checkLabel}>{check.label}</span>
                  <For each={["light", "dark"] as const}>
                    {themeName => {
                      const ratio = () => contrastRatio(branding()[themeName][check.fg], branding()[themeName][check.bg]);
                      const ok = () => (ratio() ?? 0) >= LIMITS.minContrast;
                      return (
                        <span role="cell" class={styles.checkCell} data-ok={ok() || undefined} title={ok() ? `${wcagLevel(ratio())} for normal text` : `Below 3:1; the server refuses it`}>
                          <span class={styles.ratio}>{formatRatio(ratio())}</span>
                          <Badge size="sm" tone={ok() ? (wcagLevel(ratio()) === "AA large" ? "neutral" : "success") : "danger"}>{ok() ? wcagLevel(ratio()) : "Too low"}</Badge>
                        </span>
                      );
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>
          <For each={Object.entries(fields()).filter(([path]) => /^branding\.(light|dark)\./.test(path))}>
            {([, message]) => <p class={styles.fieldError} role="alert">{message}</p>}
          </For>
        </Group>

        <Group title="Logo" description="Shown at the top of every sign-in page. Without one, the app's Silicon Apps logo is used.">
          {logoField("logo_url", "Logo", "https, or upload up to 128 KB")}
          {logoField("logo_dark_url", "Logo on dark", "Used by the dark theme; empty uses the logo above")}
          <RangeSlider label="Logo height" value={branding().logo_height} min={LIMITS.logoHeight.min} max={LIMITS.logoHeight.max} onChange={value => set("branding", "logo_height", value)} format={value => `${value} px`} error={error("branding.logo_height")} />
          <div class={styles.switchRow}>
            <span id="branding-show-name" class={styles.switchLabel}>Show the app name next to the logo</span>
            <Switch aria-labelledby="branding-show-name" checked={branding().show_app_name} onChange={on => set("branding", "show_app_name", on)} />
          </div>
        </Group>

        <Group title="Type" description="From the allowlist, served by Silicon Accounts (no third-party requests).">
          <Select label="Body font" value={branding().font_family} onValueChange={value => set("branding", "font_family", value as BrandFont)} options={BRAND_FONTS.map(font => ({ value: font, label: font, hint: FONT_KIND[font] }))} />
          <Select label="Heading font" value={branding().heading_font_family ?? ""} onValueChange={value => set("branding", "heading_font_family", (value || null) as BrandFont | null)} options={[{ value: "", label: "Same as the body", hint: branding().font_family }, ...BRAND_FONTS.map(font => ({ value: font, label: font, hint: FONT_KIND[font] }))]} />
          <div ref={el => useSquircle(el)} class={styles.specimen} aria-hidden="true">
            <span class={styles.specimenHeading} style={{ "font-family": FONT_STACKS[branding().heading_font_family ?? branding().font_family] }}>Sign in to {ctx.app().name}</span>
            <span class={styles.specimenBody} style={{ "font-family": FONT_STACKS[branding().font_family] }}>We send a 6 digit code to your email. It expires in 10 minutes.</span>
          </div>
        </Group>

        <Group title="Shape" description="Corner style and radius of buttons, fields and the card.">
          <SegmentedControl label="Corners" value={branding().corner_style} onValueChange={value => set("branding", "corner_style", value)} options={[{ value: "squircle", label: "Squircle" }, { value: "rounded", label: "Rounded" }, { value: "sharp", label: "Sharp" }]} />
          <RangeSlider label="Radius" value={branding().radius} min={LIMITS.radius.min} max={LIMITS.radius.max} onChange={value => set("branding", "radius", value)} format={value => `${value} px`} disabled={branding().corner_style === "sharp"} description={branding().corner_style === "sharp" ? "Sharp corners ignore the radius." : "Controls use it; the card scales from it."} error={error("branding.radius")} />
        </Group>

        <Group title="Layout">
          <RadioCards
            aria-label="Layout"
            value={branding().layout}
            onValueChange={value => set("branding", "layout", value as "card" | "split" | "minimal")}
            layout="list"
            options={layoutOptions}
          />
        </Group>

        <Group title="Background">
          <SegmentedControl label="Background" size="sm" value={branding().background_style} onValueChange={value => set("branding", "background_style", value)} options={[{ value: "plain", label: "Plain" }, { value: "dots", label: "Dots" }, { value: "grain", label: "Grain" }, { value: "gradient", label: "Gradient" }, { value: "image", label: "Image" }]} />
          <Show when={branding().background_style === "image"}>
            <Input label="Background image" type="url" mono placeholder="https://example.com/background.jpg" value={branding().background_image_url ?? ""} onInput={event => set("branding", "background_image_url", event.currentTarget.value || null)} error={error("branding.background_image_url")} description="https only; it is dimmed slightly so the card stays readable." />
          </Show>
        </Group>

        <Group title="Buttons" description="How the main action looks. Google and Apple buttons keep their own style.">
          <SegmentedControl label="Button style" value={branding().button_style} onValueChange={value => set("branding", "button_style", value)} options={[{ value: "solid", label: "Solid" }, { value: "soft", label: "Soft" }, { value: "outline", label: "Outline" }]} />
        </Group>

        <Group title="Density" description="Compact tightens padding and control heights.">
          <SegmentedControl label="Density" value={branding().density} onValueChange={value => set("branding", "density", value)} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
        </Group>

        <div class={styles.footerNote}>
          <p>The title, subtitle, terms, privacy link and support email come from the <button type="button" class={styles.link} onClick={() => ctx.openTab("sign-in")}>Sign-in tab</button>. “Powered by Silicon Accounts” is always shown and can't be changed.</p>
          <Button size="sm" variant="ghost" onClick={() => set("branding", clone(DEFAULT_BRANDING))}><RotateCcw size={14} stroke-width={1.75} aria-hidden="true" />Use the Silicon Accounts look</Button>
        </div>
      </div>

      <div class={styles.previewColumn}>
        <div class={styles.toolbar} role="toolbar" aria-label="Preview options">
          <SegmentedControl
            label="Preview theme"
            size="sm"
            value={paint()}
            onValueChange={value => { if (!forced()) setVisitorTheme(value); }}
            options={themeOptions}
          />
          <SegmentedControl label="Preview size" size="sm" value={device()} onValueChange={setDevice} options={deviceOptions} />
          <SegmentedControl label="Preview step" size="sm" value={step()} onValueChange={setStep} options={PREVIEW_STEPS} />
        </div>
        <HostedPreview
          app={{ name: ctx.app().name, logo_url: ctx.app().logo_url, logo_dark_url: ctx.app().logo_dark_url }}
          config={editor.draft}
          theme={paint()}
          step={step()}
          device={device()}
          host={hostOf(ctx.publicUrl())}
          maxHeight={maxHeight()}
        />
        <p class={styles.previewNote}>
          <Show when={forced()} fallback={<>Live, with your unsaved changes. Visitors see light or dark from their device.</>}>
            Live, with your unsaved changes. {ctx.app().name} always uses the {branding().theme} theme; set Theme to Visitor's choice to follow each device.
          </Show>
        </p>
      </div>

      <SaveBar section="branding" editor={editor} />
      <HistoryDrawer open={historyOpen()} onOpenChange={setHistoryOpen} appId={ctx.appId} editor={editor} section="branding" />
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "account.teamofsilicons.com";
  }
}
