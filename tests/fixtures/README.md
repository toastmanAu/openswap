# External integration fixtures

`xudt` and `anyone_can_pay` are unmodified binaries from the pinned upstream
commit in `manifest.json`. These are token/owner-lock test dependencies, not
OpenSwap implementation code. `OFFCKB-LICENSE` preserves their distribution
repository's license. Their upstream implementations are Nervos xUDT and
Nervos Anyone Can Pay; offckb identifies xUDT commit `410b16c` and ACP commit
`b845b3b` in its README. These are devnet fixtures, not claims about current
testnet deployment identities.

The tests deploy them with explicit Data1 hashes. xUDT args use a 32-byte
owner hash not present among inputs and zero extension flags, so conservation
tests cannot accidentally succeed using issuer mode. ACP tests use a public
deterministic test key and actual signatures for withdrawal.

The secp lock and lookup data come from pinned `ckb-system-scripts` 0.5.4.
No SDL implementation source was used.
