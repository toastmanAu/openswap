# Independent-review candidates

Researched 2026-09-18. These are candidates to qualify, not engaged reviewers or
endorsements. No outreach has been sent and no price or availability is known.

| Candidate | Primary evidence of relevant past work | Qualification needed |
|---|---|---|
| Least Authority | [Nervos Blockchain final audit, 18 October 2019](https://leastauthority.com/static/publications/LeastAuthority-Nervos-Network-Audit-Report.pdf); [security consulting service](https://leastauthority.com/security-consulting/) | Ask for named reviewers with current Rust, CKB-VM/Data1, xUDT and transaction-composition experience. Historical network work alone does not establish current lock-contract coverage. |
| CertiK | [Its Nervos audit history](https://skynet.certik.com/projects/nervos) lists a report delivered 7 April 2020 | Confirm the proposed team can review native CKB scripts and wallet/SDK composition, with source-level findings and remediation retests. Do not substitute a project score for a review. |

My suggested first inquiry is Least Authority, based on its published Nervos
report. This is an inference from historical work; obtain a scoped proposal before
choosing. A suitably independent CKB specialist is also an option if they can
provide comparable past reports and reproducible review methods.

## Proposed inquiry scope (draft only)

ToastDEX is a permissionless full-lot DEX on Nervos CKB, currently testnet only.
Its clean-room Rust lock enforces one order input to one maker-payment output at
the same absolute index, with explicit owner-authorized rescue. There is no admin
or upgrade key controlling existing orders.

Please propose a source review of the immutable 28,592-byte Data1 lock plus
critical TypeScript builder, asset-resolution, solver and wallet-signing paths.
The [review brief](EXTERNAL_REVIEW.md), [evidence summary](RELEASE_VALIDATION.md)
and [report template](REVIEW_REPORT_TEMPLATE.md) define the scope and expected
findings. Please identify reviewers, exclusions, schedule, fixed or capped fee,
remediation/retest allowance, and whether the final report can be published.

No contract deployment, wallet secrets or asset transfer is needed to inspect the
source, reproduce the build or run the local VM and deterministic tests.
