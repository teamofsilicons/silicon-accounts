/** Only the author interface. Cell-user sessions and private service bridges stay outside the developer proxy. */
const PARENT = "[a-z][a-z0-9-]{1,28}[a-z0-9]";
const COPY = "[a-z](?:[a-z0-9-]{0,28}[a-z0-9])?";
const CELL = `${PARENT}(?:--${COPY})?`;
const APP = "[a-z0-9_-]{3,30}";
const UUID = "[0-9a-f-]{36}";
const BUCKET = "[a-z0-9][a-z0-9_-]{0,62}";
const FUNCTION = "[a-z][a-z0-9_-]{0,62}";
const TEMPLATE = "(?!catalog(?:/|$))[a-z][a-z0-9-]{0,39}";
const JOB = `(?!preview(?:/|$))${FUNCTION}`;
const routes: [string, RegExp][] = [
  ["GET HEAD", new RegExp(`^cells/${CELL}/database/(reference|extensions|connections)$`)],
  ["POST", new RegExp(`^cells/${CELL}/database/password/rotate$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/database/password-rotations/${UUID}$`)],
  ["POST", new RegExp(`^cells/${CELL}/database/extensions/(vector|postgis|pg_trgm|pgcrypto|uuid-ossp|citext|hstore|btree_gist|btree_gin|unaccent)$`)],
  ["POST", new RegExp(`^cells/${CELL}/database/rows/(query|change)$`)],
  ["GET HEAD POST", new RegExp(`^cells/${CELL}/database/queries$`)],
  ["GET HEAD PUT DELETE", new RegExp(`^cells/${CELL}/database/queries/${UUID}$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/usage$`)],
  ["GET HEAD PUT", new RegExp(`^cells/${CELL}/limits$`)],
  ["GET HEAD PATCH", new RegExp(`^cells/${CELL}/copy$`)],
  ["GET HEAD POST", new RegExp(`^cells/${PARENT}/copies$`)],
  ["GET HEAD PATCH DELETE", new RegExp(`^cells/${PARENT}/copies/${COPY}$`)],
  ["POST", new RegExp(`^cells/${PARENT}/copies/${COPY}/reset$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/logs$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/database/slow-queries$`)],
  ["GET HEAD", /^me$/],
  ["GET HEAD POST", /^cells$/],
  ["GET HEAD", /^cells\/availability$/],
  ["GET HEAD POST", new RegExp(`^apps/${APP}/cell$`)],
  ["GET HEAD DELETE", new RegExp(`^cells/${CELL}$`)],
  ["POST", new RegExp(`^cells/${CELL}/(restore|sql|schema|import)$`)],
  ["PUT", new RegExp(`^cells/${CELL}/(admin|settings)$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/(users|apps|history|tables|secrets|notifications)$`)],
  ["GET HEAD POST", new RegExp(`^cells/${CELL}/ting-subscriptions$`)],
  ["GET HEAD PATCH DELETE", new RegExp(`^cells/${CELL}/ting-subscriptions/${UUID}$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/ting-subscriptions/${UUID}/(definition|deliveries)$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/ting-subscriptions/${UUID}/deliveries/${UUID}$`)],
  ["POST", new RegExp(`^cells/${CELL}/ting-subscriptions/${UUID}/deliveries/${UUID}/retry$`)],
  ["GET HEAD POST", new RegExp(`^cells/${CELL}/backups$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/backups/${UUID}(?:/download)?$`)],
  ["POST", new RegExp(`^cells/${CELL}/backups/restore$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/restores(?:/${UUID})?$`)],
  ["POST", new RegExp(`^cells/${CELL}/restores/${UUID}/retry$`)],
  ["GET HEAD PUT DELETE", new RegExp(`^cells/${CELL}/domain$`)],
  ["POST", new RegExp(`^cells/${CELL}/domain/check$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/templates(?:/catalog)?$`)],
  ["GET HEAD PUT PATCH DELETE", new RegExp(`^cells/${CELL}/templates/${TEMPLATE}$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/templates/${TEMPLATE}/definition$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/services$`)],
  ["GET HEAD PUT DELETE", new RegExp(`^cells/${CELL}/services/${FUNCTION}$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/services/${FUNCTION}/versions/${UUID}$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/services/${FUNCTION}/logs$`)],
  ["POST", new RegExp(`^cells/${CELL}/services/${FUNCTION}/(start|stop|restart|activate)$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/realtime/(channels|connections)$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/jobs$`)],
  ["POST", new RegExp(`^cells/${CELL}/jobs/preview$`)],
  ["GET HEAD PUT PATCH DELETE", new RegExp(`^cells/${CELL}/jobs/${JOB}$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/jobs/${JOB}/(definition|versions|runs)$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/jobs/${JOB}/(versions|runs)/${UUID}$`)],
  ["POST", new RegExp(`^cells/${CELL}/jobs/${JOB}/run$`)],
  ["POST", new RegExp(`^cells/${CELL}/jobs/${JOB}/runs/${UUID}/retry$`)],
  ["GET HEAD POST", new RegExp(`^cells/${CELL}/triggers$`)],
  ["PUT DELETE", new RegExp(`^cells/${CELL}/triggers/${UUID}$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/triggers/${UUID}/deliveries$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/triggers/${UUID}/deliveries/${UUID}$`)],
  ["POST", new RegExp(`^cells/${CELL}/triggers/${UUID}/deliveries/${UUID}/retry$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/queues$`)],
  ["GET HEAD PUT PATCH DELETE", new RegExp(`^cells/${CELL}/queues/${FUNCTION}$`)],
  ["GET HEAD POST", new RegExp(`^cells/${CELL}/queues/${FUNCTION}/messages$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/queues/${FUNCTION}/messages/${UUID}$`)],
  ["POST", new RegExp(`^cells/${CELL}/queues/${FUNCTION}/messages/${UUID}/retry$`)],
  ["GET HEAD POST", new RegExp(`^cells/${CELL}/webhooks$`)],
  ["PATCH DELETE", new RegExp(`^cells/${CELL}/webhooks/${UUID}$`)],
  ["POST", new RegExp(`^cells/${CELL}/webhooks/${UUID}/rotate-secret$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/webhooks/${UUID}/deliveries$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/webhooks/${UUID}/deliveries/${UUID}$`)],
  ["POST", new RegExp(`^cells/${CELL}/webhooks/${UUID}/deliveries/${UUID}/retry$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/functions$`)],
  ["GET HEAD PUT DELETE", new RegExp(`^cells/${CELL}/functions/${FUNCTION}$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/functions/${FUNCTION}/invocations$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/functions/${FUNCTION}/versions/${UUID}$`)],
  ["POST", new RegExp(`^cells/${CELL}/functions/${FUNCTION}/(activate|invoke)$`)],
  ["POST", new RegExp(`^cells/${CELL}/notifications/${UUID}/retry$`)],
  ["GET HEAD POST", new RegExp(`^cells/${CELL}/(authors|keys|migrations)$`)],
  ["DELETE", new RegExp(`^cells/${CELL}/(authors|keys)/${UUID}$`)],
  ["PUT DELETE", new RegExp(`^cells/${CELL}/apps/${APP}$`)],
  ["PUT DELETE", new RegExp(`^cells/${CELL}/secrets/[A-Za-z_][A-Za-z0-9_]*$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/types/(rust|typescript)$`)],
  ["GET HEAD PUT", new RegExp(`^cells/${CELL}/storage/provider$`)],
  ["GET HEAD", new RegExp(`^cells/${CELL}/storage/(buckets|migrations|locations)$`)],
  ["PUT", new RegExp(`^cells/${CELL}/storage/locations/${UUID}/credentials$`)],
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
  ["GET HEAD", new RegExp(`^cells/${CELL}/storage-api/trash/${BUCKET}$`)],
  ["POST", new RegExp(`^cells/${CELL}/storage-api/trash/${UUID}/restore$`)],
  ["GET HEAD", /^invitations$/],
  ["POST", new RegExp(`^invitations/${UUID}/(accept|decline|cancel)$`)],
];
export function cellsProxyRoute(path: string, method: string): string | null {
  let segments: string[];
  try { segments = path.split("/").map(decodeURIComponent); } catch { return null; }
  if (segments[0]==="cells" && segments[1]!=="availability" && segments.length>1) {
    const [parent,copy,...extra]=segments[1]!.split("--");
    if(extra.length || !new RegExp(`^${PARENT}$`).test(parent!) || parent!.includes("--") || (copy!==undefined && (!new RegExp(`^${COPY}$`).test(copy) || copy.includes("--")))) return null;
    if(segments[2]==="copies" && (copy!==undefined || (segments[3]!==undefined && (!new RegExp(`^${COPY}$`).test(segments[3]) || segments[3].includes("--"))))) return null;
  }
  // A channel is exactly one encoded terminal segment; slashes are data here.
  if (segments.length===5 && segments[0]==="cells" && new RegExp(`^${CELL}$`).test(segments[1]!) && segments[2]==="realtime" && segments[3]==="channels" && ["PUT","DELETE"].includes(method.toUpperCase()) && /^[A-Za-z0-9_:/.-]{1,128}$/u.test(segments[4]!) && ![".",".."].includes(segments[4]!)) return `v1/${segments.map(encodeURIComponent).join("/")}`;
  if (segments.some(s => !s || s === "." || s === ".." || /[/\\\x00-\x1f\x7f]/u.test(s))) return null;
  if(segments.length===5 && segments[0]==="cells" && new RegExp(`^${CELL}$`).test(segments[1]!) && segments[2]==="database" && segments[3]==="tables" && ["GET","HEAD"].includes(method.toUpperCase()) && new TextEncoder().encode(segments[4]!).byteLength<=63) return `v1/${segments.map(encodeURIComponent).join("/")}`;
  const decoded = segments.join("/");
  return routes.some(([verbs, pattern]) => verbs.split(" ").includes(method.toUpperCase()) && pattern.test(decoded)) ? `v1/${segments.map(encodeURIComponent).join("/")}` : null;
}
export function cellsUploadPart(path: string, method: string): boolean {
  return method === "PUT" && new RegExp(`^v1/cells/${CELL}/storage-api/uploads/${UUID}/parts/[0-9]{1,4}$`).test(path);
}
export function cellsFunctionBody(path: string, method: string): boolean {
  return method === "PUT" && new RegExp(`^v1/cells/${CELL}/functions/${FUNCTION}$`).test(path)
    || cellsFunctionInvocation(path,method);
}
export function cellsFunctionInvocation(path: string, method: string): boolean {
  return method === "POST" && new RegExp(`^v1/cells/${CELL}/functions/${FUNCTION}/invoke$`).test(path);
}

export function cellsBackupDownload(path:string,method:string):boolean {
  return ["GET","HEAD"].includes(method) && new RegExp(`^v1/cells/${CELL}/backups/${UUID}/download$`).test(path);
}
