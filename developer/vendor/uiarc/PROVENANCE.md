# Arc UI provenance

Source index: https://uiarc.dev/llms.txt
Registry: https://uiarc.dev/r/registry.json
License: https://uiarc.dev/license (MIT, copyright 2026 Elia Kuratli; retained in LICENSE).

The common portal uses the existing Silicon Accounts `developer/components/silicon-ui` source, originally installed through the `@uiarc` shadcn registry. Accounts’ `web/README.md` records that installation and the local squircle, motion, focus, typography and theme adaptations; `developer/README.md` records subsequent developer-specific changes. Publishing imports those existing Button, Input, Textarea, Badge, CopyButton, Dialog, EmptyState, Switch and other primitives directly. No replacement imitation or Pro component source was added by this integration.

Publishing behavior was adapted from Silicon Apps `web/src/{Developer,Setup,Management,Docs,api,ui,types}` into native Next routes and the existing common shell. That upstream repository preserves its original free registry JSON responses and component documentation at https://github.com/teamofsilicons/silicon-apps/tree/main/web/vendor/uiarc .
