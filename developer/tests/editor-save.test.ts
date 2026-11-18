/** Saving in the sign-in editor: what the Carbon does while a save is in flight is never dropped. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppDetail } from "../lib/api/types";
import { ConfigEditor } from "../components/developer/lib/editor";

test("a secret typed while a Sign-in save is in flight stays after the save", async () => {
  const detail = (version: number) => ({ config_version: version, signin_config: { google: { mode: "byo", client_id: "id.apps.googleusercontent.com", client_secret_set: true } } }) as unknown as AppDetail;
  const realFetch = globalThis.fetch;
  let answer: (response: Response) => void = () => undefined;
  globalThis.fetch = (() => new Promise<Response>(resolve => { answer = resolve; })) as typeof fetch;
  try {
    const editor = new ConfigEditor("briefcase", detail(1));
    editor.edit("allow_signup", false);
    const saving = editor.save("signin");
    editor.setSecrets({ googleReplace: true, googleSecret: "GOCSPX-new" });
    answer(Response.json(detail(2)));
    assert.equal(await saving, true);
    const view = editor.getView();
    assert.equal(view.secrets.googleSecret, "GOCSPX-new");
    assert.equal(view.secrets.googleReplace, true);
    assert.ok(view.changes.signin.includes("google.client_secret"), "the kept secret is still an unsaved change");
  } finally {
    globalThis.fetch = realFetch;
  }
});
