"use client";

import { useMemo, useState } from "react";
import { Calendar } from "@teamofsilicons/silicon-ui/calendar";
import { ChipGroup } from "@teamofsilicons/silicon-ui/chip-group";
import { ColorPicker } from "@teamofsilicons/silicon-ui/color-picker";
import { Combobox } from "@teamofsilicons/silicon-ui/combobox";
import { DatePicker } from "@teamofsilicons/silicon-ui/date-picker";
import { FileDropzone } from "@teamofsilicons/silicon-ui/file-dropzone";
import { InlineEdit } from "@teamofsilicons/silicon-ui/inline-edit";
import { Input } from "@teamofsilicons/silicon-ui/input";
import { MorphSelect } from "@teamofsilicons/silicon-ui/morph-select";
import { OtpInput } from "@teamofsilicons/silicon-ui/otp-input";
import { PhoneInput } from "@teamofsilicons/silicon-ui/phone-input";
import { SearchField } from "@teamofsilicons/silicon-ui/search-field";
import { Select } from "@teamofsilicons/silicon-ui/select";
import { TagInput } from "@teamofsilicons/silicon-ui/tag-input";
import { Textarea } from "@teamofsilicons/silicon-ui/textarea";
import { timezoneOptions } from "@/lib/timezones";
import { SAMPLE_APPS, SAMPLE_NOW } from "../samples";
import { Specimen, Specimens, kitchenStyles as styles } from "../specimen";

export function Fields() {
  const [search, setSearch] = useState("");
  const [tz, setTz] = useState("Asia/Kolkata");
  const [app, setApp] = useState<string | null>("briefcase");
  const [dob, setDob] = useState<Date | undefined>(new Date(1998, 2, 14));
  const [color, setColor] = useState("#1F5FB8");
  const [tags, setTags] = useState(["https://briefcase.example/auth/callback", "http://localhost:3000/callback"]);
  const [chips, setChips] = useState(["profile", "email", "timezone"]);
  const [otp, setOtp] = useState("");
  const [name, setName] = useState("Saket Dev");
  const zones = useMemo(() => timezoneOptions(new Date(SAMPLE_NOW), ["Asia/Kolkata"]), []);
  return (
    <Specimens>
      <Specimen title="Input, Textarea and SearchField">
        <Input label="Display name" placeholder="Saket" description="Shown to every app you sign into." />
        <Input label="Id" defaultValue="c:saket" error="c:saket is taken by another account. Try c:saket-2." />
        <Input label="Webhook URL" placeholder="https://example.com/hooks/accounts" disabled />
        <SearchField label="Search users" value={search} onValueChange={setSearch} placeholder="Search by id, name, email or phone" />
        <Textarea label="What happened?" placeholder="Describe the problem and how to reproduce it." />
      </Specimen>
      <Specimen title="PhoneInput, Select, Combobox (time zones) and MorphSelect">
        <PhoneInput label="Phone number" defaultCountry="IN" description="We send a 6 digit code by SMS." />
        <Select label="Theme" defaultValue="auto" options={[{ value: "auto", label: "Match the device" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <Combobox label="Timezone" value={tz} onValueChange={setTz} options={zones} placeholder="Search a city or offset" />
        <MorphSelect
          label="App"
          value={app}
          onValueChange={value => setApp(value)}
          items={[{ label: "Your apps", options: SAMPLE_APPS.map(entry => ({ value: entry.app_id, label: entry.name, meta: entry.app_id, icon: <span data-sq="clip" className={styles.appIcon} style={{ backgroundImage: `url("${entry.logo}")` }} /> })) }]}
        />
      </Specimen>
      <Specimen title="DatePicker (date of birth) and Calendar">
        <DatePicker label="Date of birth" value={dob} onChange={setDob} maxDate={new Date(SAMPLE_NOW)} description="Apps that ask for it see this date." />
        <Calendar value={dob} onChange={setDob} maxDate={new Date(SAMPLE_NOW)} />
      </Specimen>
      <Specimen title="OtpInput and InlineEdit">
        <OtpInput label="Verification code" value={otp} onChange={setOtp} error={otp.length === 6 && otp !== "123456" ? "That code is not right. 9 attempts left." : undefined} description="Sample code: 123456." />
        <InlineEdit label="Display name" value={name} variant="title" onSave={next => new Promise(resolve => setTimeout(() => { setName(next); resolve(undefined); }, 600))} validate={next => (next.trim() ? null : "Enter a display name.")} />
      </Specimen>
      <Specimen title="TagInput and ChipGroup">
        <TagInput label="Redirect URIs" value={tags} onValueChange={setTags} description="Exact match, including the path." placeholder="https://app.example/callback" />
        <ChipGroup label="Shared details" options={[{ value: "profile", label: "Profile" }, { value: "email", label: "Email" }, { value: "phone", label: "Phone" }, { value: "dob", label: "Date of birth" }, { value: "timezone", label: "Timezone" }]} value={chips} onValueChange={setChips} />
      </Specimen>
      <Specimen title="ColorPicker (branding) and FileDropzone (imports)">
        <ColorPicker label="Primary" value={color} onValueChange={setColor} background="#FFFDF9" />
        <FileDropzone label="Import users" description="CSV or JSON, up to 50 MB." accept=".csv,.json,text/csv,application/json" note="Columns: external_id, email, emails, phone, phones, display_name, username, dob, timezone, pfp_url." />
      </Specimen>
    </Specimens>
  );
}
