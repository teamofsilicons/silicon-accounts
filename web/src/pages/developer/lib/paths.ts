/**
 * Small JSON helpers for the sign-in config editor: deep equality, leaf-level diffs (the same rule the server's history
 * uses: objects recurse, arrays and scalars compare whole), and reading or writing a value at a dotted path such as
 * `branding.light.primary`.
 */
import { unwrap } from "solid-js/store";

type Plain = Record<string, unknown>;

const isObject = (value: unknown): value is Plain => !!value && typeof value === "object" && !Array.isArray(value);

/** A deep copy that also strips Solid store proxies. */
export function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(unwrap(value))) as T;
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

/** Writes `value` at a dotted path of a plain object (creating objects on the way). */
export function setPath(target: Plain, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Plain = target;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(current[part])) current[part] = {};
    current = current[part] as Plain;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) current[last] = value;
}

/** True when `path` is `prefix` or lies under it (`branding.light.primary` is under `branding`). */
export function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}
