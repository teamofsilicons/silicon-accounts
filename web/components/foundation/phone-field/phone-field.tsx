"use client";

/**
 * The phone number field of the hosted pages (sign-in, "Change", the requirements step) and the account site (adding
 * a phone number on Sign-in methods).
 *
 * Arc's PhoneInput formats the countries it lists and nothing else: a number with any other calling code would be
 * folded into the selected country's digits (a pasted "+40 755 345 678" became the US number +1 407 553 4567), so the
 * code would be texted to a stranger. This field never lets that happen:
 *
 *   - "picker" mode is PhoneInput, for numbers it can hold exactly;
 *   - "international" mode is a plain field for the number with its country code, for every other country. Its
 *     digits are sent as typed ("+" and the digits) and the server, which knows every numbering plan, judges them.
 *
 * The field moves to "international" by itself whenever the picker would rewrite a number: a pasted, dropped or
 * autofilled number whose calling code the picker does not know (or whose digits it would cut off), and a "+40"
 * typed into the country search that matches none of its countries. "Country not in the list?" moves there by hand,
 * and a visitor whose timezone belongs to such a country starts there with the calling code filled in.
 */
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/arc/input/input";
import { PHONE_COUNTRIES, PhoneInput, parsePhoneNumber, type PhoneCountry } from "@/components/arc/phone-input/phone-input";
import { E164_MAX_DIGITS, E164_MIN_DIGITS, callingCodeOf, callingCountry, countriesOf, guessCountry, isCallingCodePrefix } from "./phone-data";
import styles from "./phone-field.module.css";

export type PhoneMode = "picker" | "international";

export interface PhoneFieldValue {
  mode: PhoneMode;
  /** What to send: the picker's E.164 number, or "+" and the digits typed with their country code. */
  phone: string;
  /** The picker's country; absent for a number typed with its country code (the code says it all). */
  country?: string;
  /** Why the number cannot be sent yet, in the Carbon's words; null when it can go (the server has the last word). */
  problem: string | null;
}

export interface PhoneFieldProps {
  label: string;
  hideLabel?: boolean;
  /** A number to start with (E.164, or what was typed last time). */
  initial?: string;
  error?: string | null;
  /** Under the field (for example "We text a 6 digit code to this number."). */
  description?: string;
  /** The country to start in (ISO 3166-1 alpha-2); default: the visitor's likely country (guessCountry). */
  defaultCountry?: string;
  onChange: (value: PhoneFieldValue) => void;
}

const BY_ISO = new Map(PHONE_COUNTRIES.map(entry => [entry.iso, entry]));
const onlyDigits = (text: string) => text.replace(/\D/g, "");
const lengthsOf = (entry: PhoneCountry) => entry.patterns.map(pattern => pattern.split("#").length - 1);

/** What may stay in the typed number: digits, a leading "+" and the usual separators. "00…" becomes "+…". */
function cleanTyped(text: string): string {
  let value = text.replace(/[^\d+\s().-]/g, "").replace(/^\s+/, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  // One "+", at the start.
  const plus = value.startsWith("+");
  value = value.replace(/\+/g, "");
  return (plus ? `+${value}` : value).slice(0, 32);
}

/** The E.164 number for national digits of a picker country (a typed trunk prefix such as the UK's 0 is dropped). */
function toE164(entry: PhoneCountry, national: string): string {
  const rest = entry.trunk && national.startsWith(entry.trunk) ? national.slice(entry.trunk.length) : national;
  return rest ? `+${entry.dial}${rest}` : "";
}

/**
 * True when PhoneInput would turn this international number into a different one: its calling code is not one of
 * the picker's countries, or the picker would cut digits off to fit the country's longest format.
 */
export function pickerWouldRewrite(text: string): boolean {
  const trimmed = text.trim();
  if (!/^(\+|00)/.test(trimmed)) return false;
  const all = onlyDigits(trimmed.startsWith("+") ? trimmed : trimmed.slice(2));
  if (!all) return false;
  const parsed = parsePhoneNumber(trimmed, PHONE_COUNTRIES);
  if (!parsed) return true;
  const entry = parsed.country;
  let rest = all.slice(entry.dial.length);
  // The same "(0)" trunk rule as parsePhoneNumber, so only real truncation counts.
  if (entry.trunk && rest.startsWith(entry.trunk) && rest.length - entry.trunk.length >= Math.min(...lengthsOf(entry))) rest = rest.slice(entry.trunk.length);
  return rest.length > parsed.national.length;
}

/** Why an international number cannot be sent yet, or null. */
function internationalProblem(raw: string): string | null {
  const text = raw.trim();
  const digits = onlyDigits(text);
  if (!digits) return "Enter your phone number with its country code, starting with +.";
  if (!text.startsWith("+")) return "Start the number with + and its country code, or choose its country from the list.";
  const dial = callingCodeOf(digits);
  if (!dial) {
    return isCallingCodePrefix(digits)
      ? "Enter the rest of the number after its country code."
      : `No country's calling code starts with +${digits.slice(0, 3)}. Check the digits right after the +.`;
  }
  if (digits.length < E164_MIN_DIGITS) return "That number is too short. Enter all of it after the country code.";
  if (digits.length > E164_MAX_DIGITS) return `Phone numbers have at most ${E164_MAX_DIGITS} digits, country code included; this one has ${digits.length}.`;
  return null;
}

interface Start {
  mode: PhoneMode;
  raw: string;
  picker: string;
  country: string;
}

/** Where the field starts: the given number in whichever mode can hold it, else the visitor's likely country. */
function startFrom(initial: string | undefined, preferred?: string): Start {
  const guess = preferred?.toUpperCase() || guessCountry();
  const pickerCountry = BY_ISO.has(guess) ? guess : "US";
  const text = (initial ?? "").trim();
  if (text) {
    if (pickerWouldRewrite(text)) return { mode: "international", raw: cleanTyped(text), picker: "", country: pickerCountry };
    const parsed = parsePhoneNumber(text, PHONE_COUNTRIES);
    return { mode: "picker", raw: "", picker: parsed ? toE164(parsed.country, parsed.national) : "", country: parsed?.country.iso ?? pickerCountry };
  }
  if (!BY_ISO.has(guess)) {
    const other = callingCountry(guess);
    if (other) return { mode: "international", raw: `+${other.dial} `, picker: "", country: pickerCountry };
  }
  return { mode: "picker", raw: "", picker: "", country: pickerCountry };
}

/** The value a mode reports. */
function valueOf(mode: PhoneMode, picker: string, country: string, raw: string): PhoneFieldValue {
  if (mode === "picker") return { mode, phone: picker, country, problem: picker ? null : "Enter your phone number." };
  const digits = onlyDigits(raw);
  return { mode, phone: digits ? `+${digits}` : "", problem: internationalProblem(raw) };
}

export function PhoneField({ label, hideLabel, initial, error, description, defaultCountry, onChange }: PhoneFieldProps) {
  const [start] = useState(() => startFrom(initial, defaultCountry));
  const [mode, setMode] = useState<PhoneMode>(start.mode);
  const [picker, setPicker] = useState(start.picker);
  const [country, setCountry] = useState(start.country);
  const [raw, setRaw] = useState(start.raw);
  const wrapper = useRef<HTMLDivElement>(null);
  const typed = useRef<HTMLInputElement>(null);
  /** Where focus goes once the next mode has rendered. */
  const [focusTarget, setFocusTarget] = useState<"typed" | "picker" | null>(null);

  // Report every change; the latest handler is used without re-running for a new function identity.
  const report = useRef(onChange);
  useEffect(() => {
    report.current = onChange;
  });
  const value = valueOf(mode, picker, country, raw);
  const key = `${value.mode}|${value.phone}|${value.country ?? ""}|${value.problem ?? ""}`;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    report.current(valueOf(mode, picker, country, raw));
  }, [key, mode, picker, country, raw]);

  useEffect(() => {
    if (!focusTarget) return;
    const input = focusTarget === "typed" ? typed.current : wrapper.current?.querySelector<HTMLInputElement>('input[type="tel"]');
    if (input) {
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
  }, [focusTarget, mode]);

  const example = callingCountry(defaultCountry?.toUpperCase() || guessCountry()) ?? callingCountry("RO");
  const dial = callingCodeOf(onlyDigits(raw));
  const names = dial ? countriesOf(dial) : null;
  const detected = names && raw.trim().startsWith("+") ? `${names[0]?.toUpperCase()}${names.slice(1)} (+${dial})` : null;
  const typedDescription = [detected ?? `Start with + and the country code, like +${example?.dial} for ${example?.name}.`, description].filter(Boolean).join(" ");

  const toInternational = (text: string) => {
    setRaw(cleanTyped(text));
    setMode("international");
    setFocusTarget("typed");
  };

  const toPicker = () => {
    const text = raw.trim();
    const parsed = text.startsWith("+") && !pickerWouldRewrite(text) ? parsePhoneNumber(text, PHONE_COUNTRIES) : null;
    if (parsed) {
      setCountry(parsed.country.iso);
      setPicker(toE164(parsed.country, parsed.national));
    } else setPicker("");
    setMode("picker");
    setFocusTarget("picker");
  };

  // Capture phase: these run before PhoneInput's own handlers (React dispatches at the document, after this element)
  // and stop the event when the picker would rewrite the number.
  const live = useRef({ mode, toInternational });
  useEffect(() => {
    live.current = { mode, toInternational };
  });
  useEffect(() => {
    const root = wrapper.current;
    if (!root) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (live.current.mode !== "picker" || !(target instanceof HTMLInputElement) || target.type !== "tel") return;
      const text = event.clipboardData?.getData("text") ?? "";
      if (!pickerWouldRewrite(text)) return;
      event.preventDefault();
      event.stopPropagation();
      live.current.toInternational(text);
    };
    /** "+40…" typed into the picker's country search, matching none of its countries: that is a number, not a search. */
    const fromSearch = (query: string) => {
      const text = query.trim();
      if (!/^\+?\d[\d\s()-]*$/.test(text)) return;
      const digits = onlyDigits(text);
      if (PHONE_COUNTRIES.some(entry => entry.dial.startsWith(digits) || digits.startsWith(entry.dial))) return;
      if (!callingCodeOf(digits) && !isCallingCodePrefix(digits)) return;
      // After every handler of this keystroke ran (the picker's own included), so none runs on a field that went away.
      window.setTimeout(() => {
        if (live.current.mode === "picker") live.current.toInternational(`+${digits}`);
      }, 0);
    };
    const onInput = (event: Event) => {
      const target = event.target;
      if (live.current.mode !== "picker" || !(target instanceof HTMLInputElement)) return;
      if (target.getAttribute("role") === "combobox") {
        fromSearch(target.value);
        return;
      }
      if (target.type !== "tel") return;
      // Autofill, a dropped number, or a phone keyboard's "+": the whole international number arrives at once.
      const text = target.value;
      const international = text.includes("+") || (/^\s*00/.test(text) && onlyDigits(text).length > 6);
      if (!international) return;
      const number = text.includes("+") ? text.slice(text.indexOf("+")) : text;
      if (!pickerWouldRewrite(number)) return;
      event.stopPropagation();
      live.current.toInternational(number);
    };
    root.addEventListener("paste", onPaste, true);
    root.addEventListener("input", onInput, true);
    return () => {
      root.removeEventListener("paste", onPaste, true);
      root.removeEventListener("input", onInput, true);
    };
  }, []);

  return (
    <div ref={wrapper} className={styles.phoneField} data-phone-mode={mode}>
      {mode === "picker" ? (
        <>
          <PhoneInput
            label={label}
            hideLabel={hideLabel}
            value={picker}
            defaultCountry={country}
            onValueChange={(next, details) => {
              setPicker(next);
              setCountry(details.country.iso);
            }}
            onCountryChange={setCountry}
            error={error ?? undefined}
            description={description}
          />
          <button type="button" className={styles.fieldLink} onClick={() => toInternational("+")}>Country not in the list?</button>
        </>
      ) : (
        <>
          <div className={hideLabel ? styles.quietLabel : undefined}>
            <Input
              ref={typed}
              label={label}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              name="phone"
              spellCheck={false}
              placeholder={`+${example?.dial ?? "40"} …`}
              value={raw}
              onChange={event => setRaw(cleanTyped(event.currentTarget.value))}
              error={error ?? undefined}
              description={error ? undefined : typedDescription}
            />
          </div>
          <button type="button" className={styles.fieldLink} onClick={toPicker}>Choose the country from the list</button>
        </>
      )}
    </div>
  );
}
