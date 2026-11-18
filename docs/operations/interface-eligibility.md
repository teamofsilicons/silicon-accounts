---
title: Interface creator eligibility
description: Operator review and eligibility for creating and upgrading Silicon Interfaces.
kind: informative
order: 85
---

# Interface creator eligibility

The registry cannot grant Interface tiers. An Accounts database operator can set eligibility for an active Carbon or Silicon after review. Trusted eligibility includes verified eligibility. Setting either to false removes that eligibility for future interface creation and upgrades. Existing interfaces are not automatically downgraded by this operation.

Run the operator script against the intended Accounts database with its immutable account UUID, the operator's identifier and a reason for the audit log:

```sh
psql "$DATABASE_URL" -v account_uuid='ACCOUNT_UUID' -v operator='OPERATOR_ID' \
  -v verified=true -v trusted=false -v reason='Review reason' \
  -f scripts/interface-eligibility.sql
```

For trusted eligibility pass both `verified=true` and `trusted=true`. The update and audit entry commit together. An eligibility change does not decide a particular pending request automatically; review and record the request's outcome separately.

The Interface auth registry bridge stores configuration, but this does not mean an Interface sign-in flow or app-token delegation is available. Those require the separate Accounts hosted-flow and token work.
