"use client";

/**
 * Sign-in: how this app signs Carbons in. Methods (on, off and order), Google and Apple (one click or bring your own,
 * with the exact callback URL to paste into the provider's console), redirect URIs, allowed origins, the details the
 * app requires or asks for, who may sign in, and the texts and links on the sign-in page. Saved together with
 * `expected_version`, so a concurrent change is caught instead of overwritten.
 */
import { useMemo, useState, type ReactNode } from "react";
import { History } from "lucide-react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { ChipGroup } from "@/components/arc/chip-group/chip-group";
import { Input } from "@/components/arc/input/input";
import { RadioCards, type RadioCardOption } from "@/components/arc/radio-cards/radio-cards";
import { Select } from "@/components/arc/select/select";
import { Switch } from "@/components/arc/switch/switch";
import { Textarea } from "@/components/arc/textarea/textarea";
import { Section, SettingsGroup, SettingsRow, Surface } from "@/components/foundation/layout/layout";
import type { ContactField, SigninMethod } from "@/lib/api/types";
import { LIMITS } from "@/lib/branding/defaults";
import { FIELD_LABELS } from "@/lib/format";
import { CONTACT_FIELDS } from "../lib/config";
import { hostOfUrl, useDeveloperApp } from "../lib/context";
import { messageFor, messagesUnder, useEditor } from "../lib/editor";
import { under } from "../lib/json";
import { METHOD_LABEL } from "../lib/labels";
import { MAX_ALLOWED_ORIGINS, MAX_EMAIL_DOMAINS, MAX_REDIRECT_URIS, domainProblem, normalizeDomain, normalizeOrigin, originProblem, redirectUriProblem } from "../lib/validate";
import { CopyField } from "../parts/copy-field";
import { EditorAlerts } from "../parts/editor-alerts";
import { HistoryDrawer } from "../parts/history-drawer";
import { SaveBar } from "../parts/save-bar";
import { SecretField } from "../parts/secret-field";
import { TagField } from "../parts/tag-field";
import { MethodList, type MethodRowInfo } from "./method-list";
import styles from "./sign-in.module.css";

const ANCHORS = [
  { id: "signin-methods", label: "Methods", paths: ["methods", "method_order"] },
  { id: "signin-google", label: "Google", paths: ["google"] },
  { id: "signin-apple", label: "Apple", paths: ["apple"] },
  { id: "signin-redirects", label: "Redirect URIs", paths: ["redirect_uris"] },
  { id: "signin-origins", label: "Allowed origins", paths: ["allowed_origins"] },
  { id: "signin-details", label: "Shared details", paths: ["required_fields", "optional_fields"] },
  { id: "signin-who", label: "Who can sign in", paths: ["allow_signup", "remember_browser", "allowed_email_domains"] },
  { id: "signin-texts", label: "Texts and links", paths: ["copy"] },
] as const;

const PROMPTS = [
  { value: "select_account", label: "Choose an account (select_account)" },
  { value: "consent", label: "Ask for consent every time (consent)" },
  { value: "consent select_account", label: "Consent and choose an account" },
  { value: "select_account consent", label: "Choose an account and consent" },
  { value: "none", label: "No prompt (none: fails if Google needs to ask)" },
];

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Scrolls to a section and moves focus to its heading, so keyboard and screen reader users land there too. */
function goTo(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  const heading = section.querySelector<HTMLElement>("h2, h3");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

export function SignInTab() {
  const ctx = useDeveloperApp();
  const editor = ctx.editor;
  const view = useEditor(editor);
  const draft = view.draft;
  const fields = view.fieldErrors.signin;
  const error = (path: string) => messageFor(fields, path);
  const [historyOpen, setHistoryOpen] = useState(false);
  const callback = (provider: "google" | "apple") => `${ctx.publicUrl}/v1/oauth/callback/${provider}`;
  const managedReady = (provider: "google" | "apple") => ctx.meta?.providers[provider] ?? true;

  const methodInfo = (method: SigninMethod): MethodRowInfo => {
    if (method === "email") return { status: "A 6 digit code by email, valid for 10 minutes" };
    if (method === "phone") return { status: "A 6 digit code by SMS, valid for 10 minutes" };
    if (draft[method].mode === "managed") {
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
    editor.editMany({ required_fields: required, optional_fields: draft.optional_fields.filter(field => !required.includes(field)) });
  };
  const setOptional = (next: string[]) => {
    const optional = next as ContactField[];
    editor.editMany({ optional_fields: optional, required_fields: draft.required_fields.filter(field => !optional.includes(field)) });
  };
  const fieldOptions = CONTACT_FIELDS.map(field => ({ value: field, label: FIELD_LABELS[field] }));

  const googleReady = managedReady("google");
  const appleReady = managedReady("apple");
  const providerModes = useMemo(() => {
    const modes = (provider: "google" | "apple", ready: boolean): RadioCardOption[] => [
      {
        value: "managed",
        label: "One click",
        description: `Silicon Accounts runs the whole ${METHOD_LABEL[provider]} sign-in. ${METHOD_LABEL[provider]}'s consent page shows Silicon Accounts.`,
        meta: ready ? <Badge size="sm" tone="success">Ready here</Badge> : <Badge size="sm" tone="warning">Not configured here</Badge>,
      },
      {
        value: "byo",
        label: "Bring your own",
        description: `Your own ${provider === "google" ? "OAuth client" : "Services ID and key"}. ${METHOD_LABEL[provider]}'s consent page shows your app's name and logo; Silicon Accounts only passes the result on.`,
      },
    ];
    return { google: modes("google", googleReady), apple: modes("apple", appleReady) };
  }, [googleReady, appleReady]);

  const section = (id: string, title: string, description: ReactNode, children: ReactNode, actions?: ReactNode) => (
    <Section id={id} title={title} description={description} actions={actions} className={styles.section}>{children}</Section>
  );
  const titleLength = [...(draft.copy.title ?? "")].length;
  const subtitleLength = [...(draft.copy.subtitle ?? "")].length;

  return (
    <div className={styles.layout} data-room={view.dirty.signin || undefined}>
      <div className={styles.form}>
        <EditorAlerts section="signin" editor={editor} />

        {section(
          "signin-methods",
          "Sign-in methods",
          "Carbons pick one of these on the sign-in page, in this order. Silicons always sign in with their si:id and STK.",
          <MethodList
            order={draft.method_order}
            enabled={draft.methods}
            onToggle={(method, on) => editor.edit(`methods.${method}`, on)}
            onReorder={order => editor.edit("method_order", order)}
            info={methodInfo}
            error={error("methods")}
          />,
          <Button variant="ghost" size="sm" className={styles.historyButton} onClick={() => setHistoryOpen(true)} aria-label={`History: version ${view.version} is stored`}><History size={14} strokeWidth={1.75} aria-hidden="true" />{`Version ${view.version}`}</Button>,
        )}

        {section("signin-google", "Google", `How Continue with Google works${draft.methods.google ? "" : ". Google is off; you can still set it up before turning it on"}.`, (
          <Surface className={styles.provider}>
            <RadioCards
              aria-label="Google sign-in"
              value={draft.google.mode}
              onValueChange={value => {
                editor.edit("google.mode", value);
                if (value === "managed") editor.setSecrets({ googleSecret: "" });
              }}
              options={providerModes.google}
              minColumnWidth={260}
            />
            {draft.google.mode === "byo" ? (
              <>
                <ol className={styles.steps}>
                  <li>In Google Cloud Console, create an OAuth client of type Web application.</li>
                  <li>
                    <span>Add this authorized redirect URI to it, exactly:</span>
                    <CopyField label="Authorized redirect URI" value={callback("google")} copyLabel="Copy URI" />
                  </li>
                  <li>Paste the client ID and secret here, then save.</li>
                </ol>
                <div className={styles.grid2}>
                  <Input label="Client ID" className={styles.mono} placeholder="1234567890-abc.apps.googleusercontent.com" value={draft.google.client_id ?? ""} onChange={event => editor.edit("google.client_id", event.currentTarget.value || null)} error={error("google.client_id")} autoComplete="off" spellCheck={false} />
                  <SecretField
                    label="Client secret"
                    storedLabel="A client secret is stored"
                    stored={view.stored.google}
                    value={view.secrets.googleSecret}
                    onValueChange={value => editor.setSecrets({ googleSecret: value })}
                    remove={view.secrets.googleRemove}
                    onRemoveChange={remove => editor.setSecrets({ googleRemove: remove, googleSecret: "" })}
                    placeholder="GOCSPX-…"
                    error={error("google.client_secret")}
                  />
                </div>
              </>
            ) : null}
            <div className={styles.grid2}>
              <Select label="Account prompt" description="What Google asks before it signs someone in." value={draft.google.prompt ?? "select_account"} onValueChange={value => editor.edit("google.prompt", value)} options={PROMPTS} />
              <Input label="Workspace domain" description="Google's hd hint: it suggests accounts of this domain only. Allowed email domains below enforce it." placeholder="example.com" value={draft.google.hosted_domain ?? ""} onChange={event => editor.edit("google.hosted_domain", event.currentTarget.value || null)} error={error("google.hosted_domain")} spellCheck={false} />
            </div>
          </Surface>
        ))}

        {section("signin-apple", "Apple", `How Continue with Apple works${draft.methods.apple ? "" : ". Apple is off; you can still set it up before turning it on"}.`, (
          <Surface className={styles.provider}>
            <RadioCards
              aria-label="Apple sign-in"
              value={draft.apple.mode}
              onValueChange={value => {
                editor.edit("apple.mode", value);
                if (value === "managed") editor.setSecrets({ appleKey: "" });
              }}
              options={providerModes.apple}
              minColumnWidth={260}
            />
            {draft.apple.mode === "byo" ? (
              <>
                <ol className={styles.steps}>
                  <li>In your Apple developer account, create a Services ID and turn on Sign in with Apple for it.</li>
                  <li>
                    <span>Configure it with this domain and return URL, exactly:</span>
                    <div className={styles.grid2}>
                      <CopyField label="Domain" value={hostOfUrl(ctx.publicUrl)} copyLabel="Copy domain" />
                      <CopyField label="Return URL" value={callback("apple")} copyLabel="Copy URL" />
                    </div>
                  </li>
                  <li>Create a key with Sign in with Apple, download its .p8 file, and paste it below with the IDs.</li>
                </ol>
                <div className={styles.grid3}>
                  <Input label="Services ID" className={styles.mono} placeholder="com.example.signin" value={draft.apple.services_id ?? ""} onChange={event => editor.edit("apple.services_id", event.currentTarget.value || null)} error={error("apple.services_id")} spellCheck={false} autoComplete="off" />
                  <Input label="Team ID" className={styles.mono} placeholder="ABCDE12345" maxLength={10} value={draft.apple.team_id ?? ""} onChange={event => editor.edit("apple.team_id", event.currentTarget.value.toUpperCase() || null)} error={error("apple.team_id")} spellCheck={false} autoComplete="off" />
                  <Input label="Key ID" className={styles.mono} placeholder="KEY1234567" maxLength={10} value={draft.apple.key_id ?? ""} onChange={event => editor.edit("apple.key_id", event.currentTarget.value.toUpperCase() || null)} error={error("apple.key_id")} spellCheck={false} autoComplete="off" />
                </div>
                <SecretField
                  label="Private key (.p8)"
                  storedLabel="A private key is stored"
                  stored={view.stored.apple}
                  value={view.secrets.appleKey}
                  onValueChange={value => editor.setSecrets({ appleKey: value })}
                  remove={view.secrets.appleRemove}
                  onRemoveChange={remove => editor.setSecrets({ appleRemove: remove, appleKey: "" })}
                  placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
                  multiline
                  error={error("apple.private_key")}
                />
              </>
            ) : null}
          </Surface>
        ))}

        {section("signin-redirects", "Redirect URIs", "Where the sign-in sends the browser back, with ?code= and &state=. A request must match one of these exactly; http://localhost and http://127.0.0.1 match on any port.", (
          <TagField
            label="Redirect URIs"
            mono
            placeholder="https://app.example.com/auth/callback"
            value={draft.redirect_uris}
            onValueChange={value => editor.edit("redirect_uris", value)}
            typed={view.typed.redirect_uris ?? ""}
            onTypedChange={text => editor.setTyped("redirect_uris", text)}
            validate={tag => redirectUriProblem(tag)}
            max={MAX_REDIRECT_URIS}
            description="Press Enter after each one. Native apps can use a reverse-domain scheme like com.example.app:/callback."
            errors={messagesUnder(fields, "redirect_uris")}
          />
        ))}

        {section("signin-origins", "Allowed origins", "Sites that may show the sign-in iframe (and the SDK's iframe mode). Without one, the iframe shows a configuration error; the hosted link and the SDK's buttons work on any site.", (
          <TagField
            label="Allowed origins"
            mono
            placeholder="https://app.example.com"
            value={draft.allowed_origins}
            onValueChange={value => editor.edit("allowed_origins", value)}
            typed={view.typed.allowed_origins ?? ""}
            onTypedChange={text => editor.setTyped("allowed_origins", text)}
            normalize={normalizeOrigin}
            validate={tag => originProblem(tag)}
            max={MAX_ALLOWED_ORIGINS}
            description="Scheme and host (and port), no path: https://app.example.com or http://localhost:3000."
            errors={messagesUnder(fields, "allowed_origins")}
          />
        ))}

        {section("signin-details", "Shared details", "Name, id and profile photo are always shared. Choose what else this app needs; Carbons see it on the what's-shared screen.", (
          <Surface className={styles.details}>
            <div className={styles.detailGroup}>
              <span className={styles.detailLabel}>Required</span>
              <span className={styles.detailHint}>A Carbon without one adds it before continuing.</span>
              <ChipGroup label="Required details" options={fieldOptions} value={draft.required_fields} onValueChange={setRequired} multiple />
            </div>
            <div className={styles.detailGroup}>
              <span className={styles.detailLabel}>Optional</span>
              <span className={styles.detailHint}>Offered with a switch; each Carbon decides.</span>
              <ChipGroup label="Optional details" options={fieldOptions} value={draft.optional_fields} onValueChange={setOptional} multiple />
            </div>
            <p className={styles.note}>Silicons have no email or phone, so those are skipped for them; their timezone and date of birth are shared when asked.</p>
            {error("optional_fields") ?? error("required_fields") ? <p className={styles.fieldError} role="alert">{error("optional_fields") ?? error("required_fields")}</p> : null}
          </Surface>
        ))}

        {section("signin-who", "Who can sign in", "Rules applied before anyone reaches the app.", (
          <div className={styles.stack}>
            <SettingsGroup label="Sign-in rules">
              <SettingsRow label="Allow sign up" description="New Carbons can create an account while signing in. Off: only existing and imported accounts get in.">
                {ids => <Switch aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} checked={draft.allow_signup} onCheckedChange={on => editor.edit("allow_signup", on)} />}
              </SettingsRow>
              <SettingsRow label="Remember this browser" description="Offer “Continue as …” to a browser that is already signed in to Silicon Accounts.">
                {ids => <Switch aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} checked={draft.remember_browser} onCheckedChange={on => editor.edit("remember_browser", on)} />}
              </SettingsRow>
            </SettingsGroup>
            <TagField
              label="Allowed email domains"
              mono
              placeholder="example.com"
              value={draft.allowed_email_domains}
              onValueChange={value => editor.edit("allowed_email_domains", value)}
              typed={view.typed.allowed_email_domains ?? ""}
              onTypedChange={text => editor.setTyped("allowed_email_domains", text)}
              commaAdds
              normalize={normalizeDomain}
              validate={tag => domainProblem(tag)}
              max={MAX_EMAIL_DOMAINS}
              description={draft.allowed_email_domains.length ? "Only these domains may sign in with email, Google or Apple. Phone sign-in is not limited." : "Empty: any email domain may sign in. Add domains to limit email, Google and Apple sign-in to them."}
              errors={messagesUnder(fields, "allowed_email_domains")}
            />
          </div>
        ))}

        {section("signin-texts", "Texts and links", "Shown on the sign-in page. Branding previews them.", (
          <Surface className={styles.texts}>
            <Input label="Title" placeholder={`Sign in to ${ctx.app.name}`} value={draft.copy.title ?? ""} onChange={event => editor.edit("copy.title", event.currentTarget.value || null)} error={error("copy.title")} description={`${titleLength} of ${LIMITS.titleMax} characters`} />
            <Textarea label="Subtitle" rows={2} placeholder="One line under the title" value={draft.copy.subtitle ?? ""} onChange={event => editor.edit("copy.subtitle", event.currentTarget.value.replace(/\n/g, " ") || null)} error={error("copy.subtitle")} description={`${subtitleLength} of ${LIMITS.subtitleMax} characters`} />
            <div className={styles.grid2}>
              <Input label="Terms URL" type="url" className={styles.mono} placeholder="https://example.com/terms" value={draft.copy.terms_url ?? ""} onChange={event => editor.edit("copy.terms_url", event.currentTarget.value || null)} error={error("copy.terms_url")} />
              <Input label="Privacy URL" type="url" className={styles.mono} placeholder="https://example.com/privacy" value={draft.copy.privacy_url ?? ""} onChange={event => editor.edit("copy.privacy_url", event.currentTarget.value || null)} error={error("copy.privacy_url")} />
            </div>
            <Input label="Support email" type="email" placeholder="support@example.com" value={draft.copy.support_email ?? ""} onChange={event => editor.edit("copy.support_email", event.currentTarget.value || null)} error={error("copy.support_email")} description="Shown to Carbons who get stuck." />
          </Surface>
        ))}
      </div>

      <aside className={styles.rail} aria-label="On this page">
        <nav className={styles.railNav} aria-label="Sign-in settings">
          <span className={styles.railTitle}>On this page</span>
          {ANCHORS.map(anchor => (
            <a
              key={anchor.id}
              href={`#${anchor.id}`}
              className={styles.railLink}
              data-problem={Object.keys(fields).some(path => anchor.paths.some(prefix => under(path, prefix))) || undefined}
              onClick={event => {
                event.preventDefault();
                goTo(anchor.id);
              }}
            >
              {anchor.label}
            </a>
          ))}
        </nav>
        <div className={styles.railVersion}>
          <span>{`Stored version ${view.version}`}</span>
          <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}><History size={14} strokeWidth={1.75} aria-hidden="true" />History</Button>
        </div>
      </aside>

      <SaveBar section="signin" editor={editor} />
      <HistoryDrawer open={historyOpen} onOpenChange={setHistoryOpen} appId={ctx.appId} editor={editor} section="signin" />
    </div>
  );
}
