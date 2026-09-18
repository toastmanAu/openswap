# Independent security review report

Status: **template only; no review opinion or completion implied**.

## Scope and identity

- Reviewer name/organization and relationship to implementers:
- Review dates:
- Source commit and source archive SHA256:
- Contract SHA256, CKB code hash, byte length and hash type:
- Toolchain and environment:
- Included components (contract, SDK, solver, frontend, asset profiles):
- Excluded components and assumptions:

## Method and evidence

Record actual commands, test results, manual analysis, fuzzing duration/seeds,
transaction hashes where applicable, and independently reproduced binary hashes.
Distinguish original implementation evidence from checks performed by the reviewer.
Use [EXTERNAL_REVIEW.md](EXTERNAL_REVIEW.md) for the priority questions.

## Findings

For each finding record:

- ID, severity and affected component/commit.
- Concrete trigger, required attacker capabilities and impact.
- Minimal reproducible test or transaction and expected/actual result.
- Proposed remediation and any protocol compatibility implications.
- Fix commit and independent retest result, or rationale for accepted risk.

## Release conclusion

- Open findings and limitations:
- Whether the reviewed binary is suitable for the proposed deployment:
- Required follow-up before mainnet:
- Reviewer sign-off and date:

Do not include private keys, passkey exports or recovery phrases in the report.
