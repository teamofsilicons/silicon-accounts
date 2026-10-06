/**
 * STKs as the custodian handles them: the shape the service accepts (stk- plus 8 to 32 hex digits; bare hex is
 * accepted and normalized), and how a revealed STK is shown with the command a Silicon signs in with.
 */
import type { RevealedSecret } from "./SecretReveal";

const STK_SHAPE = /^(stk-)?[0-9a-f]{8,32}$/;

/** Why a chosen STK would be refused, said precisely; null when it has the right shape. */
export function stkProblem(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return "Type the STK, or untick the box to have one generated.";
  if (!STK_SHAPE.test(value)) {
    const hex = value.replace(/^stk-/, "");
    if (/[^0-9a-f]/.test(hex)) return "An STK uses only hex digits (0 to 9 and a to f) after stk-.";
    return `An STK has 8 to 32 hex digits after stk- (this one has ${hex.length}).`;
  }
  return null;
}

/** How a Silicon signs in with its STK (the CLI reads it from stdin, so it never shows in a process list). */
export const stkSecret = (id: string, value: string): RevealedSecret => ({
  label: "STK",
  value,
  note: `${id} signs in with it (put the STK in $STK first):`,
  command: `printf '%s' "$STK" | accounts login --silicon ${id} --stk-stdin`,
});

/** The STK as the service stores it: lowercase, with the stk- prefix. */
export const normalizeStk = (raw: string) => {
  const value = raw.trim().toLowerCase();
  return value.startsWith("stk-") ? value : `stk-${value}`;
};
