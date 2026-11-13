import test from "node:test";
import assert from "node:assert/strict";
import { cellsProxyRoute, cellsFunctionBody, cellsFunctionInvocation, cellsBackupDownload } from "../lib/server/cells-routes";

test("Test copies have explicit control routes and independent routable addresses",()=>{
  assert.equal(cellsProxyRoute("cells/notes--qa/copy","GET"),"v1/cells/notes--qa/copy");
  assert.equal(cellsProxyRoute("cells/notes--qa/copy","PATCH"),"v1/cells/notes--qa/copy");
  assert.equal(cellsProxyRoute("cells/notes--qa/copy","DELETE"),null);
  assert.equal(cellsProxyRoute("cells/notes/copies","POST"),"v1/cells/notes/copies");
  assert.equal(cellsProxyRoute("cells/notes/copies/qa/reset","POST"),"v1/cells/notes/copies/qa/reset");
  assert.equal(cellsProxyRoute("cells/notes/copies/qa","PATCH"),"v1/cells/notes/copies/qa");
  assert.equal(cellsProxyRoute("cells/notes/copies/qa","DELETE"),"v1/cells/notes/copies/qa");
  const longest=`${"a".repeat(30)}--${"b".repeat(30)}`;
  for(const address of ["notes--q","notes--qa-copy",longest]) {
    assert.equal(cellsProxyRoute(`cells/${address}/sql`,"POST"),`v1/cells/${address}/sql`);
    assert.equal(cellsProxyRoute(`cells/${address}/storage/buckets`,"GET"),`v1/cells/${address}/storage/buckets`);
  }
  for(const address of ["notes--", "notes---qa", "notes--qa--nested", `notes--${"x".repeat(31)}`]) assert.equal(cellsProxyRoute(`cells/${address}/sql`,"POST"),null);
  for(const path of ["cells/notes--qa/copies","cells/notes/copies/qa--nested","cells/notes/copies/%2e%2e","cells/notes/copies/qa/reset/extra"]) assert.equal(cellsProxyRoute(path,"POST"),null);
  assert.equal(cellsProxyRoute("cells/notes/copies/qa/reset","GET"),null);
});

test("Cells author paths cannot reach private grants, user sessions or another origin", () => {
  assert.equal(cellsProxyRoute("apps/notes-app/cell", "POST"), "v1/apps/notes-app/cell");
  assert.equal(cellsProxyRoute("cells/notes/sql", "POST"), "v1/cells/notes/sql");
  assert.equal(cellsProxyRoute("cells/notes/secrets/SERVICE_KEY", "PUT"), "v1/cells/notes/secrets/SERVICE_KEY");
  for (const path of ["auth/silicon", "auth/refresh", "internal/cells/author", "rest/v1/users", "cells/../me", "cells/%2e%2e/me", "//attacker.example", "cells/notes\\..\\me", "cells/notes/secrets/KEY/extra"]) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) assert.equal(cellsProxyRoute(path, method), null, `${method} ${path}`);
  }
  assert.equal(cellsProxyRoute("cells/notes/sql", "GET"), null);
  const deleted="12345678-1234-1234-1234-123456789abc";
  assert.equal(cellsProxyRoute("cells/notes/notifications","GET"),"v1/cells/notes/notifications");
  assert.equal(cellsProxyRoute(`cells/notes/notifications/${deleted}/retry`,"POST"),`v1/cells/notes/notifications/${deleted}/retry`);
  // A Developer token is not Cells consent; the browser must not proxy proof enrollment.
  assert.equal(cellsProxyRoute("notifications/subscription","POST"),null);
  assert.equal(cellsProxyRoute(`cells/notes/notifications/${deleted}/retry`,"GET"),null);
  assert.equal(cellsProxyRoute("cells/notes/storage-api/trash/photos","GET"),"v1/cells/notes/storage-api/trash/photos");
  assert.equal(cellsProxyRoute(`cells/notes/storage-api/trash/${deleted}/restore`,"POST"),`v1/cells/notes/storage-api/trash/${deleted}/restore`);
  assert.equal(cellsProxyRoute(`cells/notes/storage-api/trash/${deleted}/restore`,"DELETE"),null);
  assert.equal(cellsProxyRoute("cells/notes/storage/locations","GET"),"v1/cells/notes/storage/locations");
  assert.equal(cellsProxyRoute(`cells/notes/storage/locations/${deleted}/credentials`,"PUT"),`v1/cells/notes/storage/locations/${deleted}/credentials`);
  assert.equal(cellsProxyRoute(`cells/notes/storage/locations/${deleted}/credentials`,"GET"),null);
});

test("Function proxy routes stay within author management and only invocation gets extra execution time",()=>{
  const root="cells/notes/functions/hello";
  assert.equal(cellsProxyRoute(root,"PUT"),`v1/${root}`);
  assert.equal(cellsProxyRoute(`${root}/invoke`,"POST"),`v1/${root}/invoke`);
  assert.equal(cellsProxyRoute(`${root}/invocations`,"GET"),`v1/${root}/invocations`);
  assert.equal(cellsProxyRoute(`${root}/versions/12345678-1234-1234-1234-123456789abc`,"GET"),`v1/${root}/versions/12345678-1234-1234-1234-123456789abc`);
  for(const path of ["functions/hello",`${root}/invoke/extra`,`${root}/%2e%2e/invoke`,`${root}/versions/../invoke`])assert.equal(cellsProxyRoute(path,"POST"),null);
  assert.equal(cellsProxyRoute(`${root}/invoke`,"GET"),null);
  assert.equal(cellsProxyRoute(`${root}/invocations`,"DELETE"),null);
  assert.equal(cellsFunctionBody(`v1/${root}`,"PUT"),true);
  assert.equal(cellsFunctionBody(`v1/${root}/activate`,"POST"),false);
  assert.equal(cellsFunctionInvocation(`v1/${root}/invoke`,"POST"),true);
  assert.equal(cellsFunctionInvocation(`v1/${root}`,"PUT"),false);
});

test("Outgoing webhook management excludes private dispatch and signing-secret reads",()=>{
  const id="12345678-1234-1234-1234-123456789abc",root=`cells/notes/webhooks/${id}`;
  assert.equal(cellsProxyRoute("cells/notes/webhooks","POST"),"v1/cells/notes/webhooks");
  assert.equal(cellsProxyRoute(root,"PATCH"),`v1/${root}`);
  assert.equal(cellsProxyRoute(`${root}/rotate-secret`,"POST"),`v1/${root}/rotate-secret`);
  assert.equal(cellsProxyRoute(`${root}/deliveries/${id}`,"GET"),`v1/${root}/deliveries/${id}`);
  assert.equal(cellsProxyRoute(`${root}/deliveries/${id}/retry`,"POST"),`v1/${root}/deliveries/${id}/retry`);
  for(const path of [`${root}/secret`,`${root}/rotate-secret`,`${root}/dispatch`,`${root}/deliveries/${id}/retry`])assert.equal(cellsProxyRoute(path,"GET"),null);
  assert.equal(cellsProxyRoute(`${root}/deliveries/${id}/%2e%2e/retry`,"POST"),null);
});

test("Queue author routes do not expose public enqueue or worker dispatch",()=>{
  const root="cells/notes/queues/orders",id="12345678-1234-1234-1234-123456789abc";
  assert.equal(cellsProxyRoute(root,"PUT"),`v1/${root}`);
  assert.equal(cellsProxyRoute(`${root}/messages`,"POST"),`v1/${root}/messages`);
  assert.equal(cellsProxyRoute(`${root}/messages/${id}`,"GET"),`v1/${root}/messages/${id}`);
  assert.equal(cellsProxyRoute(`${root}/messages/${id}/retry`,"POST"),`v1/${root}/messages/${id}/retry`);
  for(const path of ["queues/orders/messages",`${root}/dispatch`,`${root}/messages/${id}/ack`,`${root}/messages/%2e%2e/retry`])assert.equal(cellsProxyRoute(path,"POST"),null);
  assert.equal(cellsProxyRoute(`${root}/messages/${id}`,"DELETE"),null);
});

test("Event trigger management never exposes direct worker dispatch",()=>{
  const id="12345678-1234-1234-1234-123456789abc",root=`cells/notes/triggers/${id}`;
  assert.equal(cellsProxyRoute("cells/notes/triggers","POST"),"v1/cells/notes/triggers");
  assert.equal(cellsProxyRoute(root,"PUT"),`v1/${root}`);
  assert.equal(cellsProxyRoute(`${root}/deliveries/${id}`,"GET"),`v1/${root}/deliveries/${id}`);
  assert.equal(cellsProxyRoute(`${root}/deliveries/${id}/retry`,"POST"),`v1/${root}/deliveries/${id}/retry`);
  assert.equal(cellsProxyRoute(root,"PATCH"),null);
  assert.equal(cellsProxyRoute(`${root}/dispatch`,"POST"),null);
  assert.equal(cellsProxyRoute(`${root}/deliveries/${id}/ack`,"POST"),null);
  assert.equal(cellsProxyRoute(`${root}/deliveries/${id}/retry`,"GET"),null);
});

test("Scheduled jobs expose only author control and explicit history paths",()=>{
  const id="12345678-1234-1234-1234-123456789abc",root="cells/notes/jobs/report";
  assert.equal(cellsProxyRoute("cells/notes/jobs/preview","POST"),"v1/cells/notes/jobs/preview");
  assert.equal(cellsProxyRoute(root,"PUT"),`v1/${root}`);
  assert.equal(cellsProxyRoute(`${root}/definition`,"GET"),`v1/${root}/definition`);
  assert.equal(cellsProxyRoute(`${root}/versions/${id}`,"GET"),`v1/${root}/versions/${id}`);
  assert.equal(cellsProxyRoute(`${root}/runs/${id}/retry`,"POST"),`v1/${root}/runs/${id}/retry`);
  for(const path of ["jobs/report/run",`${root}/dispatch`,`${root}/runs/${id}/ack`,`${root}/run/%2e%2e`])assert.equal(cellsProxyRoute(path,"POST"),null);
  assert.equal(cellsProxyRoute(`${root}/run`,"GET"),null);
  assert.equal(cellsProxyRoute(`${root}/definition`,"PUT"),null);
  for(const method of ["GET","PUT","PATCH","DELETE"])assert.equal(cellsProxyRoute("cells/notes/jobs/preview",method),null);
  assert.equal(cellsProxyRoute("cells/notes/jobs/preview/run","POST"),null);
});

test("Realtime author metadata allows one encoded channel segment without a websocket proxy",()=>{
  assert.equal(cellsProxyRoute("cells/notes/realtime/channels","GET"),"v1/cells/notes/realtime/channels");
  assert.equal(cellsProxyRoute("cells/notes/realtime/connections","GET"),"v1/cells/notes/realtime/connections");
  assert.equal(cellsProxyRoute("cells/notes/realtime/channels/team%3Aone%2Fnotes","PUT"),"v1/cells/notes/realtime/channels/team%3Aone%2Fnotes");
  assert.equal(cellsProxyRoute("cells/notes/realtime/channels/team%3Aone%2Fnotes","DELETE"),"v1/cells/notes/realtime/channels/team%3Aone%2Fnotes");
  for(const path of ["cells/notes/realtime/channels/..","cells/notes/realtime/channels/%2e%2e","cells/notes/realtime/channels/team/notes","cells/notes/realtime/channels/team%252Fnotes","cells/notes/realtime/channels/a%00b","cells/notes/realtime/channels/name/permissions"])assert.equal(cellsProxyRoute(path,"PUT"),null);
  for(const path of ["realtime/v1/websocket","cells/notes/realtime/websocket","cells/notes/realtime/channels/team%2Fnotes","cells/notes/realtime/permissions"])assert.equal(cellsProxyRoute(path,"GET"),null);
});

test("Persistent services proxy only explicit author versions logs and lifecycle actions",()=>{
  const root="cells/notes/services/web",id="12345678-1234-1234-1234-123456789abc";
  assert.equal(cellsProxyRoute("cells/notes/services","GET"),"v1/cells/notes/services");
  for(const method of ["GET","PUT","DELETE"])assert.equal(cellsProxyRoute(root,method),`v1/${root}`);
  assert.equal(cellsProxyRoute(`${root}/versions/${id}`,"GET"),`v1/${root}/versions/${id}`);
  assert.equal(cellsProxyRoute(`${root}/logs`,"GET"),`v1/${root}/logs`);
  for(const action of ["start","stop","restart","activate"])assert.equal(cellsProxyRoute(`${root}/${action}`,"POST"),`v1/${root}/${action}`);
  for(const path of ["services/web",`${root}/env`,`${root}/secrets`,`${root}/streams`,`${root}/start`,`${root}/versions/${id}/logs`])assert.equal(cellsProxyRoute(path,"GET"),null);
  assert.equal(cellsProxyRoute(root,"PATCH"),null);
});
test("Templates proxy catalog and configuration without allowing generated public routes",()=>{
  const root="cells/notes/templates/newsletter";
  for(const path of ["cells/notes/templates","cells/notes/templates/catalog",root,`${root}/definition`])assert.equal(cellsProxyRoute(path,"GET"),`v1/${path}`);
  for(const method of ["PUT","PATCH","DELETE"])assert.equal(cellsProxyRoute(root,method),`v1/${root}`);
  for(const [path,method] of [["cells/notes/templates/catalog","PUT"],["cells/notes/templates/catalog/definition","GET"],["cells/notes/templates/with_underscore","PUT"],[`${root}/source`,"GET"],[`${root}/definition`,"PUT"],["templates/newsletter","POST"],[`${root}/submit`,"POST"]])assert.equal(cellsProxyRoute(path!,method!),null);
});


test("Custom domains expose only author configuration and verification",()=>{
  for(const method of ["GET","HEAD","PUT","DELETE"])assert.equal(cellsProxyRoute("cells/notes/domain",method),"v1/cells/notes/domain");
  assert.equal(cellsProxyRoute("cells/notes/domain/check","POST"),"v1/cells/notes/domain/check");
  for(const path of ["internal/domains/allow","cells/notes/domain/callback","cells/notes/domain/proof","cells/notes/domain/check/extra"])assert.equal(cellsProxyRoute(path,"POST"),null);
  assert.equal(cellsProxyRoute("cells/notes/domain","PATCH"),null);
});


test("Event Ting configuration never proxies recipient consent or dispatch",()=>{
  const id="12345678-1234-1234-1234-123456789abc",base=`cells/notes/ting-subscriptions/${id}`;
  for(const [method,path] of [["POST","cells/notes/ting-subscriptions"],["PATCH",base],["GET",`${base}/definition`],["GET",`${base}/deliveries/${id}`],["POST",`${base}/deliveries/${id}/retry`]])assert.equal(cellsProxyRoute(path!,method!),`v1/${path}`);
  for(const path of [`${base}/dispatch`,`${base}/consent`,`${base}/recipients/${id}`,"ting/subscribe","notifications/subscription"])assert.equal(cellsProxyRoute(path,"POST"),null);
});


test("Backups permit authenticated author download and durable restore admission only",()=>{
  const id="12345678-1234-1234-1234-123456789abc",base="cells/notes/backups";
  for(const [method,path] of [["GET",base],["POST",base],["GET",`${base}/${id}`],["GET",`${base}/${id}/download`],["POST",`${base}/restore`],["GET","cells/notes/restores"],["GET",`cells/notes/restores/${id}`],["POST",`cells/notes/restores/${id}/retry`]])assert.equal(cellsProxyRoute(path!,method!),`v1/${path}`);
  for(const path of [`${base}/restore`,`${base}/${id}/manifest`,`${base}/${id}/key`,`${base}/${id}/download/extra`,"internal/backups/recover"])assert.equal(cellsProxyRoute(path,"GET"),null);
  assert.equal(cellsProxyRoute(`${base}/${id}/download`,"POST"),null);
  assert.equal(cellsProxyRoute(`cells/notes/restores/${id}/retry`,"GET"),null);
  assert.equal(cellsBackupDownload(`v1/${base}/${id}/download`,"GET"),true);
  assert.equal(cellsBackupDownload(`v1/${base}/${id}`,"GET"),false);
});

test("Unified logs expose safe author reads without query text or raw backend endpoints",()=>{
  for(const path of ["cells/notes/logs","cells/notes/database/slow-queries"]){for(const method of ["GET","HEAD"])assert.equal(cellsProxyRoute(path,method),`v1/${path}`);for(const method of ["POST","DELETE","PUT"])assert.equal(cellsProxyRoute(path,method),null);}
  for(const path of ["cells/notes/database/pg_stat_statements","cells/notes/logs/raw","cells/notes/database/slow-queries/sql","internal/logs"])assert.equal(cellsProxyRoute(path,"GET"),null);
});

test("database editor proxy is bounded to exact author query and row operations",()=>{
  for(const table of ["notes","Mixed Case",'Quoted"Name',"सारणी"]) assert.equal(cellsProxyRoute(`cells/notes/database/tables/${encodeURIComponent(table)}`,"GET"),`v1/cells/notes/database/tables/${encodeURIComponent(table)}`);
  for(const table of ["%2e%2e","%2Fetc","back%5Cslash","x".repeat(64),encodeURIComponent("é".repeat(32))]) assert.equal(cellsProxyRoute(`cells/notes/database/tables/${table}`,"GET"),null);
  assert.equal(cellsProxyRoute("cells/notes/database/tables/notes","DELETE"),null);
  for(const route of ["query","change"]) {assert.equal(cellsProxyRoute(`cells/notes/database/rows/${route}`,"POST"),`v1/cells/notes/database/rows/${route}`);assert.equal(cellsProxyRoute(`cells/notes/database/rows/${route}`,"GET"),null);}
  const id="12345678-1234-1234-1234-123456789abc";assert.equal(cellsProxyRoute(`cells/notes--qa/database/queries/${id}`,"PUT"),`v1/cells/notes--qa/database/queries/${id}`);
  assert.equal(cellsProxyRoute("cells/notes/database/queries","POST"),"v1/cells/notes/database/queries");assert.equal(cellsProxyRoute("cells/notes/database/execute","POST"),null);
});

test("Database reference and extension controls expose only the safe catalog",()=>{
 for(const suffix of ["reference","extensions","connections"])assert.equal(cellsProxyRoute(`cells/notes/database/${suffix}`,"GET"),`v1/cells/notes/database/${suffix}`);
 assert.equal(cellsProxyRoute("cells/notes/database/extensions/vector","POST"),"v1/cells/notes/database/extensions/vector");
 assert.equal(cellsProxyRoute("cells/notes/database/extensions/file_fdw","POST"),null);
 assert.equal(cellsProxyRoute("cells/notes/database/extensions/vector","DELETE"),null);
});


test("Database passwords allow explicit replacement and metadata reads only",()=>{
 const id="12345678-1234-1234-1234-123456789abc";
 for(const cell of ["notes","notes--qa"]){
  const root=`cells/${cell}/database`;
  assert.equal(cellsProxyRoute(`${root}/password/rotate`,"POST"),`v1/${root}/password/rotate`);
  for(const method of ["GET","HEAD"])assert.equal(cellsProxyRoute(`${root}/password-rotations/${id}`,method),`v1/${root}/password-rotations/${id}`);
  for(const method of ["GET","HEAD","PUT","DELETE"])assert.equal(cellsProxyRoute(`${root}/password/rotate`,method),null);
  for(const method of ["POST","PUT","DELETE"])assert.equal(cellsProxyRoute(`${root}/password-rotations/${id}`,method),null);
  for(const path of [`${root}/password`,`${root}/password-rotations/${id}/password`,`${root}/password-rotations/${id}/%2e%2e`,`${root}/password/rotate/extra`])assert.equal(cellsProxyRoute(path,"GET"),null);
 }
});
