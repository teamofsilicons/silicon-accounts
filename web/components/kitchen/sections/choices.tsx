"use client";

import { useState } from "react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Checkbox } from "@teamofsilicons/silicon-ui/checkbox";
import { RadioCards } from "@teamofsilicons/silicon-ui/radio-cards";
import { RadioGroup } from "@teamofsilicons/silicon-ui/radio-group";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { Switch } from "@teamofsilicons/silicon-ui/switch";
import { DescriptionItem, DescriptionList, SettingsGroup, SettingsRow } from "@/components/foundation/layout/layout";
import { Specimen, Specimens, kitchenStyles as styles } from "../specimen";

export function Choices() {
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(true);
  const [radio, setRadio] = useState("email");
  const [segment, setSegment] = useState("week");
  const [mode, setMode] = useState<string | null>("managed");
  const [layout, setLayout] = useState<string | null>("card");
  return (
    <Specimens>
      <Specimen title="Checkbox, Switch and SegmentedControl">
        <Checkbox label="Remember this browser" description="Offer “Continue as” next time." checked={checked} onCheckedChange={value => setChecked(value === true)} />
        <Switch label="Allow sign up" checked={on} onCheckedChange={setOn} />
        <SegmentedControl label="Range" options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} value={segment} onValueChange={setSegment} />
      </Specimen>
      <Specimen title="RadioGroup">
        <RadioGroup label="Sign in with" options={[{ value: "email", label: "Email", description: "A 6 digit code by email" }, { value: "phone", label: "Phone", description: "A 6 digit code by SMS" }, { value: "google", label: "Google", description: "One click with a Google account" }]} value={radio} onValueChange={setRadio} />
      </Specimen>
      <Specimen title="RadioCards (grid and list)">
        <RadioCards aria-label="Google sign-in" value={mode} onValueChange={setMode} minColumnWidth={150} options={[{ value: "managed", label: "One click", description: "We run the whole Google sign-in for you." }, { value: "byo", label: "Bring your own", description: "Google shows your app's name and logo." }]} />
        <RadioCards aria-label="Layout" layout="list" value={layout} onValueChange={setLayout} options={[{ value: "card", label: "Card", description: "A centred card", meta: "Default" }, { value: "split", label: "Split", description: "Your side and the form" }, { value: "minimal", label: "Minimal", description: "No card chrome" }]} />
      </Specimen>
      <Specimen title="Settings rows and description lists (layout primitives)">
        <SettingsGroup label="Notifications">
          <SettingsRow label="Email me about new sign-ins" description="A short note whenever a new browser or terminal signs in.">
            {ids => <Switch aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} defaultChecked />}
          </SettingsRow>
          <SettingsRow label="Default sign-in method" description="What the sign-in page offers first.">
            <Button size="sm" variant="secondary">Change</Button>
          </SettingsRow>
        </SettingsGroup>
        <DescriptionList>
          <DescriptionItem label="Membership"><span className={styles.mono}>briefcase:a8K</span></DescriptionItem>
          <DescriptionItem label="First signed in">Sep 6, 2026</DescriptionItem>
        </DescriptionList>
      </Specimen>
    </Specimens>
  );
}
