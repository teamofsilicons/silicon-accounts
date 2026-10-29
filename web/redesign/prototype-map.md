# Prototype map

How the lead designer's prototype (Silicon Accounts Prototype v7, 2026-10-28) is built on Silicon UI. The prototype
was made to explore the UI without the design system; the site builds its structure, flows and copy, using only Silicon UI
components and tokens. Parts with no API are left out and listed in [api-gaps.md](api-gaps.md).

## Shell
| Prototype | Site | Silicon UI |
|---|---|---|
| Top bar: brand, "Search your account", help, app switcher, avatar menu | `foundation/shell/account-shell.tsx` | SearchField opening CommandPalette; Popover + ButtonLink grid for apps; UserMenu |
| Left section list with counts | new `foundation/shell/sidebar.tsx` | NavList / NavSection / NavItem (experimental, allowed in eslint.config.mjs), Badge for counts |
| Sidebar footer: Developers, Help, Privacy · Terms | same | ButtonLink (ghost) |
| Phone width | same | BottomSheet holds the section list |
| Skeleton while loading | `PageSkeleton` | Skeleton |
| Offline bar | — | Alert (warning) |
| Toasts | existing | ToastStack |

Sections, in order: Home `/`, Silicons `/silicons`, Connected apps `/apps`, Security `/security`, Personal info
`/personal`, Data & privacy `/privacy`. Notifications waits for its API.

## Primitives
| Prototype | Silicon UI / site |
|---|---|
| `.btn`, `.btn.pri`, `.btn.danger`, `.link` | Button (secondary, primary, danger, ghost), ButtonLink |
| `.scard` with `.hd` | foundation `Section` / `SettingsGroup` |
| `srow` (key, value, description, lead, right action, chevron) | foundation `SettingsRow` (Silicon UI has no list row) |
| `.sw` | Switch |
| `.pill` good / need | Badge success / warning |
| `.av`, `.ring`, `.stack` | Avatar, AvatarGroup |
| Silicon avatar (iris gradient + spark) | Avatar on `--silicon-gradient` |
| `.handle` (id with copy) | mono text + CopyButton |
| `.tabs` | Tabs |
| crumb | Breadcrumb |
| modal | Dialog; destructive confirms keep ConfirmMorph / HoldToConfirm |
| 6-digit code | OtpInput |
| `.empty` | EmptyState |
| needs-you block, attention strip | Alert (warning) with actions |
| activity filter chips | ChipGroup |
| stat grid | MetricCard |
| locked "Required" / "Always" | Badge (neutral) with a lucide Lock |

Colour by role: needs you → `--warning`, good → `--success`, danger → `--danger`, page → `--background`, cards →
`--surface`, Silicons → `--silicon-gradient*`. The prototype's beige canvas and blue accent are not used.

## Screens
| Prototype screen | Route | Built from | API |
|---|---|---|---|
| Home: greeting + id, needs you / all set, intro card, Your Silicons (2 + New), Your apps (4) | `/` | `account/home.tsx`, attention strip | `me.get`, `me.silicons.list`, `me.custodianRequests.list`, `me.apps.list` |
| Silicons: New Silicon, Waiting for you, grid | `/silicons` | `silicons.tsx`, `create-silicon.tsx`, `request-deck.tsx` | `me.silicons.*`, `me.custodianRequests.*` |
| Silicon: header (avatar, name, id, status), tabs | `/silicons/[uuid]` | `silicon-drawer.tsx` content | `me.silicons.get` |
| · Access: secret key | tab | `secret-reveal.tsx` | `rotateStk` |
| · Settings: name, id, looked after by (hand over / cancel), delete | tab | drawer parts, `id-field.tsx` | `update`, `changeId`, `transfer`, `cancelTransfer`, `remove` |
| · Webhook (site has it, prototype doesn't) | Access tab | drawer | `setWebhook`, `removeWebhook` |
| Request / handover offer | `/silicons/requests/[id]` | `request-deck.tsx` | `me.custodianRequests.accept/decline` |
| Connected apps list (who uses each) | `/apps` | `apps/apps.tsx` | `me.apps.list` |
| App: open, what it can see, also acts for you, remove | `/apps/[id]` | `apps.tsx`, `acting-for-you.tsx` | `me.apps.*`, `me.proofs.*` |
| Permissions between apps (active, ended) | `/proofs` | `proofs/proofs.tsx` | `me.proofs.*` |
| Security: checkup, Silicon keys, your sign-in (Google, Apple, email code, text code), devices, Activity | `/security` (`/sign-in-methods` redirects) | `sign-in-methods/*`, `security/*` | `me.identities`, `me.emails`, `me.phones`, `me.sessions`, `me.silicons.list` |
| Activity with filters | `/activity` | `activity/*` | `me.history` (kind filter) |
| Personal info: photo, name, public id, date of birth, timezone; emails, phones | `/personal` | identity edit parts, `contact-adder.tsx` | `me.update`, `uploadPhoto`, `changeId`, `emails`, `phones` |
| Data & privacy: what apps see, delete account | `/privacy` (`/settings` redirects) | `settings.tsx` delete flow | `me.apps.list` (scopes), `me.deleteAccount` |
| Sign in, Google chooser, code, welcome, deleted | `/authorize/flow/[id]` steps | `auth/steps/*` | flows (hosted branding stays) |

Not built (no API): Notifications, Download your data, a Silicon's Activity tab, apps a Silicon may use, Automation,
Cloud services, sign-in sparkline, "wrong keys tried". See [api-gaps.md](api-gaps.md).
