/**
 * Which pages the Pages tab's preview offers (tabs/hosted-preview.tsx draws them): every page of the sign-in a Carbon
 * can meet with the draft, in the order they meet them. Pure, so the unit tests read it without a browser.
 */
import type { SigninFlowStep, SigninMethod } from "@/lib/api/types";
import { defaultFlowOf, requestedFields, type EditableConfig } from "./config";

export type PreviewPage =
  | { kind: "methods"; intent: "signin" | "signup" }
  | { kind: "opening"; provider: "google" | "apple" }
  | { kind: "code"; channel: "email" | "phone" }
  | { kind: "signup" }
  | { kind: "details"; index: number }
  | { kind: "review" }
  | { kind: "buttons" };

export interface PreviewPageOption {
  key: string;
  label: string;
  group: string;
  page: PreviewPage;
}

export function pageKey(page: PreviewPage): string {
  switch (page.kind) {
    case "methods": return `methods-${page.intent}`;
    case "opening": return `opening-${page.provider}`;
    case "code": return `code-${page.channel}`;
    case "details": return `details-${page.index}`;
    default: return page.kind;
  }
}

/**
 * The pages a Carbon walks through, as a flow step list: the app's own flow, else the default (one page with every
 * requested detail), else the what's-shared page with only the profile (an app that asks for no details).
 */
export function effectiveSteps(config: EditableConfig): SigninFlowStep[] {
  if (config.flow?.steps.length) return config.flow.steps;
  if (requestedFields(config).length) return defaultFlowOf(config).steps;
  return [{ id: "profile", fields: [], title: null, subtitle: null, continue_label: null, layout: null }];
}

/** The sign-in methods the draft has on, in its order. */
export function enabledMethods(config: EditableConfig): SigninMethod[] {
  return config.method_order.filter(method => config.methods[method]);
}

/**
 * Every page of the sign-in a Carbon can meet, in the order they meet them. The Opening and code pages follow the
 * draft's methods: an app without Apple has no Opening Apple page, one without phone sign-in no phone code page.
 */
export function previewPages(config: EditableConfig): PreviewPageOption[] {
  const out: PreviewPageOption[] = [
    { key: "methods-signin", label: "Sign in", group: "Start", page: { kind: "methods", intent: "signin" } },
    { key: "methods-signup", label: "Sign up", group: "Start", page: { kind: "methods", intent: "signup" } },
  ];
  for (const provider of ["google", "apple"] as const) {
    if (config.methods[provider]) out.push({ key: `opening-${provider}`, label: `Opening ${provider === "google" ? "Google" : "Apple"}`, group: "Start", page: { kind: "opening", provider } });
  }
  for (const channel of ["email", "phone"] as const) {
    if (config.methods[channel]) out.push({ key: `code-${channel}`, label: channel === "email" ? "Email code" : "Phone code", group: "Verify", page: { kind: "code", channel } });
  }
  out.push({ key: "signup", label: "Set up account", group: "Verify", page: { kind: "signup" } });
  const steps = effectiveSteps(config);
  steps.forEach((step, index) => {
    out.push({
      key: `details-${index}`,
      label: steps.length > 1 ? `Details ${index + 1}${step.title ? `: ${step.title}` : ""}` : step.fields.length ? "What's shared" : "What's shared (profile)",
      group: "Flow",
      page: { kind: "details", index },
    });
  });
  if (config.flow?.review) out.push({ key: "review", label: "Review", group: "Flow", page: { kind: "review" } });
  out.push({ key: "buttons", label: "Embed buttons", group: "Your site", page: { kind: "buttons" } });
  return out;
}
