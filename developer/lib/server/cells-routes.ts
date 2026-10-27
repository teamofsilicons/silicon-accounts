/** Only the author interface. Cell-user sessions and private service bridges stay outside the developer proxy. */
const CELL = "[a-z][a-z0-9-]{2,62}";
const APP = "[a-z0-9_-]{3,30}";
const UUID = "[0-9a-f-]{36}";
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
  ["GET HEAD", /^invitations$/],
  ["POST", new RegExp(`^invitations/${UUID}/(accept|decline|cancel)$`)],
];
export function cellsProxyRoute(path: string, method: string): string | null {
  if (path.split("/").some(s => !s || s === "." || s === ".." || s.includes("%") || s.includes("\\"))) return null;
  return routes.some(([verbs, pattern]) => verbs.split(" ").includes(method.toUpperCase()) && pattern.test(path)) ? `v1/${path}` : null;
}
