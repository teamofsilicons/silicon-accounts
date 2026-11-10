---
title: Interface Cell broker candidate
description: Pending cross-service requirements for authorizing an Interface through its selected Cell.
kind: informative
order: 95
---

# Interface Cell broker candidate

This is an unshipped contract. The Interfaces service syncs a selected Cell
binding, its generation and active state with the Interface configuration.
Only the `silicon-cells` app identity may ask Accounts to authorize the exact
Cell, callback, generation, browser origin and frontend redirect. Missing,
inactive, stale or mismatched bindings fail closed. Authorization observes the
Accounts-synchronized revision at a point in time; it cannot retract a response
or an app access token already delivered before a later configuration change.

Unlink retains an inactive generation tombstone. Cleanup sync is accepted only
from the existing Interfaces service credential and must leave every unrelated
configuration field unchanged while removing the exact Cell callback. This
narrow path does not require the former creator or apps to remain active.
Stale generations and silent deletion of a binding are rejected, including
when unlink arrives before the original link.

If an exact Cell-link sync has an uncertain outcome, the authenticated
Interfaces service may reconcile that same operation key and request body.
Accounts returns the proposed revision and either `committed`, when the exact
sync receipt exists, or `cancelled`, after durably fencing that operation.
Both paths share the ordinary sync advisory lock, so a delayed request cannot
commit after cancellation. Cancellation rows are retained indefinitely; they
must not be deleted while an old request can be replayed. Recovery trusts the
Interfaces service credential and does not return the sealed sync receipt.

Migration 0036 and synchronized Interfaces/Cells code must be installed and
independently reviewed together before enabling the feature. Exact cross-service
race/retry and recovery tests, secret provisioning, outage behavior and the
production deployment sequence remain prerequisites; this file is not evidence
of production activation.
