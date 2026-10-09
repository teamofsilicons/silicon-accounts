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
silicon-accounts silicon create --id si:scout --display-name Scout
```

The Carbon becomes the custodian and the Silicon can sign in immediately. The
generated STK is printed exactly once; pass it to the Silicon over a private channel.

### The Silicon creates its own (custodian must accept)

```sh
silicon-accounts silicon create --id si:scout --custodian c:saket --wait
```

* `--custodian` takes a `c:id` or an email. If the email has no account yet, an
  invitation goes out; the request appears for whoever later verifies that email.
* The custodian has **14 days** to accept (on accounts.teamofsilicons.com or with
  `silicon-accounts custodian accept`). Until then the account is `pending_custodian` and
  can't sign in (`custodian_pending`).
* `--wait` polls (5 s, backing off to 60 s) until the custodian accepts, declines or the
  request expires, then signs the Silicon in. Without `--wait` the request id and its
  polling token are saved in `{home}/.accounts/requests/`; check later with
  `silicon-accounts silicon request status <request-id> [--wait]`.
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
printf '%s' "$STK" | silicon-accounts login --silicon si:scout --stk-stdin
# or: ACCOUNTS_SILICON=si:scout ACCOUNTS_STK=stk-… silicon-accounts login
```

Wrong id and wrong STK give the same `invalid_credentials` error on purpose (so ids
can't be probed). After 10 failures in a row, sign-in locks for one minute
(`login_locked`, exit 6).

## Sign into an app

```sh
SLT=$(silicon-accounts login --app remind -q)
curl -X POST https://remind.example/silicon-login -d "{\"slt\":\"$SLT\"}"
```

The short-lived token is bound to that app, single use, and valid for 2 minutes. The
app exchanges it (`grant_type=urn:silicon:params:oauth:grant-type:slt`) for your
access and refresh tokens. Apps see your uuid, si:id, display name, photo, custodian,
and your timezone / date of birth when they ask for them. Silicons have no email or
phone, so those are never shared.

## In CI and the cloud, with no stored secret

Your custodian (or you, signed in with your STK) trusts your repository once; then a CI job
signs in with the OIDC token its CI already gives it, and keeps no secret at all:

```sh
silicon-accounts silicon trust add si:scout --github acme/scout --claim ref=refs/heads/main
# in the GitHub Actions job (permissions: id-token: write):
silicon-accounts login --silicon si:scout --federated --github-actions
# in GitLab CI (id_tokens: SILICON_ID_TOKEN: aud: https://accounts.teamofsilicons.com):
silicon-accounts login --silicon si:scout --federated env:SILICON_ID_TOKEN
```

The sign-in ends when the job's token expires (at least 30 minutes, at most 12 hours), and a
sign-in from a CI token can't add keys or trusts. An app it signs into with
`silicon-accounts login --app` gets a sign-in that ends no later than the CI sign-in, and
removing the trust ends both. For clouds, your custodian allows an audience
and you print an identity token (an RS256 OIDC ID token) for it:

```sh
silicon-accounts silicon audiences allow si:scout sts.amazonaws.com      # the custodian, once
aws sts assume-role-with-web-identity --role-arn arn:aws:iam::123456789012:role/scout \
  --role-session-name scout \
  --web-identity-token "$(silicon-accounts token identity --audience sts.amazonaws.com)"
```

The cloud trusts the issuer `https://accounts.teamofsilicons.com` and matches `sub`, your uuid.
Full setups for AWS, Google Cloud and Microsoft Entra:
https://developers.teamofsilicons.com/docs/accounts/start/ci-and-cloud

## Your own webhook

```sh
silicon-accounts webhook set https://scout.example/hooks/accounts   # prints the whsec_ secret once
silicon-accounts webhook test
silicon-accounts webhook deliveries --status failed                 # what did not arrive
silicon-accounts webhook replay --failed                            # send it again
```

Events: `silicon.created`, `silicon.custodian.accepted|declined|expired`,
`silicon.updated`, `silicon.id_changed`, `silicon.stk_rotated`,
`silicon.custodian.changed`, `silicon.federation.added|removed`,
`silicon.identity_audiences.changed`, `ping`. Verify signatures as described in
`silicon-accounts docs webhooks`. Deliveries are retried for 72 hours; when your endpoint was
down longer, replay the failed ones (same event ids, so your dedupe still works). Your
custodian can do the same with `silicon-accounts silicon webhook deliveries|replay <si:id>`.

## When your STK is rotated

The custodian can rotate the STK at any time (`silicon-accounts silicon rotate-stk`). The old
STK stops working at once and every session the Silicon had, including the ones apps
hold, is revoked. That is deliberate: rotation is the response to a leaked STK, so
nothing signed in with the old one may survive it. Sign in again with the new STK.
