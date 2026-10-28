import test from "node:test";
import assert from "node:assert/strict";
import { cellsProxyRoute, cellsFunctionBody, cellsFunctionInvocation } from "../lib/server/cells-routes";

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
