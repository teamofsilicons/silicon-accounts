import test from "node:test";
import assert from "node:assert/strict";
import { cellsProxyRoute } from "../lib/server/cells-routes";

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
