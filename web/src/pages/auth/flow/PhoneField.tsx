/**
 * The phone number field of the hosted pages (sign-in, "Change", the requirements step).
 *
 * Arc's PhoneInput formats the 56 countries it knows and nothing else: a number with any other calling code would be
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
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { Input } from "../../../arc/input/input";
import { COUNTRY_BY_ISO, PHONE_COUNTRIES, PhoneInput, lengthsOf, onlyDigits, parsePhoneNumber, toE164 } from "../../../arc/phone-input/phone-input";
import { guessCountry } from "./model";
import { E164_MAX_DIGITS, E164_MIN_DIGITS, callingCodeOf, callingCountry, countriesOf, isCallingCodePrefix } from "./phone-data";
import styles from "./flow.module.css";

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
  onChange: (value: PhoneFieldValue) => void;
}

/** What may stay in the typed number: digits, a leading "+" and the usual separators. "00…" becomes "+…". */
function cleanTyped(text: string): string {
  let value = text.replace(/[^\d+\s().-]/g, "").replace(/^\s+/, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  // One "+", at the start.
  const plus = value.startsWith("+");
  value = value.replace(/\+/g, "");
  return (plus ? `+${value}` : value).slice(0, 32);
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
function startFrom(initial: string | undefined): Start {
  const guess = guessCountry();
  const pickerCountry = COUNTRY_BY_ISO.has(guess) ? guess : "US";
  const text = (initial ?? "").trim();
  if (text) {
    if (pickerWouldRewrite(text)) return { mode: "international", raw: cleanTyped(text), picker: "", country: pickerCountry };
    const parsed = parsePhoneNumber(text, PHONE_COUNTRIES);
    return { mode: "picker", raw: "", picker: text, country: parsed?.country.iso ?? pickerCountry };
  }
  if (!COUNTRY_BY_ISO.has(guess)) {
    const other = callingCountry(guess);
    if (other) return { mode: "international", raw: `+${other.dial} `, picker: "", country: pickerCountry };
  }
  return { mode: "picker", raw: "", picker: "", country: pickerCountry };
}

export function PhoneField(props: PhoneFieldProps) {
  const start = untrack(() => startFrom(props.initial));
  const [mode, setMode] = createSignal<PhoneMode>(start.mode);
  const [picker, setPicker] = createSignal(start.picker);
  const [country, setCountry] = createSignal(start.country);
  const [raw, setRaw] = createSignal(start.raw);
  let wrapper: HTMLDivElement | undefined;
  let typed: HTMLInputElement | undefined;

  const value = createMemo<PhoneFieldValue>(() => {
    if (mode() === "picker") {
      return { mode: "picker", phone: picker(), country: country(), problem: picker() ? null : "Enter your phone number." };
    }
    const digits = onlyDigits(raw());
    return { mode: "international", phone: digits ? `+${digits}` : "", problem: internationalProblem(raw()) };
  });
  createEffect(() => props.onChange(value()));

  const example = () => callingCountry(guessCountry()) ?? callingCountry("RO");
  const detected = () => {
    const dial = callingCodeOf(onlyDigits(raw()));
    const names = dial ? countriesOf(dial) : null;
    return names && raw().trim().startsWith("+") ? `${names[0]?.toUpperCase()}${names.slice(1)} (+${dial})` : null;
  };
  const typedDescription = () =>
    [detected() ?? `Start with + and the country code, like +${example()?.dial} for ${example()?.name}.`, props.description].filter(Boolean).join(" ");

  const focusEnd = (input: HTMLInputElement | null | undefined) => {
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };

  const toInternational = (text: string) => {
    setRaw(cleanTyped(text));
    setMode("international");
    queueMicrotask(() => focusEnd(typed));
  };

  const toPicker = () => {
    const text = raw().trim();
    const parsed = text.startsWith("+") && !pickerWouldRewrite(text) ? parsePhoneNumber(text, PHONE_COUNTRIES) : null;
    if (parsed) {
      setCountry(parsed.country.iso);
      setPicker(toE164(parsed.country, parsed.national));
    } else setPicker("");
    setMode("picker");
    queueMicrotask(() => focusEnd(wrapper?.querySelector<HTMLInputElement>('input[type="tel"]')));
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
      if (mode() === "picker") toInternational(`+${digits}`);
    }, 0);
  };

  onMount(() => {
    const root = wrapper;
    if (!root) return;
    // Capture phase: these run before PhoneInput's own handlers and stop the event when the picker would rewrite it.
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (mode() !== "picker" || !(target instanceof HTMLInputElement) || target.type !== "tel") return;
      const text = event.clipboardData?.getData("text") ?? "";
      if (!pickerWouldRewrite(text)) return;
      event.preventDefault();
      event.stopPropagation();
      toInternational(text);
    };
    const onInput = (event: Event) => {
      const target = event.target;
      if (mode() !== "picker" || !(target instanceof HTMLInputElement)) return;
      if (target.getAttribute("role") === "combobox") {
        fromSearch(target.value);
        return;
      }
      if (target.type !== "tel") return;
      // Autofill, a dropped number, or a phone keyboard's "+": the whole international number arrives at once.
      const value = target.value;
      const international = value.includes("+") || (/^\s*00/.test(value) && onlyDigits(value).length > 6);
      if (!international) return;
      const text = value.includes("+") ? value.slice(value.indexOf("+")) : value;
      if (!pickerWouldRewrite(text)) return;
      event.stopPropagation();
      toInternational(text);
    };
    root.addEventListener("paste", onPaste, true);
    root.addEventListener("input", onInput, true);
    onCleanup(() => {
      root.removeEventListener("paste", onPaste, true);
      root.removeEventListener("input", onInput, true);
    });
  });

  return (
    <div ref={wrapper} class={styles.phoneField} data-phone-mode={mode()}>
      <Show
        when={mode() === "picker"}
        fallback={
          <>
            <Input
              ref={el => { typed = el; }}
              label={props.label}
              hideLabel={props.hideLabel}
              type="tel"
              inputMode="tel"
              autocomplete="tel"
              name="phone"
              spellcheck={false}
              placeholder={`+${example()?.dial ?? "40"} …`}
              value={raw()}
              onInput={event => {
                const next = cleanTyped(event.currentTarget.value);
                if (next !== event.currentTarget.value) event.currentTarget.value = next;
                setRaw(next);
              }}
              error={props.error}
              description={props.error ? undefined : typedDescription()}
            />
            <button type="button" class={styles.fieldLink} onClick={toPicker}>Choose the country from the list</button>
          </>
        }
      >
        <PhoneInput
          label={props.label}
          hideLabel={props.hideLabel}
          value={picker()}
          defaultCountry={country()}
          onCountryChange={setCountry}
          onValueChange={(next, details) => {
            setPicker(next);
            setCountry(details.country.iso);
          }}
          error={props.error}
          description={props.description}
        />
        <button type="button" class={styles.fieldLink} onClick={() => toInternational("+")}>Country not in the list?</button>
      </Show>
    </div>
  );
}
