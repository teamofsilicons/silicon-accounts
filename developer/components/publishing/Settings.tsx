"use client";
import { Switch } from "@/components/silicon-ui/switch/switch";
import { Page, PageHeader, Section, SettingsRow } from "@/components/foundation/layout/layout";
import { useTelemetryEnabled } from "@/lib/query/session";
export function DeveloperSettings() {
  const [enabled, setEnabled] = useTelemetryEnabled();
  return <Page><PageHeader title="Developer settings" description="Preferences for this browser." /><Section title="Usage telemetry" description="Help improve Apps and Accounts. Events describe progress and outcomes; app secrets and form contents are excluded."><SettingsRow label="Share usage telemetry" description="Enabled by default. This choice applies to both services in this browser."><Switch aria-label="Share usage telemetry" checked={enabled} onCheckedChange={setEnabled} /></SettingsRow></Section></Page>;
}
