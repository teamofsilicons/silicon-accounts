import test from "node:test";
import assert from "node:assert/strict";
import {interfacesProxyRoute} from "../lib/server/interfaces-routes";

test("Interfaces proxy allows author controls but not authentication, internals or traversal",()=>{
  for(const [path,method] of [["me","GET"],["interfaces","POST"],["interfaces/notes","PATCH"],["interfaces/notes/resume","POST"],["interfaces/notes/uploads","POST"],["interfaces/notes/uploads/abc-123","GET"],["interfaces/notes/releases","POST"],["interfaces/notes/requests","GET"],["invites/abc-123/accept","POST"]]) assert.equal(interfacesProxyRoute(path,method),`v1/${path}`);
  for(const [path,method] of [["auth/token","POST"],["internal/interfaces","GET"],["interfaces/../me","GET"],["interfaces/%2e%2e/me","GET"],["interfaces/notes\\..\\me","GET"],["//attacker","GET"],["interfaces/notes/rotate-secret","GET"],["interfaces/notes/uploads/abc-123","POST"],["interfaces/notes/releases","DELETE"]]) assert.equal(interfacesProxyRoute(path,method),null);
});
