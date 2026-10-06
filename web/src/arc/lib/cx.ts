/** Joins class names, skipping falsy values. */
export function cx(...values: Array<string | false | null | undefined>): string {
  let out = "";
  for (const value of values) if (value) out = out ? `${out} ${value}` : value;
  return out;
}
