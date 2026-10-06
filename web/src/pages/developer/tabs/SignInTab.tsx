/**
 * Sign-in: how this app signs Carbons in. Methods (on/off and order), Google and Apple (one click or bring your own,
 * with the exact callback URL to paste into the provider's console), redirect URIs, allowed origins, the details the
 * app requires or asks for, who may sign in, and the texts and links on the sign-in page. Saved together with
 * `expected_version`, so a concurrent change is caught instead of overwritten.
 */
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { History } from "lucide-solid";
import type { ContactField, SigninMethod } from "../../../api";
import { Badge } from "../../../arc/badge/badge";
import { prefersReducedMotion } from "../../../arc/lib/motion";
import { Button } from "../../../arc/button/button";
import { ChipGroup } from "../../../arc/chip-group/chip-group";
import { Input } from "../../../arc/input/input";
import { RadioCards } from "../../../arc/radio-cards/radio-cards";
import { Select } from "../../../arc/select/select";
import { Switch } from "../../../arc/switch/switch";
import { TagInput } from "../../../arc/tag-input/tag-input";
import { Textarea } from "../../../arc/textarea/textarea";
import { Section, SettingsGroup, SettingsRow, Surface } from "../../../app/layout/layout";
import { FIELD_LABELS } from "../../../lib/format";
import { LIMITS } from "../../../branding";
import { useDeveloperApp } from "../lib/context";
import { CONTACT_FIELDS } from "../lib/config";
import { messageFor } from "../lib/editor";
import { METHOD_LABEL } from "../lib/labels";
import { MAX_ALLOWED_ORIGINS, MAX_EMAIL_DOMAINS, MAX_REDIRECT_URIS, domainProblem, normalizeDomain, normalizeOrigin, originProblem, redirectUriProblem } from "../lib/validate";
import { CopyField } from "../parts/CopyField";
import { EditorAlerts } from "../parts/EditorAlerts";
import { HistoryDrawer } from "../parts/HistoryDrawer";
import { SaveBar } from "../parts/SaveBar";
import { SecretField } from "../parts/SecretField";
import { MethodList, type MethodRowInfo } from "./MethodList";
import styles from "./signin.module.css";

const ANCHORS = [
  { id: "signin-methods", label: "Methods" },
  { id: "signin-google", label: "Google" },
  { id: "signin-apple", label: "Apple" },
  { id: "signin-redirects", label: "Redirect URIs" },
  { id: "signin-origins", label: "Allowed origins" },
  { id: "signin-details", label: "Shared details" },
  { id: "signin-who", label: "Who can sign in" },
  { id: "signin-texts", label: "Texts and links" },
] as const;

const PROMPTS = [
  { value: "select_account", label: "Choose an account", hint: "select_account" },
  { value: "consent", label: "Ask for consent every time", hint: "consent" },
  { value: "consent select_account", label: "Consent and choose an account", hint: "consent select_account" },
  { value: "select_account consent", label: "Choose an account and consent", hint: "select_account consent" },
  { value: "none", label: "No prompt", hint: "none: fails if Google needs to ask" },
];

function Counter(props: { value: string | null; max: number }) {
  const length = () => [...(props.value ?? "")].length;
  return <span class={styles.counter} data-over={length() > props.max || undefined}>{length()}/{props.max}</span>;
}

export default function SignInTab() {
  const ctx = useDeveloperApp();
  const editor = ctx.editor;
  const draft = editor.draft;
  const set = editor.setDraft;
  const fields = () => editor.fieldErrors("signin");
  const error = (path: string) => messageFor(fields(), path);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const callback = (provider: "google" | "apple") => `${ctx.publicUrl()}/v1/oauth/callback/${provider}`;
  const publicHost = () => {
    try {
      return new URL(ctx.publicUrl()).host;
    } catch {
      return "account.teamofsilicons.com";
    }
  };
  const managedReady = (provider: "google" | "apple") => ctx.meta()?.providers[provider] ?? true;

  const methodInfo = (method: SigninMethod): MethodRowInfo => {
    if (method === "email") return { status: "A 6 digit code by email, valid for 10 minutes" };
    if (method === "phone") return { status: "A 6 digit code by SMS, valid for 10 minutes" };
    const config = draft[method];
    if (config.mode === "managed") {
      return {
        status: `One click, with Silicon Accounts' ${METHOD_LABEL[method]} setup`,
        warning: managedReady(method) ? null : `This deployment has no managed ${METHOD_LABEL[method]} credentials, so the button stays hidden. Bring your own below, or turn it off.`,
      };
    }
    const id = method === "google" ? draft.google.client_id : draft.apple.services_id;
    return { status: id ? `Bring your own: ${id}` : "Bring your own: finish the setup below" };
  };

  const setRequired = (next: string[]) => {
    const required = next as ContactField[];
    set("required_fields", required);
    set("optional_fields", draft.optional_fields.filter(field => !required.includes(field)));
  };
  const setOptional = (next: string[]) => {
    const optional = next as ContactField[];
    set("optional_fields", optional);
    set("required_fields", draft.required_fields.filter(field => !optional.includes(field)));
  };
  const fieldOptions = CONTACT_FIELDS.map(field => ({ value: field, label: FIELD_LABELS[field] }));

  const providerModes = (provider: "google" | "apple") => [
    {
      value: "managed",
      label: "One click",
      description: `Silicon Accounts runs the whole ${METHOD_LABEL[provider]} sign-in. ${METHOD_LABEL[provider]}'s consent page shows Silicon Accounts.`,
      meta: managedReady(provider) ? <Badge size="sm" tone="success" dot>Ready here</Badge> : <Badge size="sm" tone="warning">Not configured here</Badge>,
    },
    {
      value: "byo",
      label: "Bring your own",
      description: `Your own ${provider === "google" ? "OAuth client" : "Services ID and key"}. ${METHOD_LABEL[provider]}'s consent page shows your app's name and logo; Silicon Accounts only passes the result on.`,
    },
  ];

  // Created once (inside this component), so the cards' badges are not rebuilt every time RadioCards reads its options.
  const googleModes = createMemo(() => providerModes("google"));
  const appleModes = createMemo(() => providerModes("apple"));

  const section = (id: string, title: string, description: JSX.Element, children: JSX.Element, actions?: JSX.Element) => (
    <Section id={id} title={title} description={description} actions={actions} class={styles.section}>{children}</Section>
  );

  return (
    <div class={styles.layout} data-room={editor.dirty("signin") || undefined}>
      <div class={styles.form}>
        <EditorAlerts section="signin" editor={editor} />

        {section("signin-methods", "Sign-in methods", "Carbons pick one of these on the sign-in page, in this order. Silicons always sign in with their si:id and STK.", (
          <MethodList
            order={draft.method_order}
            enabled={draft.methods}
            onToggle={(method, on) => set("methods", method, on)}
            onReorder={order => set("method_order", order)}
            info={methodInfo}
            error={error("methods")}
          />
        ), <Button variant="ghost" size="sm" class={styles.historyButton} onClick={() => setHistoryOpen(true)}><History size={14} stroke-width={1.75} aria-hidden="true" />Version {editor.version()}</Button>)}

        {section("signin-google", "Google", <>How Continue with Google works{draft.methods.google ? "" : ". Google is off; you can still set it up before turning it on"}.</>, (
          <Surface class={styles.provider}>
            <RadioCards aria-label="Google sign-in" value={draft.google.mode} onValueChange={value => { set("google", "mode", value as "managed" | "byo"); if (value === "managed") editor.setSecrets("googleSecret", ""); }} options={googleModes()} minColumnWidth={300} />
            <Show when={draft.google.mode === "byo"}>
              <ol class={styles.steps}>
                <li>In Google Cloud Console, create an OAuth client of type Web application.</li>
                <li>
                  <span>Add this authorized redirect URI to it, exactly:</span>
                  <CopyField label="Authorized redirect URI" value={callback("google")} copyLabel="Copy URI" />
                </li>
                <li>Paste the client ID and secret here, then save.</li>
              </ol>
              <div class={styles.grid2}>
                <Input label="Client ID" mono placeholder="1234567890-abc.apps.googleusercontent.com" value={draft.google.client_id ?? ""} onInput={event => set("google", "client_id", event.currentTarget.value || null)} error={error("google.client_id")} autocomplete="off" spellcheck={false} />
                <SecretField
                  label="Client secret"
                  storedLabel="A client secret is stored"
                  stored={editor.stored().google}
                  value={editor.secrets.googleSecret}
                  onValueChange={value => editor.setSecrets("googleSecret", value)}
                  remove={editor.secrets.googleRemove}
                  onRemoveChange={remove => editor.setSecrets({ googleRemove: remove, googleSecret: "" })}
                  placeholder="GOCSPX-…"
                  error={error("google.client_secret")}
                />
              </div>
            </Show>
            <div class={styles.grid2}>
              <Select label="Account prompt" description="What Google asks before it signs someone in." value={draft.google.prompt ?? "select_account"} onValueChange={value => set("google", "prompt", value)} options={PROMPTS.map(option => ({ value: option.value, label: option.label, hint: option.hint }))} />
              <Input label="Workspace domain" description="Google's hd hint: it suggests accounts of this domain only. Allowed email domains below enforce it." placeholder="example.com" value={draft.google.hosted_domain ?? ""} onInput={event => set("google", "hosted_domain", event.currentTarget.value || null)} error={error("google.hosted_domain")} spellcheck={false} />
            </div>
          </Surface>
        ))}

        {section("signin-apple", "Apple", <>How Continue with Apple works{draft.methods.apple ? "" : ". Apple is off; you can still set it up before turning it on"}.</>, (
          <Surface class={styles.provider}>
            <RadioCards aria-label="Apple sign-in" value={draft.apple.mode} onValueChange={value => { set("apple", "mode", value as "managed" | "byo"); if (value === "managed") editor.setSecrets("appleKey", ""); }} options={appleModes()} minColumnWidth={300} />
            <Show when={draft.apple.mode === "byo"}>
              <ol class={styles.steps}>
                <li>In your Apple developer account, create a Services ID and turn on Sign in with Apple for it.</li>
                <li>
                  <span>Configure it with this domain and return URL, exactly:</span>
                  <div class={styles.grid2}>
                    <CopyField label="Domain" value={publicHost()} copyLabel="Copy domain" />
                    <CopyField label="Return URL" value={callback("apple")} copyLabel="Copy URL" />
                  </div>
                </li>
                <li>Create a key with Sign in with Apple, download its .p8 file, and paste it below with the IDs.</li>
              </ol>
              <div class={styles.grid3}>
                <Input label="Services ID" mono placeholder="com.example.signin" value={draft.apple.services_id ?? ""} onInput={event => set("apple", "services_id", event.currentTarget.value || null)} error={error("apple.services_id")} spellcheck={false} autocomplete="off" />
                <Input label="Team ID" mono placeholder="ABCDE12345" maxLength={10} value={draft.apple.team_id ?? ""} onInput={event => set("apple", "team_id", event.currentTarget.value.toUpperCase() || null)} error={error("apple.team_id")} spellcheck={false} autocomplete="off" />
                <Input label="Key ID" mono placeholder="KEY1234567" maxLength={10} value={draft.apple.key_id ?? ""} onInput={event => set("apple", "key_id", event.currentTarget.value.toUpperCase() || null)} error={error("apple.key_id")} spellcheck={false} autocomplete="off" />
              </div>
              <SecretField
                label="Private key (.p8)"
                storedLabel="A private key is stored"
                stored={editor.stored().apple}
                value={editor.secrets.appleKey}
                onValueChange={value => editor.setSecrets("appleKey", value)}
                remove={editor.secrets.appleRemove}
                onRemoveChange={remove => editor.setSecrets({ appleRemove: remove, appleKey: "" })}
                placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
                multiline
                accept=".p8,.pem,.txt"
                error={error("apple.private_key")}
              />
            </Show>
          </Surface>
        ))}

        {section("signin-redirects", "Redirect URIs", "Where the sign-in sends the browser back, with ?code= and &state=. A request must match one of these exactly; http://localhost and http://127.0.0.1 match on any port.", (
          <TagInput
            label="Redirect URIs"
            mono
            placeholder="https://app.example.com/auth/callback"
            value={draft.redirect_uris}
            onValueChange={value => set("redirect_uris", value)}
            normalize={value => value.trim()}
            validate={tag => redirectUriProblem(tag)}
            maxTags={MAX_REDIRECT_URIS}
            description="Press Enter after each one. Native apps can use a reverse-domain scheme like com.example.app:/callback."
            error={error("redirect_uris")}
          />
        ))}

        {section("signin-origins", "Allowed origins", "Sites that may show the sign-in iframe (also the SDK's iframe mode). Without one, the iframe shows a configuration error; the hosted link and the SDK's buttons work on any site.", (
          <TagInput
            label="Allowed origins"
            mono
            placeholder="https://app.example.com"
            value={draft.allowed_origins}
            onValueChange={value => set("allowed_origins", value)}
            normalize={normalizeOrigin}
            validate={tag => originProblem(tag)}
            maxTags={MAX_ALLOWED_ORIGINS}
            description="Scheme and host (and port), no path: https://app.example.com or http://localhost:3000."
            error={error("allowed_origins")}
          />
        ))}

        {section("signin-details", "Shared details", "Name, id and profile photo are always shared. Choose what else this app needs; Carbons see it on the what's-shared screen.", (
          <Surface class={styles.details}>
            <div class={styles.detailGroup}>
              <span class={styles.detailLabel}>Required</span>
              <span class={styles.detailHint}>A Carbon without one adds it before continuing.</span>
              <ChipGroup label="Required details" options={fieldOptions} value={draft.required_fields} onValueChange={setRequired} multiple />
            </div>
            <div class={styles.detailGroup}>
              <span class={styles.detailLabel}>Optional</span>
              <span class={styles.detailHint}>Offered with a switch; each Carbon decides.</span>
              <ChipGroup label="Optional details" options={fieldOptions} value={draft.optional_fields} onValueChange={setOptional} multiple />
            </div>
            <p class={styles.note}>Silicons have no email or phone, so those are skipped for them; their timezone and date of birth are shared when asked.</p>
            <Show when={error("optional_fields") ?? error("required_fields")}>{message => <p class={styles.fieldError} role="alert">{message()}</p>}</Show>
          </Surface>
        ))}

        {section("signin-who", "Who can sign in", "Rules applied before anyone reaches the app.", (
          <div class={styles.stack}>
            <SettingsGroup label="Sign-in rules">
              <SettingsRow label="Allow sign up" description="New Carbons can create an account while signing in. Off: only existing and imported accounts get in.">
                {ids => <Switch aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} checked={draft.allow_signup} onChange={on => set("allow_signup", on)} />}
              </SettingsRow>
              <SettingsRow label="Remember this browser" description="Offer “Continue as …” to a browser that is already signed in to Silicon Accounts.">
                {ids => <Switch aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} checked={draft.remember_browser} onChange={on => set("remember_browser", on)} />}
              </SettingsRow>
            </SettingsGroup>
            <TagInput
              label="Allowed email domains"
              mono
              placeholder="example.com"
              value={draft.allowed_email_domains}
              onValueChange={value => set("allowed_email_domains", value)}
              normalize={normalizeDomain}
              validate={tag => domainProblem(tag)}
              maxTags={MAX_EMAIL_DOMAINS}
              description={draft.allowed_email_domains.length ? "Only these domains may sign in with email, Google or Apple. Phone sign-in is not limited." : "Empty: any email domain may sign in. Add domains to limit email, Google and Apple sign-in to them."}
              error={error("allowed_email_domains")}
            />
          </div>
        ))}

        {section("signin-texts", "Texts and links", "Shown on the sign-in page. Branding previews them.", (
          <Surface class={styles.texts}>
            <Input label="Title" placeholder={`Sign in to ${ctx.app().name}`} value={draft.copy.title ?? ""} onInput={event => set("copy", "title", event.currentTarget.value || null)} error={error("copy.title")} suffix={<Counter value={draft.copy.title} max={LIMITS.titleMax} />} />
            <Textarea label="Subtitle" rows={2} placeholder="One line under the title" value={draft.copy.subtitle ?? ""} onInput={event => set("copy", "subtitle", event.currentTarget.value.replace(/\n/g, " ") || null)} error={error("copy.subtitle")} description={`${[...(draft.copy.subtitle ?? "")].length} of ${LIMITS.subtitleMax} characters`} />
            <div class={styles.grid2}>
              <Input label="Terms URL" type="url" mono placeholder="https://example.com/terms" value={draft.copy.terms_url ?? ""} onInput={event => set("copy", "terms_url", event.currentTarget.value || null)} error={error("copy.terms_url")} />
              <Input label="Privacy URL" type="url" mono placeholder="https://example.com/privacy" value={draft.copy.privacy_url ?? ""} onInput={event => set("copy", "privacy_url", event.currentTarget.value || null)} error={error("copy.privacy_url")} />
            </div>
            <Input label="Support email" type="email" placeholder="support@example.com" value={draft.copy.support_email ?? ""} onInput={event => set("copy", "support_email", event.currentTarget.value || null)} error={error("copy.support_email")} description="Shown to Carbons who get stuck." />
          </Surface>
        ))}
      </div>

      <aside class={styles.rail} aria-label="On this page">
        <nav class={styles.railNav}>
          <span class={styles.railTitle}>On this page</span>
          <For each={ANCHORS}>
            {anchor => (
              <a href={`#${anchor.id}`} class={styles.railLink} data-problem={Object.keys(fields()).some(path => belongsTo(path, anchor.id)) || undefined} onClick={event => { event.preventDefault(); goTo(anchor.id); }}>
                {anchor.label}
              </a>
            )}
          </For>
        </nav>
        <div class={styles.railVersion}>
          <span>Stored version {editor.version()}</span>
          <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}><History size={14} stroke-width={1.75} aria-hidden="true" />History</Button>
        </div>
      </aside>

      <SaveBar section="signin" editor={editor} />
      <HistoryDrawer open={historyOpen()} onOpenChange={setHistoryOpen} appId={ctx.appId} editor={editor} section="signin" />
    </div>
  );
}

/** Scrolls to a section and moves focus to its heading, so keyboard and screen reader users land there too. */
function goTo(id: string): void {
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  const heading = section.querySelector<HTMLElement>("h2, h3");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

function belongsTo(path: string, anchor: string): boolean {
  const map: Record<string, string[]> = {
    "signin-methods": ["methods", "method_order"],
    "signin-google": ["google"],
    "signin-apple": ["apple"],
    "signin-redirects": ["redirect_uris"],
    "signin-origins": ["allowed_origins"],
    "signin-details": ["required_fields", "optional_fields"],
    "signin-who": ["allow_signup", "remember_browser", "allowed_email_domains"],
    "signin-texts": ["copy"],
  };
  return (map[anchor] ?? []).some(prefix => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`));
}
