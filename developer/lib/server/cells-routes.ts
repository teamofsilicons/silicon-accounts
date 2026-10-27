/** Only the author interface. Cell-user sessions and private service bridges stay outside the developer proxy. */
const CELL = "[a-z][a-z0-9-]{1,28}[a-z0-9]";
const APP = "[a-z0-9_-]{3,30}";
const UUID = "[0-9a-f-]{36}";
const BUCKET = "[a-z0-9][a-z0-9_-]{0,62}";
const routes: [string, RegExp][] = [
  ["GET HEAD", /^me$/],
  ["GET HEAD POST", /^cells$/],
  ["GET HEAD", /^cells\/availability$/],
  ["GET HEAD POST", new RegExp(`^apps/${APP}/cell$`)],
  ["GET HEAD DELETE", new RegExp(`^cells/${CELL}$`)],
  ["POST", new RegExp(`^cells/${CELL}/(restore|sql|schema|import)$`)],
  ["PUT", new RegExp(`^cells/${CELL}/(admin|settings)$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/(users|apps|history|tables|secrets)$`)],
  ["GET HEAD POST", new RegExp(`^cells/${CELL}/(authors|keys|migrations)$`)],
  ["DELETE", new RegExp(`^cells/${CELL}/(authors|keys)/${UUID}$`)],
  ["PUT DELETE", new RegExp(`^cells/${CELL}/apps/${APP}$`)],
  ["PUT DELETE", new RegExp(`^cells/${CELL}/secrets/[A-Za-z_][A-Za-z0-9_]*$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/types/(rust|typescript)$`)],
  ["GET HEAD PUT", new RegExp(`^cells/${CELL}/storage/provider$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/storage/(buckets|migrations)$`)],
  ["PUT DELETE", new RegExp(`^cells/${CELL}/storage/buckets/${BUCKET}$`)],
  ["PUT", new RegExp(`^cells/${CELL}/storage/buckets/${BUCKET}/rule$`)],
  ["POST", new RegExp(`^cells/${CELL}/storage/migrations/${UUID}/retry$`)],
  ["GET HEAD POST", new RegExp(`^cells/${CELL}/storage-api/uploads$`)],
  ["GET HEAD DELETE", new RegExp(`^cells/${CELL}/storage-api/uploads/${UUID}$`)],
  ["PUT", new RegExp(`^cells/${CELL}/storage-api/uploads/${UUID}/parts/[0-9]{1,4}$`)],
  ["POST", new RegExp(`^cells/${CELL}/storage-api/uploads/${UUID}/complete$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/storage-api/files/${BUCKET}$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/storage-api/object/${BUCKET}/.+$`)],
  ["POST", new RegExp(`^cells/${CELL}/storage-api/(files|sign)$`)],
  ["GET HEAD", /^invitations$/],
  ["POST", new RegExp(`^invitations/${UUID}/(accept|decline|cancel)$`)],
];
export function cellsProxyRoute(path: string, method: string): string | null {
  let segments: string[];
  try { segments = path.split("/").map(decodeURIComponent); } catch { return null; }
  if (segments.some(s => !s || s === "." || s === ".." || /[/\\\x00-\x1f\x7f]/u.test(s))) return null;
  const decoded = segments.join("/");
  return routes.some(([verbs, pattern]) => verbs.split(" ").includes(method.toUpperCase()) && pattern.test(decoded)) ? `v1/${segments.map(encodeURIComponent).join("/")}` : null;
}
export function cellsUploadPart(path: string, method: string): boolean {
  return method === "PUT" && new RegExp(`^v1/cells/${CELL}/storage-api/uploads/${UUID}/parts/[0-9]{1,4}$`).test(path);
}
