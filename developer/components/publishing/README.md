# Publishing in the common developer portal

These native React panels adapt the tested Silicon Apps publishing flow into the existing Silicon Accounts Next.js frontend. There is one shell, app registry, sealed developer session, Arc component set and navigation system. No nested application or iframe is mounted.

Routes: `/apps/:id/publishing?step=1` through step 7; `/releases`, `/authors` and `/history` under the same app; `/invitations`; `/settings` for the shared telemetry preference. Creation is `POST /api/apps/apps`, not an Accounts placeholder.

The free UIArc components are the existing `components/silicon-ui` registry sources used by Accounts (original `@uiarc` shadcn registry at https://uiarc.dev/). Publishing imports these exact native controls and the existing squircle runtime. The preserved MIT license and source provenance are under `vendor/uiarc/`; Apps adaptation origin is https://github.com/teamofsilicons/silicon-apps/tree/main/web. Publishing CSS is scoped to `.publishing-panel` and uses the host’s theme tokens; no second font/theme reset is loaded.

`api.ts` calls only the same-origin `/api/apps` BFF. App secrets stay in component memory. Autosaves retain failed drafts in this tab on browser history moves, while ordinary navigation flushes and blocks on save failure. Tests in `e2e` exercise this together with the existing Accounts workspace.

Documentation lives in `components/docs/` and `lib/docs/`, with `/docs/apps` built from repository `docs-apps/` and `/docs/accounts` from `docs/`. The publishing components do not own a separate documentation page.
