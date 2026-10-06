/**
 * A live picture of the hosted sign-in page as an app's draft config paints it: the same branding runtime
 * (BrandingScope, BrandStage, BrandAside, BrandPanel), the same Arc sign-in parts, and "Powered by Silicon Accounts"
 * outside the branded subtree, exactly as the hosted pages render them. A desktop page is laid out at 1024 px and
 * scaled to fit (so the split layout shows as it would); a phone page is 390 px wide. Nothing in it is interactive.
 */
import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Lock, Mail } from "lucide-solid";
import type { ContactField } from "../../../api";
import { Avatar } from "../../../arc/avatar/avatar";
import { Button } from "../../../arc/button/button";
import { Input } from "../../../arc/input/input";
import { OtpInput } from "../../../arc/otp-input/otp-input";
import { Switch as Toggle } from "../../../arc/switch/switch";
import { AccountRow, ProviderButton, ResendButton, SignInDivider, SignInHeading } from "../../../arc/blocks/sign-in/sign-in";
import { HeightFrame } from "../../../arc/lib/HeightFrame";
import { Swap } from "../../../arc/lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring } from "../../../arc/lib/motion";
import { useSquircle } from "../../../arc/lib/squircle";
import { BrandAside, BrandPanel, BrandStage, BrandingScope, PoweredBy, brandLogo, type PaintTheme } from "../../../branding";
import { FIELD_LABELS } from "../../../lib/format";
import type { EditableConfig } from "../lib/config";
import styles from "./preview.module.css";

export type PreviewStep = "methods" | "code" | "signup" | "consent";
export type PreviewDevice = "desktop" | "phone";

export const PREVIEW_STEPS: Array<{ value: PreviewStep; label: string }> = [
  { value: "methods", label: "Sign in" },
  { value: "code", label: "Code" },
  { value: "signup", label: "Set up" },
  { value: "consent", label: "Consent" },
];

const STEP_ORDER: PreviewStep[] = ["methods", "code", "signup", "consent"];
const SIZES: Record<PreviewDevice, { width: number; height: number }> = {
  desktop: { width: 1024, height: 700 },
  phone: { width: 390, height: 780 },
};

/** Sample values for the what's-shared rows (never a real person). */
const SAMPLE: Record<ContactField, string> = { email: "ada@example.com", phone: "+44 7700 900123", dob: "Mar 14, 1998", timezone: "Europe/London" };

interface Props {
  app: { name: string; logo_url: string | null; logo_dark_url?: string | null };
  config: EditableConfig;
  theme: PaintTheme;
  step: PreviewStep;
  device: PreviewDevice;
  /** Host shown in the desktop address bar. */
  host: string;
}

/** Lays content out at a fixed size and scales it to the available width (and height), without reflowing it. */
function Scaled(props: { width: number; height: number; maxHeight?: number; children: JSX.Element }) {
  let outer: HTMLDivElement | undefined;
  const [available, setAvailable] = createSignal(props.width);
  onMount(() => {
    if (!outer) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry?.contentRect.width ?? props.width));
    observer.observe(outer);
    onCleanup(() => observer.disconnect());
  });
  const scale = () => Math.min(1, available() / props.width, props.maxHeight ? props.maxHeight / props.height : 1);
  const offset = () => Math.max(0, (available() - props.width * scale()) / 2);
  return (
    <div ref={outer} class={styles.scaledOuter} style={{ height: `${Math.round(props.height * scale())}px` }}>
      <div class={styles.scaledInner} style={{ width: `${props.width}px`, height: `${props.height}px`, transform: `scale(${scale()})`, left: `${offset()}px` }}>
        {props.children}
      </div>
    </div>
  );
}

/** The step content morphs like the hosted card: the old step slides out softly while the next slides in. */
function StepMorph(props: { step: PreviewStep; children: (step: PreviewStep) => JSX.Element }) {
  // Forward steps arrive from the right, earlier steps from the left (computed before the swap runs).
  let last = props.step;
  const direction = createMemo(() => {
    const step = props.step;
    const value = Math.sign(STEP_ORDER.indexOf(step) - STEP_ORDER.indexOf(last)) || 1;
    last = step;
    return value;
  });
  return (
    <HeightFrame morphKey={props.step} contentClass={styles.stepTrack}>
      <Swap
        value={props.step}
        as="div"
        class={styles.step}
        enter={el => {
          if (prefersReducedMotion()) return;
          return animate(el, { opacity: [0, 1], x: [direction() * 24, 0], filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"] }, { x: spring.smooth, opacity: { duration: motionTokens.duration.standard, delay: 0.04 }, filter: { duration: motionTokens.duration.standard } });
        }}
        exit={el => {
          el.setAttribute("inert", "");
          if (prefersReducedMotion()) return animate(el, { opacity: 0 }, { duration: 0 });
          return animate(el, { opacity: 0, x: direction() * -18, filter: `blur(${motionTokens.blur.soft}px)` }, { x: spring.smooth, opacity: { duration: motionTokens.duration.exit } });
        }}
      >
        {step => props.children(step)}
      </Swap>
    </HeightFrame>
  );
}

function MethodsStep(props: { config: EditableConfig }) {
  type Block = { kind: "provider"; method: "google" | "apple" } | { kind: "form"; methods: Array<"email" | "phone"> };
  const blocks = createMemo<Block[]>(() => {
    const out: Block[] = [];
    let form: { kind: "form"; methods: Array<"email" | "phone"> } | null = null;
    for (const method of props.config.method_order) {
      if (!props.config.methods[method]) continue;
      if (method === "google" || method === "apple") out.push({ kind: "provider", method });
      else if (form) form.methods.push(method);
      else {
        form = { kind: "form", methods: [method] };
        out.push(form);
      }
    }
    return out;
  });
  // Providers that sit next to each other form one group; a divider separates the group from the code form.
  const groups = createMemo(() => {
    const out: Block[][] = [];
    for (const block of blocks()) {
      const last = out[out.length - 1];
      if (last && block.kind === "provider" && last[0]?.kind === "provider") last.push(block);
      else out.push([block]);
    }
    return out;
  });
  return (
    <Show when={blocks().length} fallback={<p class={styles.empty}>No sign-in method is on. Turn one on in the Sign-in tab.</p>}>
      <For each={groups()}>
        {(group, index) => (
          <>
            <Show when={index() > 0}><SignInDivider /></Show>
            <Show
              when={group[0]?.kind === "form" ? (group[0] as { methods: Array<"email" | "phone"> }) : null}
              fallback={<div class={styles.providers}><For each={group as Array<{ kind: "provider"; method: "google" | "apple" }>}>{block => <ProviderButton provider={block.method} />}</For></div>}
            >
              {form => (
                <div class={styles.form}>
                  <Show when={form().methods[0] === "email"} fallback={<Input label="Phone number" type="tel" placeholder="+1 202 555 0142" />}>
                    <Input label="Email" type="email" placeholder="name@example.com" />
                  </Show>
                  <Button class={styles.wide}>Continue</Button>
                  <Show when={form().methods.length > 1}>
                    <span class={styles.textLink}>{form().methods[0] === "email" ? "Use a phone number instead" : "Use an email instead"}</span>
                  </Show>
                </div>
              )}
            </Show>
          </>
        )}
      </For>
      <Show when={!props.config.allow_signup}><p class={styles.small}>Only existing accounts can sign in here.</p></Show>
    </Show>
  );
}

function CodeStep() {
  const resendAt = Date.now() + 27_000;
  return (
    <>
      <SignInHeading title="Check your email" description="We sent a 6 digit code to a***@example.com. It expires in 10 minutes." />
      <AccountRow name="ada@example.com" detail="Sign-in code sent" action={<span class={styles.textLink}>Change</span>} />
      <OtpInput label="Verification code" value="481" />
      <Button class={styles.wide}>Verify</Button>
      <ResendButton availableAt={resendAt} onResend={() => undefined} />
    </>
  );
}

function SignupStep() {
  return (
    <>
      <SignInHeading title="Set up your account" description="Everything is filled in from your sign-in. Change anything you like." />
      <div class={styles.signupPhoto}>
        <Avatar name="Ada Okafor" size="lg" />
        <span class={styles.textLink}>Change photo</span>
      </div>
      <Input label="Display name" value="Ada Okafor" />
      <Input label="Id" prefix="c:" mono value="ada" description="c:ada is available." />
      <div class={styles.pair}>
        <Input label="Timezone" value="Europe/London" />
        <Input label="Date of birth" value="Mar 14, 1998" />
      </div>
      <Button class={styles.wide}>Continue</Button>
    </>
  );
}

function ConsentStep(props: { appName: string; config: EditableConfig }) {
  return (
    <>
      <SignInHeading title={`${props.appName} would like to know`} description="It sees only what is listed here." />
      <AccountRow name="Ada Okafor" detail="c:ada" action={<span class={styles.textLink}>Switch</span>} />
      <ul class={styles.shared} role="list">
        <li><span class={styles.sharedText}><span>Name, id and profile photo</span><span class={styles.sharedValue}>Ada Okafor · c:ada</span></span><Lock size={14} stroke-width={1.75} aria-hidden="true" class={styles.lock} /></li>
        <For each={props.config.required_fields}>
          {field => <li><span class={styles.sharedText}><span>{FIELD_LABELS[field]}</span><span class={styles.sharedValue}>{SAMPLE[field]}</span></span><Lock size={14} stroke-width={1.75} aria-hidden="true" class={styles.lock} /></li>}
        </For>
        <For each={props.config.optional_fields}>
          {field => <li><span class={styles.sharedText}><span>{FIELD_LABELS[field]}</span><span class={styles.sharedValue}>{SAMPLE[field]}</span></span><Toggle aria-label={`Share ${FIELD_LABELS[field]}`} defaultChecked /></li>}
        </For>
      </ul>
      <div class={styles.actions}>
        <Button class={styles.wide}>Continue</Button>
        <Button variant="ghost" class={styles.wide}>Cancel</Button>
      </div>
    </>
  );
}

function Legal(props: { appName: string; config: EditableConfig }) {
  const copy = () => props.config.copy;
  return (
    <>
      <Show when={copy().terms_url || copy().privacy_url}>
        <p class="sa-brand-legal">
          By continuing you accept the{" "}
          <Show when={copy().terms_url}><a href={copy().terms_url ?? "#"} tabIndex={-1}>terms</a></Show>
          <Show when={copy().terms_url && copy().privacy_url}> and </Show>
          <Show when={copy().privacy_url}><a href={copy().privacy_url ?? "#"} tabIndex={-1}>privacy policy</a></Show>
          {" "}of {props.appName}.
        </p>
      </Show>
      <Show when={copy().support_email}>
        <p class="sa-brand-legal"><Mail size={12} stroke-width={1.75} aria-hidden="true" class={styles.inlineIcon} />Need help? {copy().support_email}</p>
      </Show>
    </>
  );
}

export function HostedPreview(props: Props & { maxHeight?: number }) {
  const size = () => SIZES[props.device];
  const branding = () => props.config.branding;
  const logo = () => brandLogo(branding(), { logo_url: props.app.logo_url, logo_dark_url: props.app.logo_dark_url ?? null }, props.theme);
  const title = () => props.config.copy.title?.trim() || `Sign in to ${props.app.name}`;
  const subtitle = () => props.config.copy.subtitle?.trim() || null;
  const header = () => (
    <div class="sa-brand-header">
      <Show when={logo()}>{src => <img class="sa-brand-logo" src={src()} alt="" />}</Show>
      <Show when={branding().show_app_name || !logo()}><span class="sa-brand-name">{props.app.name}</span></Show>
    </div>
  );
  const label = () => `Preview of the ${props.app.name} sign-in page: ${props.theme} theme, ${props.device}, ${PREVIEW_STEPS.find(step => step.value === props.step)?.label.toLowerCase()} step`;

  return (
    <div
      ref={el => useSquircle(el)}
      class={styles.frame}
      data-device={props.device}
      role="img"
      aria-label={label()}
      style={props.device === "phone" ? { width: `min(100%, ${Math.round(size().width * Math.min(1, props.maxHeight ? props.maxHeight / size().height : 1)) + 20}px)` } : undefined}
    >
      <Show when={props.device === "desktop"}>
        <div class={styles.chrome} aria-hidden="true">
          <span class={styles.dots}><i /><i /><i /></span>
          <span ref={el => useSquircle(el)} class={styles.address}>{props.host}/authorize?app_id=…</span>
        </div>
      </Show>
      <Scaled width={size().width} height={size().height} maxHeight={props.maxHeight}>
        <div ref={el => useSquircle(el, { mode: "clip" })} class={styles.page} inert>
          <BrandingScope branding={branding()} theme={props.theme} class={styles.scope}>
            <BrandStage>
              <BrandAside>
                {header()}
                <div>
                  <h2 class="sa-brand-title">{title()}</h2>
                  <Show when={subtitle()}>{text => <p class="sa-brand-subtitle">{text()}</p>}</Show>
                </div>
              </BrandAside>
              <BrandPanel as="section">
                {header()}
                <Show when={props.step === "methods"}>
                  <h1 class="sa-brand-title">{title()}</h1>
                  <Show when={subtitle()}>{text => <p class="sa-brand-subtitle">{text()}</p>}</Show>
                </Show>
                <div class="sa-brand-body">
                  <StepMorph step={props.step}>
                    {step => (
                      <Switch>
                        <Match when={step === "methods"}><MethodsStep config={props.config} /></Match>
                        <Match when={step === "code"}><CodeStep /></Match>
                        <Match when={step === "signup"}><SignupStep /></Match>
                        <Match when={step === "consent"}><ConsentStep appName={props.app.name} config={props.config} /></Match>
                      </Switch>
                    )}
                  </StepMorph>
                </div>
                <Legal appName={props.app.name} config={props.config} />
              </BrandPanel>
            </BrandStage>
          </BrandingScope>
          <PoweredBy theme={props.theme} overlay />
        </div>
      </Scaled>
    </div>
  );
}
