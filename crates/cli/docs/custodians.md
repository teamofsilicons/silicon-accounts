# Custodians: being responsible for a Silicon

Every Silicon has exactly one custodian, a Carbon. The custodian manages the Silicon's
account: its details, its si:id and its STK. A custodian can never just walk away: the
only way to stop being one is to transfer the Silicon to another Carbon (or delete it),
which is why a Carbon can't delete their own account while they still hold Silicons.

## Requests waiting for you

```sh
accounts custodian requests
accounts custodian accept <request-id>
accounts custodian decline <request-id>
```

Requests come from Silicons that named you (by c:id or by any verified email of yours)
and from custodians transferring a Silicon to you. They expire after 14 days.

* Accepting a new Silicon's request makes it `active`: it can sign in right away.
* Declining it releases the account; its si:id becomes free immediately.
* Accepting a transfer makes you the custodian; apps the Silicon signed into get
  `silicon.custodian_changed`, and the Silicon gets `silicon.custodian.changed`.
* Declining a transfer changes nothing; the current custodian keeps the Silicon.

## Managing your Silicons

```sh
accounts silicon list
accounts silicon show si:scout
accounts silicon update si:scout --display-name "Scout" --timezone Europe/Berlin
accounts silicon update si:scout --photo ./scout.png    # uploads its photo (≤ 2 MB; it belongs to the Silicon)
accounts id available si:scout --for si:scout_v2  # is an old id of this Silicon free to take back?
accounts silicon id si:scout si:scout_v2          # apps are told; the uuid never changes
accounts silicon rotate-stk si:scout              # prints the new STK once
accounts silicon webhook set si:scout https://scout.example/hooks
accounts silicon transfer si:scout --to c:shubham
accounts silicon cancel-transfer si:scout
accounts silicon delete si:scout --confirm si:scout
```

Commands accept the si:id or the uuid.

### Rotating the STK

Rotate when an STK may have leaked, when a Silicon changes hands, or on a schedule.
The old STK dies immediately and all of the Silicon's sessions are revoked, including
the tokens apps hold (they receive `membership.signed_out` with reason `stk_rotated`).
Hand the new STK to the Silicon privately; it signs in again with it.

### Transferring

`transfer` asks another Carbon (`c:id` or email) to become the custodian. Nothing
changes until they accept within 14 days, and only one transfer can be pending at a
time. Every transfer is kept in the Silicon's history (from, to, when).

### Deleting

Deleting a Silicon is permanent. Apps it signed into get `account.deleted`, its
sessions and proofs are revoked, and its si:id is held for 10 days before anyone else
can take it.

## Creating a Silicon yourself

```sh
accounts silicon create --id si:scout --display-name Scout
```

You become its custodian at once. The STK is printed exactly once; only its hash is
stored, so if it's lost, rotate it.
