# Stageshow kit (vendored)

The React kit from Benji Taylor's stageshow skill (MIT, see LICENSE; copied from `.agents/skills/stageshow/kit`,
2026-11-01) for drawn product illustrations: the Silicons first-visit stories (`components/account/silicons/`).
Illustration code, not product UI: it is exempt from Silicon UI's lint rules (eslint.config.mjs). Update it by copying
the skill's `kit/` again; don't edit it here.

Local edits: `kit/phone.tsx` drops an unused `useLayoutEffect` import (the site's TypeScript is strict about unused
locals). Reapply after updating.
