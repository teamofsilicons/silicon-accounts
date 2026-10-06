/**
 * Small JSON helpers for the sign-in setup editor: deep equality, leaf-level diffs (the rule the server's version
 * history uses: objects recurse, arrays and scalars compare whole), and reading or writing a value at a dotted path
 * such as `branding.light.primary`. Writes never mutate: they copy the objects along the path (structural sharing),
 * so React sees a new value exactly where something changed.
 */

type Plain = Record<string, unknown>;

export const isObject = (value: unknown): value is Plain => !!value && typeof value === "object" && !Array.isArray(value);

/** A deep copy of a JSON value. */
export function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Structural equality for JSON values (key order does not matter). `undefined` and missing keys count as null. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || a === null) return b === undefined || b === null;
  if (b === undefined || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (!deepEqual(a[key], b[key])) return false;
    return true;
  }
  return false;
}

/** Dotted paths of every leaf that differs between `before` and `after`. */
export function leafDiff(before: unknown, after: unknown, path = "", out: string[] = []): string[] {
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) leafDiff(before[key], after[key], path ? `${path}.${key}` : key, out);
    return out;
  }
  if (!deepEqual(before, after)) out.push(path);
  return out;
}

/** The value at a dotted path, or undefined. */
export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** A copy of `source` with `value` at the dotted `path` (objects on the way are copied, or created). */
export function setIn<T>(source: T, path: string, value: unknown): T {
  const parts = path.split(".");
  const walk = (node: unknown, index: number): unknown => {
    const key = parts[index] as string;
    const base = isObject(node) ? node : {};
    const next = index === parts.length - 1 ? value : walk(base[key], index + 1);
    return { ...base, [key]: next };
  };
  return walk(source, 0) as T;
}

/** True when `path` is `prefix` or lies under it (`branding.light.primary` is under `branding`, `redirect_uris[2]` under `redirect_uris`). */
export function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}

/** True when one path lies under the other (either way round). */
export const touches = (a: string, b: string) => under(a, b) || under(b, a);

export const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
