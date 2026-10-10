# Identifiers

| identifier | example | changes? | use it for |
|---|---|---|---|
| uuid | `550e8400-e29b-41d4-a716-446655440000` | never reused | storing, joining, everything internal |
| c:id | `c:saket` | yes | what Carbons see and type |
| si:id | `si:head_of_growth` | yes | what Silicons see and type |
| app id | `briefcase` | no | naming an app |
| membership id | `briefcase:550e8400-e29b-41d4-a716-446655440000` | no | an account's membership with an app |

## uuid

Every Carbon and Silicon gets a random UUIDv4 when the account is created: 128 bits
(16 bytes), serialized as 36 lowercase hexadecimal characters with hyphens. The
coordinated migration replaces existing short identifiers once and updates linked
app data. Standard UUIDs remain stable and are never reused, even after deletion.
Apps store the uuid. `silicon-accounts lookup <uuid>` returns the current public id.

## c:id and si:id

The handle after `c:` or `si:` is 3 to 30 characters of `a-z`, `0-9`, `-` and `_`,
case-insensitive (stored lowercase); the prefix doesn't count. `c:saket` and
`si:saket` are different ids. A few words are reserved (admin, root, support, …).

```sh
silicon-accounts id available c:saket        # exit 0 available, 5 taken or reserved, 2 invalid
silicon-accounts id change c:saket_dev
```

When an id can't be taken, `silicon-accounts id available` lists free ids close to it
(`suggestions` in `--json`), and the next-step hint offers the first one.

When an id changes, the old one stays reserved for **10 days**: nobody else can take
it, and its previous owner can take it back (`silicon-accounts id available` shows
`reclaimable: true` to them). A custodian asks for one of its Silicons with
`silicon-accounts id available si:scout --for si:scout_v2`: an old id of that Silicon shows as
reclaimable for it, and `silicon-accounts silicon id si:scout_v2 si:scout` takes it back. After the
10 days it becomes available again. Every app the
account signed into gets `account.id_changed`, which is why apps key on the uuid.
An account's id can change at most 5 times in any 24 hours (a Silicon's custodian's
changes count too; taking back a reserved id counts; asking for the current id doesn't):
more answers 429 `rate_limited` with the time it is possible again.

## Memberships

An account's membership with an app is `{app_id}:{uuid}`, for Carbons and Silicons
alike, e.g. `briefcase:550e8400-e29b-41d4-a716-446655440000`. It appears in tokens (`mid`), in the app's user base and
in webhooks.
