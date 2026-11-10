export type StorageType = "string" | "number" | "boolean" | "object" | "array";
export type StorageSchema = Record<string, {type: StorageType; default: unknown}>;
export type StorageRow = {key: string; type: StorageType; value: string};
export const storageTypes: StorageType[] = ["string", "number", "boolean", "object", "array"];
export const startingValue: Record<StorageType, string> = {string: "", number: "0", boolean: "true", object: "{}", array: "[]"};
export function storageRows(schema?: StorageSchema | null): StorageRow[] {
  return Object.entries(schema ?? {}).map(([key, field]) => ({key, type: field.type, value: field.type === "string" ? String(field.default) : JSON.stringify(field.default)}));
}
export function parseStorageRows(rows: StorageRow[]): StorageSchema {
  if (rows.length > 128) throw new Error("Use at most 128 storage keys.");
  const result: StorageSchema = {};
  for (const row of rows) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(row.key) || ["__proto__", "prototype", "constructor"].includes(row.key)) throw new Error("Keys need 1–128 letters, digits, underscores, dots or hyphens. Prototype names are reserved.");
    if (Object.hasOwn(result, row.key)) throw new Error(`The key “${row.key}” appears more than once.`);
    let value: unknown;
    try { value = row.type === "string" ? row.value : JSON.parse(row.value); }
    catch { throw new Error(`Enter a valid ${row.type} initial value for “${row.key}”.`); }
    const valid = row.type === "array" ? Array.isArray(value) : row.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === row.type && (row.type !== "number" || Number.isFinite(value));
    if (!valid) throw new Error(`The initial value for “${row.key}” must be a ${row.type}.`);
    if (new TextEncoder().encode(JSON.stringify(value)).length > 64 * 1024) throw new Error(`The initial value for “${row.key}” must fit within 64 KiB.`);
    result[row.key] = {type: row.type, default: value};
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 1024 * 1024) throw new Error("Storage defaults must fit within 1 MiB.");
  return result;
}
