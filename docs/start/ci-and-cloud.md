---
title: Run a Silicon in CI and the cloud with no stored secret
description: Let a CI job sign in as your Silicon with the OIDC token its CI already gives it, and let the Silicon prove itself to AWS, Google Cloud and Microsoft Entra. No STK, key or cloud secret is stored anywhere.
kind: instructive
order: 24
related:
  - learn/silicons-and-custodians.md
  - learn/security.md
  - reference/api/silicons.md
  - reference/api/oauth.md
  - reference/cli.md
  - start/silicon-account.md
---

# Run a Silicon in CI and the cloud with no stored secret

You as a Silicon can run in a CI job without any stored secret. Your custodian trusts your repository once. After that, the job hands us the OIDC token its CI already gives it, and we sign you in. Once you're signed in, you can also get identity tokens that AWS, Google Cloud and Microsoft Entra accept in place of cloud keys.

So nothing secret lives in your CI settings: no STK, no private key, no cloud access key. Here is the whole thing in a GitHub Actions job:

```sh
silicon-accounts login --silicon si:scout --federated --github-actions   # the job's own token signs you in
silicon-accounts login --app remind -q                                   # a short-lived token for an app, as usual
silicon-accounts token identity --audience sts.amazonaws.com             # a token AWS trusts
```

It works in two directions:

```text
into Silicon Accounts                           out to a cloud
CI job ── its OIDC token ──▶ Silicon Accounts   Silicon ── access token ──▶ Silicon Accounts
           (a trust your custodian set up)                 (an audience your custodian allowed)
       ◀── si:scout's tokens ──                         ◀── identity token (RS256 JWT) ──
                                                Silicon ── identity token ──▶ AWS / Google Cloud / Entra
```

Both directions are standard. The way in is RFC 8693 token exchange, the same way npm and PyPI
trusted publishers and the cloud providers take a CI job's token. The way out is an OpenID Connect
ID token, which every cloud's workload identity federation reads.

## 1. Trust your repository (once, as the custodian)

Your custodian (or you, signed in with your STK or a key) adds a **trust relationship**: tokens
from this issuer, carrying this audience, whose claims have exactly these values, may sign you in.
For a GitHub repository:

```sh
silicon-accounts silicon trust add si:scout --github acme/scout --claim ref=refs/heads/main --name deploys
```

```text
si:scout now trusts tokens from https://token.actions.githubusercontent.com for the audience https://accounts.teamofsilicons.com when ref=refs/heads/main, repository=acme/scout (01a11f12-acbc-776e-bfee-b26bd64e2d7a).

Next:
  silicon-accounts login --silicon si:scout --federated --github-actions  sign in from the CI job
```

`--github acme/scout` sets the issuer to `https://token.actions.githubusercontent.com` and the
condition `repository=acme/scout`. Every `--claim` adds a condition, and a token must match all of
them. Good conditions for GitHub Actions:

| Condition | What it pins |
|---|---|
| `repository=acme/scout` | the repository (always include this, or `repository_id`) |
| `ref=refs/heads/main` | the branch or tag that ran the job |
| `environment=production` | a GitHub environment, with its own reviewers and branch rules |
| `job_workflow_ref=acme/ci/.github/workflows/deploy.yml@refs/heads/main` | one reusable workflow |
| `sub=repo:acme/scout:environment:production` | GitHub's combined subject, if you prefer one condition |

We refuse a GitHub or GitLab trust that doesn't name the repository, the project or their owner,
because every job on the platform can get a token from the same issuer. A trust with only
`ref=refs/heads/main` would let anyone's `main` branch sign in as you.

Over HTTP it is one call, with the custodian's (or the Silicon's) access token:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/silicons/si:scout/federations" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"issuer":"https://token.actions.githubusercontent.com","conditions":{"repository":"acme/scout","ref":"refs/heads/main"},"name":"deploys"}'
```

List and remove trusts with `silicon-accounts silicon trust list si:scout` and
`silicon-accounts silicon trust remove si:scout <trust id>`. Removing a trust ends every sign-in it
started at once: the CI sign-ins, and the app sign-ins made with their short-lived tokens
([see below](#what-an-app-sign-in-from-ci-lasts)).

## 2. Sign in from GitHub Actions

Give the job permission to ask GitHub for its OIDC token (`id-token: write`), install the CLI, and
sign in with `--federated --github-actions`:

```yaml
name: deploy
on:
  push:
    branches: [main]

permissions:
  id-token: write   # lets the job ask GitHub for its OIDC token
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install silicon-accounts
        run: |
          curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh
          bash install-apps.sh --server https://apps.teamofsilicons.com
          echo "$HOME/.apps/bin" >> "$GITHUB_PATH"
          "$HOME/.apps/bin/silicon-apps" --home "$HOME" --server https://apps.teamofsilicons.com install silicon-accounts

      - name: Sign in as si:scout
        run: silicon-accounts login --silicon si:scout --federated --github-actions

      - name: Work as si:scout
        run: |
          silicon-accounts whoami
          SLT=$(silicon-accounts login --app remind -q)
          curl -s -X POST https://remind.example/silicon-login -H 'Content-Type: application/json' -d "{\"slt\":\"$SLT\"}"
```

```text
Signed in as si:scout (Scout), a Silicon.
uuid          b97
url           https://accounts.teamofsilicons.com
access token  2026-10-09T05:46:35Z (in 30m) (refreshed automatically)
session ends  2026-10-09T05:46:35Z (in 30m)
```

What happens: the CLI asks GitHub for the job's token with the audience
`https://accounts.teamofsilicons.com` (the default audience of a trust; pass `--audience` if your
trust names another), and exchanges it at our token endpoint. We check the token's signature
against GitHub's published keys, its issuer, audience, times and every condition of your trust,
and that it was never used before. Then you're signed in as yourself, with the same session and
the same powers as after `silicon-accounts login --silicon si:scout --stk-stdin`, with two
differences:

- **It ends with the job's token.** The sign-in ends when the CI token it was made from would
  have expired, but never sooner than 30 minutes (one access token) and never later than 12 hours.
  Refreshing works as usual until then. A GitHub token lives only minutes, so a GitHub sign-in
  lasts 30 minutes, and when it runs out the CLI asks GitHub for a fresh token and signs in again
  on its own. A GitLab token lives as long as the job, so the sign-in does too, up to 12 hours.
  An app you sign in to from the job is signed in no longer than that
  ([below](#what-an-app-sign-in-from-ci-lasts)).
- **It can't add a way in.** A sign-in from a CI token can't add keys or trusts (403
  `federated_session`). A job may act as you, but it can never decide who else can.

Your custodian's [app allow-list](custodians.md) still decides which apps you get short-lived
tokens for, and every sign-in is in your sign-in history with the method `federated`.

The same exchange over HTTP, if you'd rather not install the CLI in the job:

```sh
CI_TOKEN=$(curl -s -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://accounts.teamofsilicons.com" | jq -r .value)

curl -s -X POST https://accounts.teamofsilicons.com/v1/oauth/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token="$CI_TOKEN" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:jwt \
  -d silicon=si:scout
```

The answer is a normal [token response](../reference/api/oauth.md#the-token-response) with
`issued_token_type: urn:ietf:params:oauth:token-type:access_token`, and a
`refresh_token_expires_at` that says when the sign-in ends.

### What an app sign-in from CI lasts

A short-lived token you get during the job (`silicon-accounts login --app remind`) signs you in to
the app, and that sign-in belongs to the job's:

- **It ends when the CI sign-in ends.** The app's sign-in ends at the same moment as the sign-in
  the job made from its CI token (the token response's `refresh_token_expires_at` says when), and
  refreshing never moves that end. Its access tokens stop then too: near the end, an access
  token's `exp` is the end of the sign-in, not 30 minutes later, so an app that checks access
  tokens locally against our keys stops accepting them at the same moment as introspection does.
  A short-lived token exchanged after the end the CI sign-in was given is refused (`invalid_grant`).
- **Removing the trust ends it.** When the trust is removed, the app sign-ins made with its
  short-lived tokens end with the CI sign-ins, and each app gets `membership.signed_out` with the
  reason `session_revoked` (its next refresh says `federation_removed`). Your webhook's
  `silicon.federation.removed` counts both kinds in `ended_sessions`. A short-lived token minted
  under the trust and not yet exchanged is refused.
- **Signing out doesn't end it.** Ending the CI sign-in any other way (`silicon-accounts logout` in
  the job, or `silicon-accounts sessions revoke`) leaves the app sign-ins made from it running until the moment
  the CI sign-in would have ended. It doesn't refuse a short-lived token the CI sign-in already
  minted either: that token still works until it expires, within 2 minutes. To end the app
  sign-ins early, remove the trust, or have the app revoke them.

A short-lived token from any other sign-in (your STK, one of your keys) starts an ordinary app
sign-in of up to 900 days.

**App sign-ins made before this rule.** We enforce these rules on our side, for app sign-ins made
after the 9 October 2026 API release, whichever CLI you run. An app sign-in made from a CI job's
short-lived token before that release isn't covered. It keeps the
end it was given, up to 900 days from that sign-in, and removing the trust doesn't end it: a
short-lived token didn't yet record which sign-in minted it, so nothing tells such an app sign-in
apart from your other sign-ins to the same app, and none can be found after the fact. To end one,
remove your access to the app (`silicon-accounts apps remove remind`; a later short-lived token
signs you in again), have your custodian rotate your STK (which ends every sign-in you have, at
every app), or have the app revoke its refresh token with `POST /v1/oauth/revoke`.

## 3. Sign in from GitLab CI

GitLab gives a job an ID token through `id_tokens`, with the audience you name. Trust the
project:

```sh
silicon-accounts silicon trust add si:scout --gitlab acme/scout --claim ref_type=branch --claim ref=main
```

Then ask for a token with our audience and sign in with it:

```yaml
deploy:
  image: ubuntu:24.04
  id_tokens:
    SILICON_ID_TOKEN:
      aud: https://accounts.teamofsilicons.com
  script:
    - apt-get update -qq && apt-get install -y -qq curl ca-certificates
    - curl -fsSL https://apps.teamofsilicons.com/install.sh -o install-apps.sh
    - bash install-apps.sh --server https://apps.teamofsilicons.com
    - export PATH="$HOME/.apps/bin:$PATH"
    - silicon-apps --home "$HOME" --server https://apps.teamofsilicons.com install silicon-accounts
    - silicon-accounts login --silicon si:scout --federated env:SILICON_ID_TOKEN
    - silicon-accounts whoami
```

Your sign-in lasts as long as the job's ID token, as [described above](#2-sign-in-from-github-actions).
Self-managed GitLab works the same with `--issuer https://gitlab.example.com` and
`--claim project_path=acme/scout`.

## 4. Any other OIDC issuer

Any issuer works if it serves OpenID Connect discovery (`/.well-known/openid-configuration`) and
its keys over https from a public address, and signs with RS256, RS384, RS512, PS256, PS384,
PS512, ES256, ES384 or EdDSA: Buildkite, CircleCI, a Kubernetes cluster with a public issuer, your
own. Name it and at least one condition:

```sh
silicon-accounts silicon trust add si:scout --issuer https://oidc.circleci.com/org/8c8a6f63-ab0b-4a12-a3b1-08e7a5b5a9f2 \
  --audience https://accounts.teamofsilicons.com --claim oidc.circleci.com/project-id=4f7b8a1e-6c3d-4e2a-9b5f-1d0c7e8a2b6f
```

Then hand the token to the CLI as the value itself, a file (`--federated @/var/run/secrets/token`,
read again for every new sign-in, which suits a Kubernetes projected token) or a variable
(`--federated env:NAME`).

## 5. Get identity tokens for the cloud

Your custodian decides which outside services you may get identity tokens for. Until they allow
one, you get none, so nothing changes for a Silicon whose custodian hasn't opted in:

```sh
silicon-accounts silicon audiences allow si:scout sts.amazonaws.com api://AzureADTokenExchange
```

```text
si:scout may get identity tokens for: sts.amazonaws.com, api://AzureADTokenExchange.
```

Then you, signed in (from CI or anywhere else), ask for one. The token alone goes to stdout:

```sh
silicon-accounts token identity --audience sts.amazonaws.com
```

```text
eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImtpZCI6Imp0eWc5Q3h4d2ZZN1l4WU85R2o2OFJmQlgtNm91S1g4ODJOTkdIQXZNY2sifQ.eyJpc3MiOi…
```

It is an RS256 OpenID Connect ID token, signed with a key in our
[JWKS](https://accounts.teamofsilicons.com/.well-known/jwks.json), and it lives 300 seconds unless
you pass `--ttl` (60 to 3600). Its claims:

```json
{
  "iss": "https://accounts.teamofsilicons.com",
  "sub": "b97",
  "aud": "sts.amazonaws.com",
  "iat": 1791522701,
  "nbf": 1791522701,
  "exp": 1791523001,
  "jti": "01a11f13-013f-7050-b4c5-acd4ef2eea84",
  "kind": "silicon",
  "si_id": "si:scout",
  "custodian": "zQo",
  "token_use": "identity"
}
```

`sub` is your uuid. It never changes, so the cloud should match on it, never on `si_id`, which
can. `custodian` is your custodian's uuid. Over HTTP:

```sh
curl -s -X POST "$ACCOUNTS_URL/v1/me/identity-tokens" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"audience":"sts.amazonaws.com","ttl_seconds":900}'
```

Find your uuid with `silicon-accounts whoami --json | jq -r .uuid`. The cloud setups below use it
as `SILICON_UUID`.

### AWS

Create an IAM OIDC provider for our issuer once per AWS account, with `sts.amazonaws.com` as its
audience. AWS reads our discovery document and keys from there:

```sh
aws iam create-open-id-connect-provider \
  --url https://accounts.teamofsilicons.com \
  --client-id-list sts.amazonaws.com
```

Give the role a trust policy that names your Silicon by uuid:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/accounts.teamofsilicons.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "accounts.teamofsilicons.com:aud": "sts.amazonaws.com",
          "accounts.teamofsilicons.com:sub": "SILICON_UUID"
        }
      }
    }
  ]
}
```

Then assume the role with an identity token:

```sh
aws sts assume-role-with-web-identity \
  --role-arn arn:aws:iam::123456789012:role/scout-deploy \
  --role-session-name scout \
  --web-identity-token "$(silicon-accounts token identity --audience sts.amazonaws.com)"
```

Or let the AWS CLI and SDKs do it: write the token to a file and point them at it. They assume the
role on their own; write a fresh token into the file before the old one expires:

```sh
silicon-accounts token identity --audience sts.amazonaws.com --ttl 3600 > "$RUNNER_TEMP/aws-token"
export AWS_ROLE_ARN=arn:aws:iam::123456789012:role/scout-deploy
export AWS_WEB_IDENTITY_TOKEN_FILE="$RUNNER_TEMP/aws-token"
aws s3 ls s3://scout-artifacts
```

### Google Cloud

Create a workload identity pool and an OIDC provider for our issuer, and map the subject:

```sh
gcloud iam workload-identity-pools create silicons --location=global

gcloud iam workload-identity-pools providers create-oidc accounts \
  --location=global --workload-identity-pool=silicons \
  --issuer-uri=https://accounts.teamofsilicons.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.custodian=assertion.custodian" \
  --attribute-condition="assertion.token_use == 'identity'"
```

The provider's default audience is its own URL. Ask your custodian to allow it:

```sh
silicon-accounts silicon audiences allow si:scout \
  https://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/silicons/providers/accounts
```

Grant your Silicon a role, by uuid:

```sh
gcloud projects add-iam-policy-binding PROJECT_ID --role=roles/storage.objectViewer \
  --member="principal://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/silicons/subject/SILICON_UUID"
```

Then make a credential file that reads the token from a file, and keep that file fresh:

```sh
gcloud iam workload-identity-pools create-cred-config \
  projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/silicons/providers/accounts \
  --credential-source-file="$RUNNER_TEMP/gcp-token" --output-file=gcp-credentials.json

silicon-accounts token identity --ttl 3600 \
  --audience https://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/silicons/providers/accounts \
  > "$RUNNER_TEMP/gcp-token"
export GOOGLE_APPLICATION_CREDENTIALS="$PWD/gcp-credentials.json"
gcloud storage ls gs://scout-artifacts
```

### Microsoft Entra

Add a federated credential to an app registration (or a user-assigned managed identity) that
names our issuer, your uuid as the subject and Entra's audience:

```sh
az ad app federated-credential create --id APP_OBJECT_ID --parameters '{
  "name": "si-scout",
  "issuer": "https://accounts.teamofsilicons.com",
  "subject": "SILICON_UUID",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

Then sign in with an identity token for that audience:

```sh
az login --service-principal -u APP_CLIENT_ID -t TENANT_ID \
  --federated-token "$(silicon-accounts token identity --audience api://AzureADTokenExchange)"
```

Entra validates RS256 tokens, which is why identity tokens are RS256 rather than the EdDSA our
access tokens use.

## When something is refused

| Code | Where | What to do |
|---|---|---|
| `no_matching_trust` | the exchange (`invalid_grant`) | the issuer, audience or a claim differs from every trust; the description names which claim and the token's value. Check `silicon-accounts silicon trust list si:scout` |
| `invalid_federated_token` | the exchange (`invalid_grant`) | the token expired, was used before, names an unknown key or doesn't verify. Get a fresh one from the CI |
| `issuer_unavailable` | the exchange (`invalid_grant`) | we couldn't read the issuer's keys; retry |
| `issuer_unreachable` | adding a trust (422) | the issuer has no discovery document we can read over https from a public address |
| `federated_session` | adding a key or trust (403) | a CI sign-in can't add a way in; do it as the custodian |
| `audience_not_allowed` | an identity token (403) | ask your custodian: `silicon-accounts silicon audiences allow si:scout <audience>` |
| `identity_token_not_accepted` | any API call (401) | you sent an identity token as a bearer token; send your access token |

[Silicons and custodians](../learn/silicons-and-custodians.md#why-a-ci-job-can-sign-in-without-a-secret)
explains why each of these rules exists, and [Security](../learn/security.md#trusted-issuers-and-identity-tokens)
how the keys and fetches are protected.
