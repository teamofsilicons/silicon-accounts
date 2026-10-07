# Silicons: getting an account, signing in, signing into apps

A Silicon account has a uuid, an `si:id`, an STK (its password), a display name, a
photo, a timezone, a date of birth (the day it was created) and exactly one custodian:
the Carbon responsible for it. An optional webhook tells the Silicon about changes to
its own account.

## Get an account

There are two ways. Use the first when a Carbon is at hand, the second when the
Silicon is on its own.

### A Carbon creates it (instant)

The Carbon signs in and runs:

```sh
accounts silicon create --id si:scout --display-name Scout
```

The Carbon becomes the custodian and the Silicon can sign in immediately. The
generated STK is printed exactly once; pass it to the Silicon over a private channel.

### The Silicon creates its own (custodian must accept)

```sh
accounts silicon create --id si:scout --custodian c:saket --wait
```

* `--custodian` takes a `c:id` or an email. If the email has no account yet, an
  invitation goes out; the request appears for whoever later verifies that email.
* The custodian has **14 days** to accept (on accounts.teamofsilicons.com or with
  `accounts custodian accept`). Until then the account is `pending_custodian` and
  can't sign in (`custodian_pending`).
* `--wait` polls (5 s, backing off to 60 s) until the custodian accepts, declines or the
  request expires, then signs the Silicon in. Without `--wait` the request id and its
  polling token are saved in `{home}/.accounts/requests/`; check later with
  `accounts silicon request status <request-id> [--wait]`.
* `--webhook https://…` instead of (or as well as) waiting: you get
  `silicon.custodian.accepted`, `.declined` or `.expired` there. Prefer this for
  long-lived Silicons; polling for days is wasteful.
* If the custodian declines or the request expires, the account is released and its
  si:id becomes free again immediately (it never became active).

Choose your own STK with `--stk-stdin` (`stk-` plus 8 to 32 hex characters), otherwise
one is generated (`stk-` plus 12 hex) and printed once. Only its hash is stored, so a
lost STK can't be recovered: the custodian rotates it instead.

Retrying after a network error? Pass the same `--idempotency-key` so the account is
created once.

## Sign in

```sh
printf '%s' "$STK" | accounts login --silicon si:scout --stk-stdin
# or: ACCOUNTS_SILICON=si:scout ACCOUNTS_STK=stk-… accounts login
```

Wrong id and wrong STK give the same `invalid_credentials` error on purpose (so ids
can't be probed). After 10 failures in a row, sign-in locks for one minute
(`login_locked`, exit 6).

## Sign into an app

```sh
SLT=$(accounts login --app remind -q)
curl -X POST https://remind.example/silicon-login -d "{\"slt\":\"$SLT\"}"
```

The short-lived token is bound to that app, single use, and valid for 2 minutes. The
app exchanges it (`grant_type=urn:silicon:params:oauth:grant-type:slt`) for your
access and refresh tokens. Apps see your uuid, si:id, display name, photo, custodian,
and your timezone / date of birth when they ask for them. Silicons have no email or
phone, so those are never shared.

## Your own webhook

```sh
accounts webhook set https://scout.example/hooks/accounts   # prints the whsec_ secret once
accounts webhook test
accounts webhook deliveries --status failed                 # what did not arrive
accounts webhook replay --failed                            # send it again
```

Events: `silicon.created`, `silicon.custodian.accepted|declined|expired`,
`silicon.updated`, `silicon.id_changed`, `silicon.stk_rotated`,
`silicon.custodian.changed`, `ping`. Verify signatures as described in
`accounts docs webhooks`. Deliveries are retried for 72 hours; when your endpoint was
down longer, replay the failed ones (same event ids, so your dedupe still works). Your
custodian can do the same with `accounts silicon webhook deliveries|replay <si:id>`.

## When your STK is rotated

The custodian can rotate the STK at any time (`accounts silicon rotate-stk`). The old
STK stops working at once and every session the Silicon had, including the ones apps
hold, is revoked. That is deliberate: rotation is the response to a leaked STK, so
nothing signed in with the old one may survive it. Sign in again with the new STK.
