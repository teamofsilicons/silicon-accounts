/**
 * Style guide specimens: every ported Arc component in use with Silicon Accounts content (sample data only).
 */
import { For, createSignal, type JSX } from "solid-js";
import { ArrowRight, Copy, Cpu, KeyRound, LayoutGrid, LogOut, Pencil, Settings, ShieldCheck, Trash2 } from "lucide-solid";
import { Accordion } from "../../arc/accordion/accordion";
import { ActionButton } from "../../arc/action-button/action-button";
import { Alert } from "../../arc/alert/alert";
import { AnimatedCounter } from "../../arc/animated-counter/animated-counter";
import { Avatar } from "../../arc/avatar/avatar";
import { AvatarGroup } from "../../arc/avatar-group/avatar-group";
import { Badge } from "../../arc/badge/badge";
import { BottomSheet, BottomSheetTrigger } from "../../arc/bottom-sheet/bottom-sheet";
import { Button, LinkButton } from "../../arc/button/button";
import { Calendar } from "../../arc/calendar/calendar";
import { Card } from "../../arc/card/card";
import { Checkbox } from "../../arc/checkbox/checkbox";
import { ChipGroup } from "../../arc/chip-group/chip-group";
import { CodeBlock } from "../../arc/code-block/code-block";
import { ColorPicker } from "../../arc/color-picker/color-picker";
import { Combobox } from "../../arc/combobox/combobox";
import { CommandPalette } from "../../arc/command-palette/command-palette";
import { ConfirmMorph } from "../../arc/confirm-morph/confirm-morph";
import { CopyButton } from "../../arc/copy-button/copy-button";
import { DatePicker } from "../../arc/date-picker/date-picker";
import { Dialog, DialogContent, DialogTrigger, DialogClose } from "../../arc/dialog/dialog";
import { Drawer, DrawerContent, DrawerTrigger } from "../../arc/drawer/drawer";
import { DropdownMenu } from "../../arc/dropdown-menu/dropdown-menu";
import { EmptyState } from "../../arc/empty-state/empty-state";
import { FileDropzone } from "../../arc/file-dropzone/file-dropzone";
import { FilterToolbar, type FilterChip, type FilterField } from "../../arc/filter-toolbar/filter-toolbar";
import { HoldToConfirm } from "../../arc/hold-to-confirm/hold-to-confirm";
import { InlineEdit } from "../../arc/inline-edit/inline-edit";
import { Input } from "../../arc/input/input";
import { JsonViewer } from "../../arc/json-viewer/json-viewer";
import { MetricCard } from "../../arc/metric-card/metric-card";
import { MorphSelect } from "../../arc/morph-select/morph-select";
import { OtpInput } from "../../arc/otp-input/otp-input";
import { Pagination } from "../../arc/pagination/pagination";
import { PhoneInput } from "../../arc/phone-input/phone-input";
import { Popover, PopoverContent, PopoverTrigger } from "../../arc/popover/popover";
import { Progress } from "../../arc/progress/progress";
import { RadioCards } from "../../arc/radio-cards/radio-cards";
import { RadioGroup } from "../../arc/radio-group/radio-group";
import { ScrollArea } from "../../arc/scroll-area/scroll-area";
import { SearchField } from "../../arc/search-field/search-field";
import { SegmentedControl } from "../../arc/segmented-control/segmented-control";
import { Select } from "../../arc/select/select";
import { Skeleton } from "../../arc/skeleton/skeleton";
import { SlotText } from "../../arc/slot-text/slot-text";
import { SortableDataTable, type DataColumn } from "../../arc/sortable-data-table/sortable-data-table";
import { Stepper } from "../../arc/stepper/stepper";
import { Switch } from "../../arc/switch/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../arc/tabs/tabs";
import { TagInput } from "../../arc/tag-input/tag-input";
import { TextMorph } from "../../arc/text-morph/text-morph";
import { Textarea } from "../../arc/textarea/textarea";
import { Timeline, type TimelineEvent } from "../../arc/timeline/timeline";
import { Tooltip } from "../../arc/tooltip/tooltip";
import { SignInDemo } from "../../arc/blocks/sign-in/sign-in";
import { useSquircle } from "../../arc/lib/squircle";
import { notify } from "../../app/notify";
import { IdentityCard, IdentityField, LiveClock, StampRow } from "../../app/identity/IdentityCard";
import { SettingsGroup, SettingsRow, DescriptionList, DescriptionItem } from "../../app/layout/layout";
import { timezoneOptions } from "../../lib/timezones";
import { formatRelative } from "../../lib/format";
import styles from "./kitchen.module.css";

export function Specimen(props: { title: string; children: JSX.Element; class?: string }) {
  return (
    <section ref={el => useSquircle(el)} class={[styles.specimen, props.class ?? ""].join(" ")} aria-label={props.title}>
      <h3 class={styles.specimenTitle}>{props.title}</h3>
      <div class={styles.specimenBody}>{props.children}</div>
    </section>
  );
}

const icon = (Component: (props: { size?: number; "stroke-width"?: number }) => JSX.Element) => <Component size={16} stroke-width={1.75} />;
const appLogo = (hue: number, glyph: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 0C55.3 0 64 8.7 64 32S55.3 64 32 64 0 55.3 0 32 8.7 0 32 0Z" fill="hsl(${hue} 52% 42%)"/><text x="32" y="41" font-family="Georgia,serif" font-size="26" text-anchor="middle" fill="#fff">${glyph}</text></svg>`)}`;
export const SAMPLE_APPS = [
  { app_id: "briefcase", name: "Briefcase", logo: appLogo(214, "B") },
  { app_id: "dm", name: "DM", logo: appLogo(160, "D") },
  { app_id: "commit", name: "Commit", logo: appLogo(256, "C") },
  { app_id: "remind", name: "Remind", logo: appLogo(36, "R") },
  { app_id: "waveform", name: "Waveform", logo: appLogo(12, "W") },
  { app_id: "interface", name: "Silicon Interface", logo: appLogo(220, "I") },
];

/* ------------------------------------------------------------------------------------------------------------------ */

export function Foundations() {
  const swatches = ["--background", "--surface", "--surface-muted", "--foreground", "--text-secondary", "--border", "--accent", "--primary", "--success", "--warning", "--danger", "--control-on"];
  const sizes: Array<[string, string]> = [["--text-5xl", "Display"], ["--text-3xl", "Section"], ["--text-xl", "Title"], ["--text-base", "Body"], ["--text-sm", "Controls"], ["--text-xs", "Small"]];
  return (
    <div class={styles.wide}>
      <Specimen title="Semantic colours (live values for the current theme)">
        <div class={styles.swatchRow}>
          <For each={swatches}>
            {name => {
              let chip: HTMLSpanElement | undefined;
              const [value, setValue] = createSignal("");
              const read = () => { if (chip) setValue(getComputedStyle(chip).backgroundColor); };
              return (
                <div class={styles.swatch}>
                  <span ref={el => { chip = el; useSquircle(el); requestAnimationFrame(read); }} class={styles.swatchChip} style={{ background: `var(${name})` }} />
                  <span class={styles.swatchName}>{name}</span>
                  <span class={styles.swatchValue}>{value()}</span>
                </div>
              );
            }}
          </For>
        </div>
      </Specimen>
      <Specimen title="Type: Instrument Serif for display moments, Geist for the interface, JetBrains Mono for ids">
        <div class={styles.typeScale}>
          <For each={sizes}>
            {([token, label]) => (
              <div class={styles.typeRow}>
                <span class={styles.typeLabel}>{label}</span>
                <span style={{ "font-size": `var(${token})`, "font-family": token === "--text-5xl" || token === "--text-3xl" ? "var(--font-serif)" : "var(--font-body)", "line-height": 1.1 }}>One account for every Carbon and Silicon</span>
              </div>
            )}
          </For>
          <div class={styles.typeRow}><span class={styles.typeLabel}>Mono</span><span class="mono">c:saket · si:head_of_growth · a8K · briefcase:a8K</span></div>
        </div>
      </Specimen>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */

export function Actions() {
  const [label, setLabel] = createSignal("Save changes");
  const [confirmed, setConfirmed] = createSignal(false);
  return (
    <div class={styles.specimens}>
      <Specimen title="Button: one primary per surface">
        <div class={styles.row}>
          <Button onClick={() => setLabel(label() === "Save changes" ? "Saved" : "Save changes")}>{label()}</Button>
          <Button variant="secondary">Add an email</Button>
          <Button variant="ghost">Cancel</Button>
        </div>
        <div class={styles.row}>
          <Button variant="danger">Remove access</Button>
          <Button loading>Saving</Button>
          <Button variant="secondary" disabled>Not yet</Button>
        </div>
        <div class={styles.row}>
          <Button size="sm" variant="secondary">Small</Button>
          <Button size="lg">Create a Silicon<ArrowRight size={16} stroke-width={1.75} aria-hidden="true" /></Button>
          <LinkButton href="#actions" variant="ghost">A link that looks like a button</LinkButton>
        </div>
      </Specimen>
      <Specimen title="ActionButton and CopyButton">
        <div class={styles.row}>
          <ActionButton label="Save profile" pendingLabel="Saving" successLabel="Saved" onAction={() => new Promise(resolve => setTimeout(resolve, 900))} />
        </div>
        <div class={styles.row}>
          <CopyButton value="c:saket" label="Copy id" />
          <CopyButton value="a8K" label="Copy uuid" iconOnly />
          <CopyButton value="stk-3f9a1c0b7e24" label="Copy STK" variant="plain" />
          <CopyButton value="briefcase:a8K" label="Copy" size="xs" />
        </div>
      </Specimen>
      <Specimen title="ConfirmMorph and HoldToConfirm: destructive actions">
        <div class={styles.row}>
          <ConfirmMorph label="Remove access" prompt="Remove Briefcase's access?" confirmLabel="Remove" pendingLabel="Removing" doneLabel="Removed" icon={<Trash2 size={16} stroke-width={1.75} />} onConfirm={() => new Promise(resolve => setTimeout(resolve, 900))} />
        </div>
        <div class={styles.row}>
          <ConfirmMorph label="Revoke proof" tone="neutral" confirmLabel="Revoke" doneLabel="Revoked" onConfirm={() => new Promise((_, reject) => setTimeout(() => reject(new Error("The proof was already revoked.")), 800))} />
        </div>
        <div class={styles.row}>
          <HoldToConfirm label="Hold to rotate the STK" confirmedLabel="Rotated" confirmed={confirmed()} onConfirm={() => { setConfirmed(true); setTimeout(() => setConfirmed(false), 2400); }} icon={<KeyRound size={18} stroke-width={1.75} />} />
        </div>
      </Specimen>
      <Specimen title="DropdownMenu, Tooltip and Popover">
        <div class={styles.row}>
          <DropdownMenu
            label="Manage"
            items={[
              { label: "Edit details", icon: icon(Pencil), keys: ["E"] },
              { label: "Copy si:id", icon: icon(Copy), keys: ["⌘", "C"] },
              { label: "Settings", icon: icon(Settings) },
              { label: "Delete Silicon", icon: icon(Trash2), destructive: true, separatorBefore: true },
            ]}
          />
          <Tooltip content="Signs this browser out">{triggerProps => <Button {...triggerProps} variant="secondary" aria-label="Sign out"><LogOut size={16} stroke-width={1.75} aria-hidden="true" /></Button>}</Tooltip>
          <Popover>
            <PopoverTrigger as={Button} variant="secondary">What is a uuid?</PopoverTrigger>
            <PopoverContent>
              <p style={{ margin: 0, "font-size": "var(--text-sm)", "line-height": 1.5 }}>Your uuid never changes. Apps store it; your c:id is only what people see, and you can change it.</p>
            </PopoverContent>
          </Popover>
        </div>
      </Specimen>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */

export function Feedback() {
  const [count, setCount] = createSignal(1284);
  const [follow, setFollow] = createSignal("Pending");
  const [progress, setProgress] = createSignal(62);
  const [alertOpen, setAlertOpen] = createSignal(true);
  return (
    <div class={styles.specimens}>
      <Specimen title="TextMorph, SlotText and AnimatedCounter">
        <div class={styles.numbers}>
          <button type="button" class={styles.morphLabel} onClick={() => setFollow(follow() === "Pending" ? "Accepted" : "Pending")}><TextMorph>{follow()}</TextMorph></button>
          <button type="button" class={styles.morphLabel} onClick={() => setCount(count() + 137)}><SlotText value={count()} /></button>
        </div>
        <AnimatedCounter value={count()} label="Sign-ins this month" />
      </Specimen>
      <Specimen title="Badge: status always has a label">
        <div class={styles.row}>
          <Badge tone="success" dot>Active</Badge>
          <Badge tone="warning">Pending custodian</Badge>
          <Badge tone="info">Transfer pending</Badge>
          <Badge tone="danger">Revoked</Badge>
          <Badge>Imported</Badge>
          <Badge size="sm" tone="info">Primary</Badge>
        </div>
      </Specimen>
      <Specimen title="Alert: next to its cause">
        <Alert tone="info" title="Codes are valid for 10 minutes">Ask for a new one if it expires.</Alert>
        <Alert tone="warning" title="si:scout has no webhook">It will not hear about custodian changes until you add one.</Alert>
        <Alert tone="danger" title="That code is not right" action={<Button size="sm" variant="secondary">Send a new code</Button>}>You have 9 attempts left before a one minute pause.</Alert>
        <Alert tone="success" title="Webhook delivered" open={alertOpen()} onDismiss={() => { setAlertOpen(false); setTimeout(() => setAlertOpen(true), 1600); }}>The receiver answered 200 in 84 ms.</Alert>
      </Specimen>
      <Specimen title="Progress and Skeleton">
        <Progress label="Importing users" value={progress()} showValue />
        <div class={styles.row}>
          <Button size="sm" variant="secondary" onClick={() => setProgress(value => Math.min(100, value + 19))}>Advance</Button>
          <Button size="sm" variant="ghost" onClick={() => setProgress(8)}>Reset</Button>
        </div>
        <Progress label="Counting rows" indeterminate />
        <Skeleton lines={3} avatar label="Loading apps" />
      </Specimen>
      <Specimen title="Toasts: results of background work">
        <div class={styles.row}>
          <Button size="sm" variant="secondary" onClick={() => notify.success("Webhook secret rotated", "Update your receiver with the new whsec_ value.")}>Success</Button>
          <Button size="sm" variant="secondary" onClick={() => notify.info("Import queued", "48 rows will be processed in the background.")}>Info</Button>
          <Button size="sm" variant="secondary" onClick={() => notify.error({ status: 409, code: "id_taken", message: "c:saket is taken by another account.", hint: "Try c:saket-2 or another id." })}>Error</Button>
          <Button size="sm" variant="secondary" onClick={() => {
            const id = notify.loading("Rotating the STK", "Signing si:scout out everywhere");
            setTimeout(() => notify.update(id, { type: "success", title: "STK rotated", description: "The old STK stopped working." }), 1400);
          }}>Loading → done</Button>
        </div>
      </Specimen>
      <Specimen title="MetricCard (an app's overview)">
        <div class={styles.metrics}>
          <MetricCard label="Users" value={1284} context="Carbons and Silicons" change="+12%" />
          <MetricCard label="Active in 30 days" value={942} context="Signed in at least once" change="-3%" />
          <MetricCard label="Imported, not claimed" value={86} context="Finish setup on first sign-in" />
        </div>
      </Specimen>
      <Specimen title="EmptyState: why, and one next step">
        <EmptyState icon={<Cpu width={24} height={24} stroke-width={1.5} />} title="No Silicons yet" description="Silicons you are custodian of appear here." action={<Button variant="secondary">Create a Silicon</Button>} />
      </Specimen>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */

export function Identity() {
  return (
    <div class={styles.specimens}>
      <Specimen title="Avatar (squircle, clip mode) and AvatarGroup">
        <div class={styles.row}>
          <Avatar name="Saket Dev" size="xs" />
          <Avatar name="Saket Dev" size="sm" />
          <Avatar name="Saket Dev" size="md" />
          <Avatar name="Head of Growth" kind="silicon" size="lg" status="online" />
          <Avatar name="Atlas" kind="silicon" size="xl" />
        </div>
        <AvatarGroup label="Silicons in your care" members={[{ name: "Scout", kind: "silicon" }, { name: "Atlas", kind: "silicon" }, { name: "Courier", kind: "silicon" }, { name: "Head of Growth", kind: "silicon" }, { name: "Nova", kind: "silicon" }, { name: "Iris", kind: "silicon" }]} max={4} />
      </Specimen>
      <Specimen title="Identity card shell: tilt, flip, grain">
        <div class={styles.identityFrame}>
          <IdentityCard
            label="Sample identity card"
            front={
              <div class={styles.cardFace}>
                <div class={styles.cardWho}>
                  <Avatar name="Ada Okafor" size="lg" />
                  <p class={styles.cardName}>Ada Okafor</p>
                </div>
                <div class={styles.cardFields}>
                  <IdentityField label="Id" value="c:ada" mono copyLabel="Copy id" />
                  <IdentityField label="Local time" value="Europe/London"><LiveClock timeZone="Europe/London" /></IdentityField>
                </div>
                <StampRow apps={SAMPLE_APPS.map(app => ({ name: app.name, logoUrl: app.logo, seed: app.app_id }))} max={5} />
              </div>
            }
            back={<div class={styles.cardFace}><p class={styles.cardName}>Back</p><IdentityField label="uuid" value="k3Q" mono copyLabel="Copy uuid" /></div>}
          />
        </div>
      </Specimen>
      <Specimen title="Card with a quick look">
        <Card
          title="Briefcase"
          description="Files for Carbons and Silicons."
          avatar={<Avatar name="Briefcase" src={SAMPLE_APPS[0]?.logo} size="sm" />}
          meta="briefcase"
          status="Signed in 2 hours ago"
          details={<p>Briefcase can see your name, id, profile photo, email address and timezone.</p>}
        />
      </Specimen>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */

export function Fields() {
  const [search, setSearch] = createSignal("");
  const [tz, setTz] = createSignal("Asia/Kolkata");
  const [app, setApp] = createSignal<string | null>("briefcase");
  const [dob, setDob] = createSignal<Date | undefined>(new Date(1998, 2, 14));
  const [color, setColor] = createSignal("#1F5FB8");
  const [tags, setTags] = createSignal(["https://briefcase.example/auth/callback", "http://localhost:3000/callback"]);
  const [chips, setChips] = createSignal(["profile", "email", "timezone"]);
  const [otp, setOtp] = createSignal("");
  const [name, setName] = createSignal("Saket Dev");
  const zones = timezoneOptions(new Date(), ["Asia/Kolkata"]);
  return (
    <div class={styles.specimens}>
      <Specimen title="Input, Textarea and SearchField">
        <Input label="Display name" placeholder="Saket" description="Shown to every app you sign into." />
        <Input label="Id" prefix="c:" mono value="saket" error="c:saket is taken by another account. Try c:saket-2." />
        <Input label="Webhook URL" placeholder="https://example.com/hooks/accounts" disabled />
        <SearchField label="Search users" hideLabel value={search()} onValueChange={setSearch} placeholder="Search by id, name, email or phone" />
        <Textarea label="What happened?" placeholder="Describe the problem and how to reproduce it." />
      </Specimen>
      <Specimen title="PhoneInput, Select, Combobox (time zones) and MorphSelect">
        <PhoneInput label="Phone number" defaultCountry="IN" description="We send a 6 digit code by SMS." />
        <Select label="Theme" options={[{ value: "auto", label: "Match the device" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} defaultValue="auto" />
        <Combobox label="Timezone" value={tz()} onValueChange={setTz} options={zones} placeholder="Search a city or offset" />
        <MorphSelect
          label="App"
          value={app()}
          onValueChange={value => setApp(value)}
          items={[{ label: "Your apps", options: SAMPLE_APPS.map(entry => ({ value: entry.app_id, label: entry.name, meta: entry.app_id, icon: () => <img src={entry.logo} alt="" width={20} height={20} /> })) }]}
        />
      </Specimen>
      <Specimen title="DatePicker (date of birth, year grid) and Calendar">
        <DatePicker label="Date of birth" value={dob()} onChange={setDob} yearPicker maxDate={new Date()} required description="Apps that ask for it see this date." />
        <Calendar value={dob()} onChange={setDob} yearPicker maxDate={new Date()} />
      </Specimen>
      <Specimen title="OtpInput and InlineEdit">
        <OtpInput label="Verification code" value={otp()} onChange={setOtp} error={otp().length === 6 && otp() !== "123456" ? "That code is not right. 9 attempts left." : null} description="Sample code: 123456." />
        <InlineEdit label="Display name" value={name()} variant="display" onSave={next => new Promise(resolve => setTimeout(() => { setName(next); resolve(undefined); }, 600))} validate={next => (next.trim() ? null : "Enter a display name.")} />
      </Specimen>
      <Specimen title="TagInput and ChipGroup">
        <TagInput label="Redirect URIs" mono value={tags()} onValueChange={setTags} description="Exact match, including the path." validate={tag => (/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1))/.test(tag) ? null : "Use https, or http on localhost.")} />
        <ChipGroup label="Shared details" options={[{ value: "profile", label: "Profile" }, { value: "email", label: "Email" }, { value: "phone", label: "Phone" }, { value: "dob", label: "Date of birth" }, { value: "timezone", label: "Timezone" }]} value={chips()} onValueChange={setChips} locked={["profile"]} />
      </Specimen>
      <Specimen title="ColorPicker (branding) and FileDropzone (imports)">
        <ColorPicker label="Primary" value={color()} onValueChange={setColor} background="#FFFDF9" backgroundLabel="against the paper background" />
        <FileDropzone label="Import users" description="CSV or JSON, up to 50 MB." accept=".csv,.json,text/csv,application/json" note="Only these columns: external_id, email, emails, phone, phones, display_name, username, dob, timezone, pfp_url." />
      </Specimen>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */

export function Choices() {
  const [checked, setChecked] = createSignal(true);
  const [on, setOn] = createSignal(true);
  const [radio, setRadio] = createSignal("email");
  const [segment, setSegment] = createSignal("week");
  const [mode, setMode] = createSignal<string | null>("managed");
  const [layout, setLayout] = createSignal<string | null>("card");
  return (
    <div class={styles.specimens}>
      <Specimen title="Checkbox, Switch and SegmentedControl">
        <Checkbox label="Remember this browser" description="Offer “Continue as” next time." checked={checked()} onChange={setChecked} />
        <Switch label="Allow sign up" description="Off means only existing and imported accounts sign in." checked={on()} onChange={setOn} />
        <SegmentedControl label="Range" options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} value={segment()} onValueChange={setSegment} />
      </Specimen>
      <Specimen title="RadioGroup">
        <RadioGroup label="Sign in with" options={[{ value: "email", label: "Email", description: "A 6 digit code by email" }, { value: "phone", label: "Phone", description: "A 6 digit code by SMS" }, { value: "google", label: "Google", description: "Disabled for this app", disabled: true }]} value={radio()} onValueChange={setRadio} />
      </Specimen>
      <Specimen title="RadioCards (grid and list)">
        <RadioCards aria-label="Google sign-in" value={mode()} onValueChange={setMode} minColumnWidth={150} options={[{ value: "managed", label: "One click", description: "We run the whole Google sign-in for you." }, { value: "byo", label: "Bring your own", description: "Google shows your app's name and logo." }]} />
        <RadioCards aria-label="Layout" layout="list" value={layout()} onValueChange={setLayout} options={[{ value: "card", label: "Card", description: "A centred card", meta: "Default" }, { value: "split", label: "Split", description: "Your side and the form" }, { value: "minimal", label: "Minimal", description: "No card chrome" }]} />
      </Specimen>
      <Specimen title="Settings rows (layout primitive)">
        <SettingsGroup label="Telemetry">
          <SettingsRow label="Send telemetry" description="Context-rich events help us fix problems. Opted in by default.">
            {ids => <Switch aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} defaultChecked />}
          </SettingsRow>
          <SettingsRow label="Theme" description="Light, dark or match the device.">
            <Button size="sm" variant="secondary">Change</Button>
          </SettingsRow>
        </SettingsGroup>
        <DescriptionList>
          <DescriptionItem label="Membership">briefcase:a8K</DescriptionItem>
          <DescriptionItem label="First signed in">Sep 6, 2026</DescriptionItem>
        </DescriptionList>
      </Specimen>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */

const HOUR = 3_600_000;

export function Structure() {
  const [tab, setTab] = createSignal("overview");
  const [step, setStep] = createSignal(2);
  const [page, setPage] = createSignal(3);
  const now = Date.UTC(2026, 9, 6, 9, 41);
  const events: TimelineEvent[] = [
    { id: "e1", at: now - 0.05 * HOUR, actor: "You", title: "signed in to Briefcase", meta: "Email code · Safari on macOS", tone: "success" },
    { id: "e2", at: now - 0.5 * HOUR, actor: "DM", title: "got a proof for Briefcase", meta: "files.write · 30 minutes" },
    { id: "e3", at: now - 26 * HOUR, actor: "You", title: "changed your id to c:saket", meta: "c:saketdev stays reserved for you for 10 days", detail: () => <p style={{ margin: 0 }}>Apps were told through account.id_changed.</p> },
    { id: "e4", at: now - 50 * HOUR, actor: "si:scout", title: "failed to sign in", meta: "Wrong STK · 3 tries", tone: "danger" },
  ];
  return (
    <div class={styles.specimens}>
      <Specimen title="Tabs">
        <Tabs value={tab()} onValueChange={setTab}>
          <TabsList aria-label="App sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="branding">Branding</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
          </TabsList>
          <TabsContent value="overview"><p style={{ margin: 0 }}>1,284 users, 942 active in the last 30 days.</p></TabsContent>
          <TabsContent value="branding"><p style={{ margin: 0 }}>Colours, radius, fonts and layout of the sign-in pages.</p></TabsContent>
          <TabsContent value="users"><p style={{ margin: 0 }}>Every Carbon and Silicon that signed in.</p></TabsContent>
        </Tabs>
      </Specimen>
      <Specimen title="Stepper (import wizard) and Pagination">
        <Stepper label="Import users" current={step()} onStepSelect={setStep} steps={[{ id: "upload", label: "Upload", description: "CSV or JSON" }, { id: "check", label: "Check columns" }, { id: "options", label: "Options" }, { id: "run", label: "Run" }]} />
        <div class={styles.row}>
          <Button size="sm" variant="secondary" onClick={() => setStep(value => Math.max(0, value - 1))}>Back</Button>
          <Button size="sm" onClick={() => setStep(value => Math.min(4, value + 1))}>Next</Button>
        </div>
        <Pagination page={page()} pageCount={12} onPageChange={setPage} label="Users pages" />
      </Specimen>
      <Specimen title="Accordion">
        <Accordion items={[
          { title: "Why does my old id stay reserved?", content: <p style={{ margin: 0 }}>For 10 days nobody else can take it, and you can take it back.</p> },
          { title: "What does an app see?", content: <p style={{ margin: 0 }}>Your uuid, id, name and photo, plus what you agree to share.</p> },
        ]} />
      </Specimen>
      <Specimen title="ScrollArea">
        <ScrollArea class={styles.scrollBox} label="Recent sign-ins">
          <div class={styles.scrollList}>
            <For each={Array.from({ length: 14 }, (_, index) => index)}>
              {index => <div class={styles.scrollItem}><span>{SAMPLE_APPS[index % SAMPLE_APPS.length]?.name}</span><span class="muted">{formatRelative(now - index * 2.3 * HOUR, now)}</span></div>}
            </For>
          </div>
        </ScrollArea>
      </Specimen>
      <Specimen title="Timeline (activity by day)">
        <Timeline events={events} now={now} label="Account activity" timeZone="Asia/Kolkata" />
      </Specimen>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */

type UserRow = { id: string; display_name: string; kind: string; status: string; signins: number; last: number };

export function Data() {
  const now = Date.UTC(2026, 9, 6, 9, 41);
  const rows: UserRow[] = [
    { id: "c:saket", display_name: "Saket Dev", kind: "Carbon", status: "Active", signins: 128, last: now - 2 * 60_000 },
    { id: "si:scout", display_name: "Scout", kind: "Silicon", status: "Active", signins: 2041, last: now - 3 * HOUR },
    { id: "c:mira", display_name: "Mira Chen", kind: "Carbon", status: "Imported", signins: 0, last: 0 },
    { id: "si:head_of_growth", display_name: "Head of Growth", kind: "Silicon", status: "Active", signins: 377, last: now - 26 * HOUR },
    { id: "c:shubham", display_name: "Shubham", kind: "Carbon", status: "Access removed", signins: 42, last: now - 400 * HOUR },
  ];
  const columns: DataColumn<UserRow>[] = [
    { key: "display_name", label: "Name", render: (_, row) => <span style={{ display: "inline-flex", "align-items": "center", gap: "10px" }}><Avatar name={row.display_name} kind={row.kind === "Silicon" ? "silicon" : "carbon"} size="sm" />{row.display_name}</span> },
    { key: "id", label: "Id", render: value => <span class="mono">{String(value)}</span> },
    { key: "status", label: "Status", render: value => <Badge size="sm" tone={value === "Active" ? "success" : value === "Imported" ? "neutral" : "warning"}>{String(value)}</Badge> },
    { key: "signins", label: "Sign-ins" },
    { key: "last", label: "Last sign-in", render: value => (value ? formatRelative(Number(value), now) : "Never"), sortValue: row => row.last || null },
  ];
  const [filters, setFilters] = createSignal<FilterChip[]>([{ id: "status", label: "Status", value: "Active" }]);
  const fields: FilterField[] = [
    { id: "status", label: "Status", options: [{ value: "Active", hint: 3 }, { value: "Imported", hint: 1 }, { value: "Access removed", hint: 1 }] },
    { id: "kind", label: "Kind", options: ["Carbon", "Silicon"] },
    { id: "source", label: "Source", options: ["Sign-in", "Short-lived token", "Import"] },
  ];
  const payload = {
    event_id: "0192a6f0-0000-7000-8000-0000000000e1",
    type: "account.id_changed",
    occurred_at: "2026-10-06T09:40:12.000Z",
    app_id: "briefcase",
    silicon: null,
    data: { uuid: "a8K", membership_id: "briefcase:a8K", kind: "carbon", old_id: "c:saketdev", new_id: "c:saket" },
  };
  return (
    <div class={styles.wide}>
      <Specimen title="FilterToolbar and SortableDataTable (the user base)">
        <FilterToolbar filters={filters()} onRemove={id => setFilters(list => list.filter(filter => filter.id !== id))} onClearAll={() => setFilters([])} addFilter={{ fields, onAdd: (chip) => setFilters(list => [...list.filter(filter => filter.id !== chip.id), chip]) }} />
        <SortableDataTable rows={rows} columns={columns} rowKey="id" caption="Users of Briefcase" selectable itemName={{ one: "user", other: "users" }} defaultSort={{ key: "last", direction: "desc" }} />
      </Specimen>
      <div class={styles.specimens}>
        <Specimen title="CodeBlock (snippets)">
          <CodeBlock filename="Sign-in link" language="html" code={`<a href="https://account.teamofsilicons.com/authorize?app_id=briefcase&redirect_uri=https%3A%2F%2Fbriefcase.example%2Fcallback&state=…">\n  Sign in with Silicon Accounts\n</a>`} />
          <CodeBlock filename="Verify a proof" language="bash" code={`curl -u briefcase:$APP_SECRET \\\n  -H 'Content-Type: application/json' \\\n  -d '{"proof_token":"sap_…"}' \\\n  https://account.teamofsilicons.com/v1/proofs/verify`} />
        </Specimen>
        <Specimen title="JsonViewer (webhook payload)">
          <JsonViewer data={payload} rootName="event" defaultExpandDepth={2} maxHeight={280} label="Webhook payload" />
        </Specimen>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */

export function Overlays() {
  const [sheetOpen, setSheetOpen] = createSignal(false);
  return (
    <div class={styles.specimens}>
      <Specimen title="Dialog: a decision that must interrupt">
        <div class={styles.row}>
        <Dialog>
          <DialogTrigger as={Button} variant="secondary">Delete your account</DialogTrigger>
          <DialogContent title="Delete your account?" description="Every app you signed into is told, and your id stays reserved for 10 days." footer={<><DialogClose variant="ghost">Keep my account</DialogClose><Button variant="danger">Delete account</Button></>}>
            <p style={{ margin: 0 }}>You are custodian of no Silicons, so nothing blocks this.</p>
          </DialogContent>
        </Dialog>
        </div>
      </Specimen>
      <Specimen title="Drawer: record details beside the page">
        <div class={styles.row}>
        <Drawer>
          <DrawerTrigger as={Button} variant="secondary">Open user details</DrawerTrigger>
          <DrawerContent title="Saket Dev" description="briefcase:a8K · signed in 2 minutes ago">
            <DescriptionList>
              <DescriptionItem label="Id"><span class="mono">c:saket</span></DescriptionItem>
              <DescriptionItem label="Email">saketdev12@gmail.com</DescriptionItem>
              <DescriptionItem label="Shared">Profile, email, timezone</DescriptionItem>
            </DescriptionList>
          </DrawerContent>
        </Drawer>
        </div>
      </Specimen>
      <Specimen title="BottomSheet: tasks on phones">
        <div class={styles.row}>
        <BottomSheet open={sheetOpen()} onOpenChange={setSheetOpen} title="Transfer si:scout" description="The new custodian has 14 days to accept." trigger={<BottomSheetTrigger as={Button} variant="secondary">Open sheet</BottomSheetTrigger>}>
          <Input label="New custodian" placeholder="c:shubham or name@example.com" />
        </BottomSheet>
        </div>
      </Specimen>
      <Specimen title="CommandPalette (block)">
        <div class={styles.paletteFrame}>
          <CommandPalette items={[
            { id: "apps", label: "Apps", description: "Apps you signed into", group: "Go to", icon: icon(LayoutGrid), shortcut: "3" },
            { id: "proofs", label: "Proofs", description: "Proofs apps hold on your behalf", group: "Go to", icon: icon(ShieldCheck), shortcut: "5" },
            { id: "silicon", label: "Create a Silicon", group: "Silicons", icon: icon(Cpu) },
          ]} hideHotkey />
        </div>
      </Specimen>
    </div>
  );
}

export function Blocks() {
  return (
    <div class={styles.specimens}>
      <Specimen title="Sign-in block (sample flow: any email, code 123456)">
        <SignInDemo />
      </Specimen>
    </div>
  );
}
