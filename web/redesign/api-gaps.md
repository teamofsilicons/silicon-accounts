# API gaps

Parts of the v7 prototype the account site can't build because the API has no endpoint for them. The site leaves
them out until the API ships them; nothing is mocked in the product. For the API developers, most needed first.

| # | Prototype part | Where it shows | What the API needs |
|---|---|---|---|
| 1 | Notification preferences | Notifications page | Read and set: destination email (one of the account's verified emails); toggles for new device signs in, wrong Silicon keys tried, an app gets permission to act for you, weekly Silicon summary, product news. "Requests from Silicons" is always on. |
| 2 | Download your data | Data & privacy | Start an export (profile, sign-ins, Silicons, activity) and fetch it when ready. |
| 3 | A Silicon's activity | Silicon › Activity tab | `me.silicons.history(uuid)`, the same shape as `me.history`, for the custodian. |
| 4 | Apps a Silicon may use | Silicon › Access; app page "Who uses it"; Home and app tiles ("You + 2") | Per-Silicon allow-list per app (off / allowed / signed in), with list and set; the apps a Silicon has signed into. |
| 5 | Silicon sign-in stats | Silicon header stats, Silicon tiles | Last sign-in time and sign-ins per day for the last 14 days. |
| 6 | Wrong keys tried | Needs you, Security checkup, Silicon status | An alert when a Silicon's STK fails repeatedly (count, last time, where), and a way to dismiss it. |
| 7 | Automation (GitHub trust) | Silicon › Access | Trusted repositories (provider, repo, optional branch) that may sign in as the Silicon without an STK: list, add, remove. |
| 8 | Cloud services (audiences) | Silicon › Access | Allowed token audiences per Silicon: list, add, remove. |
| 9 | What an app can see, per field | App page | Today it comes from granted scopes and can't be changed. Needed: turn an optional field off for one app without removing the app. |
| 10 | Carbon pixel avatars | Every app, Personal info › Photo | Iris draws today's default photo (`/pfp/carbon`); it should draw the pixel avatar (lib/pixel-avatar.ts) from the uuid, so every app shows it by default. And a way to store a Carbon's avatar look (hair, face, clothing) on the account, so the editor opens on it on any device; today the site keeps it in the browser beside the uploaded photo. |

Already supported, so not gaps: date of birth and timezone (`me.update`), custodian requests and handover, STK
rotation, webhooks, proofs, sessions, history by kind.
