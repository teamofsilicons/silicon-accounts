# Identifiers

| identifier | example | changes? | use it for |
|---|---|---|---|
| uuid | `a8K` | never, never reused | storing, joining, everything internal |
| c:id | `c:saket` | yes | what Carbons see and type |
| si:id | `si:head_of_growth` | yes | what Silicons see and type |
| app id | `briefcase` | no | naming an app |
| membership id | `briefcase:a8K` | no | an account's membership with an app |

## uuid

Every Carbon and Silicon gets a uuid when the account is created. It is made of
`a-z`, `A-Z` and `0-9` (case-sensitive), starts at 3 characters and grows to 4 once
every 3-character uuid is used, and so on. It never changes and is never reused, even
after the account is deleted. Apps must store the uuid: it is the only thing that
stays the same. `accounts lookup <uuid>` always returns the current id.

## c:id and si:id

The handle after `c:` or `si:` is 3 to 30 characters of `a-z`, `0-9`, `-` and `_`,
case-insensitive (stored lowercase); the prefix doesn't count. `c:saket` and
`si:saket` are different ids. A few words are reserved (admin, root, support, …).

```sh
accounts id available c:saket        # exit 0 available, 5 taken or reserved, 2 invalid
accounts id change c:saket_dev
```

When an id can't be taken, `accounts id available` lists free ids close to it
(`suggestions` in `--json`), and the next-step hint offers the first one.

When an id changes, the old one stays reserved for **10 days**: nobody else can take
it, and its previous owner can take it back (`accounts id available` shows
`reclaimable: true` to them). After that it becomes available again. Every app the
account signed into gets `account.id_changed`, which is why apps key on the uuid.
An account's id can change at most 5 times in any 24 hours (a Silicon's custodian's
changes count too; taking back a reserved id counts; asking for the current id doesn't):
more answers 429 `rate_limited` with the time it is possible again.

## Memberships

An account's membership with an app is `{app_id}:{uuid}`, for Carbons and Silicons
alike, e.g. `briefcase:a8K`. It appears in tokens (`mid`), in the app's user base and
in webhooks.
