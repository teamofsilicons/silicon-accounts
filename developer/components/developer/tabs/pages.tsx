"use client";

/**
 * Pages: every page a Carbon sees while signing into the app, in the app's style. The words of the pages (the sign-in
 * and sign-up versions, the Opening page, terms, privacy and support) and every Branding variable are controls on the
 * left; on the right, a live preview of any page (method choice for signing in or up, Opening Google or Apple, the code
 * pages, setting up an account, each page of the flow, the review page, the embed buttons), light or dark, desktop or
 * phone, painted with the draft. Colours show their contrast live against the 4.5:1 minimum the server enforces;
 * "Powered by Silicon Accounts" stays on every page. Saving uses the config version so a concurrent change is caught.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { History, RotateCcw, Upload } from "lucide-react";
import { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import { ColorPicker } from "@/components/silicon-ui/color-picker/color-picker";
import { Input } from "@/components/silicon-ui/input/input";
import { Textarea } from "@/components/silicon-ui/textarea/textarea";
import { RadioCards, type RadioCardOption } from "@/components/silicon-ui/radio-cards/radio-cards";
import SegmentedControl from "@/components/silicon-ui/segmented-control/segmented-control";
import { Select } from "@/components/silicon-ui/select/select";
import { Switch } from "@/components/silicon-ui/switch/switch";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { BrandFont, BrandLayout, Palette } from "@/lib/api/types";
import { resolveBrandTheme, type PaintTheme } from "@/lib/branding/apply";
import { contrastRatio, formatRatio, wcagLevel } from "@/lib/branding/contrast";
import { BRAND_FONTS, DEFAULT_BRANDING, DEFAULT_DARK, DEFAULT_LIGHT, LIMITS } from "@/lib/branding/defaults";
import { FONT_STACKS, loadBrandFont } from "@/lib/branding/fonts";
import { hostOfUrl, useDeveloperApp } from "../lib/context";
import { messageFor, useEditor } from "../lib/editor";
import { clone } from "../lib/json";
import { MAX_INLINE_LOGO_BYTES, backgroundStyleEdits } from "../lib/validate";
import { EditorAlerts } from "../parts/editor-alerts";
import { HistoryDrawer } from "../parts/history-drawer";
import { RangeField } from "../parts/range-field";
import { SaveBar } from "../parts/save-bar";
import { HostedPreview, previewPages, type PreviewDevice, type PreviewPage } from "./hosted-preview";
import styles from "./pages.module.css";

const COLOURS: Array<{ key: keyof Palette; label: string; against: keyof Palette }> = [
  { key: "primary", label: "Primary", against: "primary_foreground" },
  { key: "primary_foreground", label: "Text on primary", against: "primary" },
  { key: "background", label: "Page background", against: "foreground" },
  { key: "surface", label: "Card", against: "foreground" },
  { key: "foreground", label: "Text", against: "background" },
  { key: "muted", label: "Muted text", against: "surface" },
  { key: "border", label: "Borders", against: "surface" },
  { key: "danger", label: "Errors", against: "surface" },
];

const CHECKS: Array<{ label: string; fg: keyof Palette; bg: keyof Palette }> = [
  { label: "Button text on primary", fg: "primary_foreground", bg: "primary" },
  { label: "Text on the page background", fg: "foreground", bg: "background" },
];

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
/** Radix Select needs a non-empty value for "Same as the body". */
const SAME_AS_BODY = "__body";

const FONT_KIND: Record<BrandFont, string> = {
  Geist: "sans", Inter: "sans", "IBM Plex Sans": "sans", "DM Sans": "sans", "Space Grotesk": "sans",
  "Source Serif 4": "serif", Fraunces: "serif", "Instrument Serif": "serif", "JetBrains Mono": "mono", System: "the device's own",
};

function LayoutIcon({ layout }: { layout: BrandLayout }) {
  return (
    <svg className={styles.layoutIcon} viewBox="0 0 56 40" aria-hidden="true">
      <rect x="0.5" y="0.5" width="55" height="39" rx="6" fill="none" stroke="currentColor" strokeOpacity=".35" />
      {layout === "card" ? <rect x="18" y="8" width="20" height="24" rx="4" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeOpacity=".5" /> : null}
      {layout === "split" ? (
        <>
          <rect x="0.5" y="0.5" width="27" height="39" rx="6" fill="currentColor" fillOpacity=".12" />
          <rect x="34" y="11" width="16" height="3" rx="1.5" fill="currentColor" fillOpacity=".5" />
          <rect x="34" y="18" width="16" height="5" rx="2" fill="currentColor" fillOpacity=".3" />
          <rect x="34" y="26" width="16" height="5" rx="2" fill="currentColor" fillOpacity=".5" />
        </>
      ) : null}
      {layout === "minimal" ? (
        <>
          <rect x="20" y="11" width="16" height="3" rx="1.5" fill="currentColor" fillOpacity=".5" />
          <rect x="20" y="18" width="16" height="5" rx="2" fill="currentColor" fillOpacity=".3" />
          <rect x="20" y="26" width="16" height="5" rx="2" fill="currentColor" fillOpacity=".5" />
        </>
      ) : null}
    </svg>
  );
}

function Group({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className={styles.group}>
      <legend className="sr-only">{title}</legend>
      <div className={styles.groupHead}>
        <h3 className={styles.groupTitle} aria-hidden="true">{title}</h3>
        {actions ? <span className={styles.groupActions}>{actions}</span> : null}
      </div>
      {description ? <p className={styles.groupDescription}>{description}</p> : null}
      {children}
    </fieldset>
  );
}

const LAYOUT_OPTIONS: RadioCardOption[] = [
  { value: "card", label: "Card", description: "A centred card", meta: <LayoutIcon layout="card" /> },
  { value: "split", label: "Split", description: "Your side, then the form (folds to a card on phones)", meta: <LayoutIcon layout="split" /> },
  { value: "minimal", label: "Minimal", description: "The form alone, no card", meta: <LayoutIcon layout="minimal" /> },
];

const fitHeight = () => Math.max(420, Math.min(820, window.innerHeight - 190));

/** Which page to show while a words field is being edited. */
const PAGE_FOR_COPY: Record<string, PreviewPage> = {
  title: { kind: "methods", intent: "signin" },
  subtitle: { kind: "methods", intent: "signin" },
  signup_title: { kind: "methods", intent: "signup" },
  signup_subtitle: { kind: "methods", intent: "signup" },
  opening_title: { kind: "opening", provider: "google" },
  terms_url: { kind: "methods", intent: "signin" },
  privacy_url: { kind: "methods", intent: "signin" },
  support_email: { kind: "methods", intent: "signin" },
};

export function PagesTab() {
  const ctx = useDeveloperApp();
  const editor = ctx.editor;
  const view = useEditor(editor);
  const branding = view.draft.branding;
  const copy = view.draft.copy;
  const fields = view.fieldErrors.pages;
  const error = (path: string) => messageFor(fields, path);
  const { theme: siteTheme } = useTheme();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [palette, setPalette] = useState<PaintTheme>(siteTheme);
  const [visitorTheme, setVisitorTheme] = useState<PaintTheme>(siteTheme);
  const [device, setDevice] = useState<PreviewDevice>(() => (window.innerWidth < 720 ? "phone" : "desktop"));
  const [pageKey, setPageKey] = useState("methods-signin");
  const [logoError, setLogoError] = useState<{ which: "logo_url" | "logo_dark_url"; message: string } | null>(null);
  const [maxHeight, setMaxHeight] = useState(fitHeight);
  const paint = resolveBrandTheme(branding.theme, visitorTheme);
  const forced = branding.theme !== "auto";

  useEffect(() => {
    const measure = () => setMaxHeight(fitHeight());
    window.addEventListener("resize", measure);
    // Fonts load on demand; fetch the allowlist's stylesheets once the editor is idle, so picking a font repaints the
    // specimen and the preview at once instead of after a download.
    const timer = window.setTimeout(() => {
      for (const font of BRAND_FONTS) void loadBrandFont(font);
    }, 900);
    return () => {
      window.removeEventListener("resize", measure);
      window.clearTimeout(timer);
    };
  }, []);

  /** The palette being edited is the one the preview shows (when the app follows the visitor's theme). */
  const choosePalette = (next: PaintTheme) => {
    setPalette(next);
    setVisitorTheme(next);
  };

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
        editor.edit(`branding.${which}`, url);
      };
      reader.onerror = () => setLogoError({ which, message: `${file.name} could not be read by the browser. Try another file.` });
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const logoField = (which: "logo_url" | "logo_dark_url", label: string, hint: string) => {
    const value = branding[which] ?? "";
    const inline = value.startsWith("data:");
    const problem = error(`branding.${which}`);
    return (
      <div className={styles.logoField}>
        <div className={styles.logoRow}>
          <span data-sq="clip" className={styles.logoThumb} data-theme={which === "logo_dark_url" ? "dark" : "light"}>
            {/* eslint-disable-next-line @next/next/no-img-element -- logos are arbitrary https or data URLs, shown as is. */}
            {value ? <img src={value} alt="" /> : <span className={styles.logoNone}>None</span>}
          </span>
          {inline ? (
            <div className={styles.inlineLogo}>
              <span className={styles.inlineLabel}>{label}</span>
              <span className={styles.inlineMeta}>Uploaded image, {Math.ceil(value.length / 1024)} KB inline</span>
            </div>
          ) : (
            <Input label={label} className={styles.mono} type="url" placeholder="https://example.com/logo.svg" value={value} onChange={event => editor.edit(`branding.${which}`, event.currentTarget.value || null)} error={problem} />
          )}
        </div>
        <div className={styles.logoActions}>
          <Button size="sm" variant="secondary" onClick={() => pickLogo(which)}><Upload size={14} strokeWidth={1.75} aria-hidden="true" />{`Upload ${label.toLowerCase()}`}</Button>
          {value ? <Button size="sm" variant="ghost" onClick={() => editor.edit(`branding.${which}`, null)}>Remove</Button> : null}
          <span className={styles.logoHint}>{hint}</span>
        </div>
        {logoError?.which === which ? <p className={styles.fieldError} role="alert">{logoError.message}</p> : null}
        {inline && problem ? <p className={styles.fieldError} role="alert">{problem}</p> : null}
      </div>
    );
  };

  const pages = previewPages(view.draft);
  const shownPage = (pages.find(option => option.key === pageKey) ?? pages[0])?.page ?? ({ kind: "methods", intent: "signin" } as PreviewPage);
  const show = (page: PreviewPage | undefined) => {
    if (!page) return;
    // That page, else the first of its kind the app has (the Opening title of an app with Apple but no Google).
    const option = pages.find(entry => JSON.stringify(entry.page) === JSON.stringify(page)) ?? pages.find(entry => entry.page.kind === page.kind);
    if (option) setPageKey(option.key);
  };
  const copyField = (key: "title" | "subtitle" | "signup_title" | "signup_subtitle" | "opening_title", label: string, placeholder: string, max: number, description?: string) => {
    const value = copy[key] ?? "";
    const length = [...value].length;
    const common = {
      label,
      placeholder,
      value,
      error: error(`copy.${key}`),
      description: `${description ? `${description} ` : ""}${length} of ${max} characters`,
      onFocus: () => show(PAGE_FOR_COPY[key]),
    };
    return max > LIMITS.titleMax
      ? <Textarea {...common} rows={2} onChange={event => editor.edit(`copy.${key}`, event.currentTarget.value.replace(/\n/g, " ") || null)} />
      : <Input {...common} onChange={event => editor.edit(`copy.${key}`, event.currentTarget.value || null)} />;
  };

  const fontOptions = useMemo(() => BRAND_FONTS.map(font => ({ value: font, label: `${font} (${FONT_KIND[font]})` })), []);
  const headingOptions = useMemo(() => [{ value: SAME_AS_BODY, label: `Same as the body (${branding.font_family})` }, ...fontOptions], [branding.font_family, fontOptions]);
  const paletteProblems = Object.entries(fields).filter(([path]) => /^branding\.(light|dark)\./.test(path));

  return (
    <div className={styles.layout} data-room={view.dirty.pages || undefined}>
      <div className={styles.controls}>
        <div className={styles.controlsHead}>
          <span className={styles.version}>{`Stored version ${view.version}`}</span>
          <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}><History size={14} strokeWidth={1.75} aria-hidden="true" />History</Button>
        </div>
        <EditorAlerts section="pages" editor={editor} />

        <Group title="Words" description="Empty fields keep the pages' own words. Each page also takes its own title, subtitle and button label on the Flows tab.">
          {copyField("title", "Sign-in title", `Sign in to ${ctx.app.name}`, LIMITS.titleMax)}
          {copyField("subtitle", "Sign-in subtitle", "One line under the title", LIMITS.subtitleMax)}
          {copyField("signup_title", "Sign-up title", `Create your ${ctx.app.name} account`, LIMITS.titleMax, "When your Sign up button sends people here (intent=signup).")}
          {copyField("signup_subtitle", "Sign-up subtitle", "One line under the sign-up title", LIMITS.subtitleMax)}
          {copyField("opening_title", "Opening page title", "Opening {provider} to sign you in to {app}…", LIMITS.titleMax, "Shown before Google or Apple; {provider} and {app} are filled in.")}
          <div className={styles.copyGrid}>
            <Input label="Terms URL" type="url" className={styles.mono} placeholder="https://example.com/terms" value={copy.terms_url ?? ""} onFocus={() => show(PAGE_FOR_COPY.terms_url)} onChange={event => editor.edit("copy.terms_url", event.currentTarget.value || null)} error={error("copy.terms_url")} />
            <Input label="Privacy URL" type="url" className={styles.mono} placeholder="https://example.com/privacy" value={copy.privacy_url ?? ""} onFocus={() => show(PAGE_FOR_COPY.privacy_url)} onChange={event => editor.edit("copy.privacy_url", event.currentTarget.value || null)} error={error("copy.privacy_url")} />
          </div>
          <Input label="Support email" type="email" placeholder="support@example.com" value={copy.support_email ?? ""} onFocus={() => show(PAGE_FOR_COPY.support_email)} onChange={event => editor.edit("copy.support_email", event.currentTarget.value || null)} error={error("copy.support_email")} description="Shown to Carbons who get stuck." />
        </Group>

        <Group title="Theme" description="Light, dark, or whichever the visitor's device uses.">
          <SegmentedControl label="Theme" value={branding.theme} onValueChange={value => editor.edit("branding.theme", value)} options={[{ value: "auto", label: "Visitor's choice" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </Group>

        <Group
          title="Colours"
          description="Each theme has its own palette. Button text and page text need at least 4.5:1 contrast."
          actions={<Button size="sm" variant="ghost" onClick={() => editor.edit(`branding.${palette}`, clone(palette === "light" ? DEFAULT_LIGHT : DEFAULT_DARK))}><RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />{`Reset ${palette}`}</Button>}
        >
          <SegmentedControl label="Palette" value={palette} onValueChange={value => choosePalette(value as PaintTheme)} options={[{ value: "light", label: "Light palette" }, { value: "dark", label: "Dark palette" }]} />
          <div className={styles.colours}>
            {COLOURS.map(colour => (
              <div key={`${palette}-${colour.key}`} className={styles.colour} data-problem={error(`branding.${palette}.${colour.key}`) ? "" : undefined}>
                <ColorPicker
                  label={colour.label}
                  value={branding[palette][colour.key]}
                  background={branding[palette][colour.against]}
                  onValueChange={hex => editor.edit(`branding.${palette}.${colour.key}`, hex.slice(0, 7).toUpperCase())}
                />
              </div>
            ))}
          </div>
          <div data-sq="surface" className={styles.checks} role="table" aria-label="Contrast checks">
            <div className={styles.checkRow} role="row">
              <span role="columnheader" className={styles.checkHead}>Contrast</span>
              <span role="columnheader" className={styles.checkHead}>Light</span>
              <span role="columnheader" className={styles.checkHead}>Dark</span>
            </div>
            {CHECKS.map(check => (
              <div key={check.label} className={styles.checkRow} role="row">
                <span role="rowheader" className={styles.checkLabel}>{check.label}</span>
                {(["light", "dark"] as const).map(themeName => {
                  const ratio = contrastRatio(branding[themeName][check.fg], branding[themeName][check.bg]);
                  const ok = (ratio ?? 0) >= LIMITS.minContrast;
                  const level = wcagLevel(ratio);
                  return (
                    <span key={themeName} role="cell" className={styles.checkCell} data-ok={ok || undefined} title={ok ? `${level} for normal text` : "Below 4.5:1; Silicon Accounts refuses it"}>
                      <span className={styles.ratio}>{formatRatio(ratio)}</span>
                      <Badge size="sm" tone={ok ? "success" : "danger"}>{ok ? level : "Too low"}</Badge>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          {paletteProblems.map(([path, message]) => <p key={path} className={styles.fieldError} role="alert">{message}</p>)}
        </Group>

        <Group title="Logo" description="Shown at the top of every sign-in page. Without one, the app's Silicon Apps logo is used.">
          {logoField("logo_url", "Logo", "https, or upload up to 128 KB")}
          {logoField("logo_dark_url", "Logo on dark", "For the dark theme; empty uses the logo above")}
          <RangeField label="Logo height" value={branding.logo_height} min={LIMITS.logoHeight.min} max={LIMITS.logoHeight.max} onChange={value => editor.edit("branding.logo_height", value)} format={value => `${value} px`} error={error("branding.logo_height")} />
          <div className={styles.switchRow}>
            <span id="branding-show-name" className={styles.switchLabel}>Show the app name next to the logo</span>
            <Switch aria-labelledby="branding-show-name" checked={branding.show_app_name} onCheckedChange={on => editor.edit("branding.show_app_name", on)} />
          </div>
        </Group>

        <Group title="Type" description="From the allowlist, served by Silicon Accounts (no third-party requests).">
          <Select label="Body font" value={branding.font_family} onValueChange={value => editor.edit("branding.font_family", value as BrandFont)} options={fontOptions} />
          <Select label="Heading font" value={branding.heading_font_family ?? SAME_AS_BODY} onValueChange={value => editor.edit("branding.heading_font_family", value === SAME_AS_BODY ? null : (value as BrandFont))} options={headingOptions} />
          <div data-sq="surface" className={styles.specimen} aria-hidden="true">
            <span className={styles.specimenHeading} style={{ fontFamily: FONT_STACKS[branding.heading_font_family ?? branding.font_family] }}>Sign in to {ctx.app.name}</span>
            <span className={styles.specimenBody} style={{ fontFamily: FONT_STACKS[branding.font_family] }}>We send a 6 digit code to your email. It expires in 10 minutes.</span>
          </div>
        </Group>

        <Group title="Shape" description="Corner style and radius of buttons, fields and the card.">
          <SegmentedControl label="Corners" value={branding.corner_style} onValueChange={value => editor.edit("branding.corner_style", value)} options={[{ value: "squircle", label: "Squircle" }, { value: "rounded", label: "Rounded" }, { value: "sharp", label: "Sharp" }]} />
          <RangeField
            label="Radius"
            value={branding.radius}
            min={LIMITS.radius.min}
            max={LIMITS.radius.max}
            onChange={value => editor.edit("branding.radius", value)}
            format={value => `${value} px`}
            disabled={branding.corner_style === "sharp"}
            description={branding.corner_style === "sharp" ? "Sharp corners ignore the radius." : "Controls use it; the card scales from it."}
            error={error("branding.radius")}
          />
        </Group>

        <Group title="Layout">
          <RadioCards aria-label="Layout" value={branding.layout} onValueChange={value => editor.edit("branding.layout", value)} layout="list" options={LAYOUT_OPTIONS} />
        </Group>

        <Group title="Background">
          <SegmentedControl label="Background" value={branding.background_style} onValueChange={value => editor.editMany(backgroundStyleEdits(branding, value as typeof branding.background_style))} options={[{ value: "plain", label: "Plain" }, { value: "dots", label: "Dots" }, { value: "grain", label: "Grain" }, { value: "gradient", label: "Gradient" }, { value: "image", label: "Image" }]} />
          {branding.background_style === "image" ? (
            <Input label="Background image" type="url" className={styles.mono} placeholder="https://example.com/background.jpg" value={branding.background_image_url ?? ""} onChange={event => editor.edit("branding.background_image_url", event.currentTarget.value || null)} error={error("branding.background_image_url")} description="https only; it is dimmed slightly so the card stays readable." />
          ) : null}
        </Group>

        <Group title="Buttons" description="How the main action looks. Google and Apple buttons keep their own style.">
          <SegmentedControl label="Button style" value={branding.button_style} onValueChange={value => editor.edit("branding.button_style", value)} options={[{ value: "solid", label: "Solid" }, { value: "soft", label: "Soft" }, { value: "outline", label: "Outline" }]} />
        </Group>

        <Group title="Density" description="Compact tightens padding and control heights.">
          <SegmentedControl label="Density" value={branding.density} onValueChange={value => editor.edit("branding.density", value)} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
        </Group>

        <div className={styles.footerNote}>
          <p>
            Which details are asked on which page, and each page&apos;s own title and layout, live on the{" "}
            <button type="button" className={styles.link} onClick={() => ctx.openTab("flows")}>Flows tab</button>. “Powered by Silicon Accounts” is always shown at the bottom of every page and can&apos;t be changed.
          </p>
          <Button size="sm" variant="ghost" onClick={() => editor.edit("branding", clone(DEFAULT_BRANDING))}><RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />Use the Silicon Accounts look</Button>
        </div>
      </div>

      <div className={styles.previewColumn}>
        <div className={styles.toolbar} role="toolbar" aria-label="Preview options">
          <SegmentedControl label="Preview theme" value={paint} onValueChange={value => { if (!forced) setVisitorTheme(value as PaintTheme); }} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
          <SegmentedControl label="Preview size" value={device} onValueChange={value => setDevice(value as PreviewDevice)} options={[{ value: "desktop", label: "Desktop" }, { value: "phone", label: "Phone" }]} />
        </div>
        <div className={styles.pagePicker}>
          <Select label="Page" value={pages.some(option => option.key === pageKey) ? pageKey : "methods-signin"} onValueChange={setPageKey} options={pages.map(option => ({ value: option.key, label: `${option.group}: ${option.label}` }))} />
          <div className={styles.pageChips} role="group" aria-label="Pages">
            {pages.map(option => (
              <button key={option.key} type="button" data-sq="surface" className={styles.pageChip} aria-pressed={option.key === pageKey} onClick={() => setPageKey(option.key)}>{option.label}</button>
            ))}
          </div>
        </div>
        <HostedPreview
          app={{ name: ctx.app.name, logo_url: ctx.app.logo_url, logo_dark_url: ctx.app.logo_dark_url }}
          config={view.draft}
          theme={paint}
          page={shownPage}
          device={device}
          host={hostOfUrl(ctx.publicUrl)}
          maxHeight={maxHeight}
        />
        <p className={styles.previewNote}>
          {forced
            ? `Live, with your unsaved changes. ${ctx.app.name} always uses the ${branding.theme} theme; set Theme to Visitor's choice to follow each device.`
            : "Live, with your unsaved changes. Visitors see light or dark from their device."}
        </p>
      </div>

      <SaveBar section="pages" editor={editor} />
      <HistoryDrawer open={historyOpen} onOpenChange={setHistoryOpen} appId={ctx.appId} editor={editor} section="pages" />
    </div>
  );
}
