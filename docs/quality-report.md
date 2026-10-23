# Quality report

**Score 69/100, grade D** — BELOW the target of 75. Evidence behind the score: 100% of the weighted checks could be measured.

The factory scored its own work from evidence: the sandbox build and test run, requests sent to the running application, the security scan, the QA and review verdicts, and completeness checks on the code. This is a machine-made self-assessment to focus a human review, not a certification.

| Dimension | Weight | Score | | Finding |
|---|---|---|---|---|
| Builds and passes its tests | 25 | 95 | ██████████ | Built and tested in the sandbox after 1 automatic fix round(s). |
| Test coverage of the requirements | 15 | 100 | ██████████ | 61 test case(s) in 6 file(s) for 11 acceptance criteria. |
| Runs and answers requests | 15 | 80 | ████████░░ | Started and answered its health check; the contract listed no read-only endpoint to probe. |
| Security | 15 | 30 | ███░░░░░░░ | Scan: 0 critical, 0 high, 0 medium, 0 low. Security review verdict: fail. |
| Acceptance criteria verified | 15 | 87 | █████████░ | QA verified 13 of 15 acceptance criteria; verdict PASS. |
| Code review | 5 | 45 | █████░░░░░ | The reviewer requested changes. |
| Completeness | 10 | 80 | ████████░░ | ✓ no TODO or placeholder stubs; ✓ README present; ✓ dependency manifest present; ✗ the OpenAPI contract lists paths the code never mentions: /sessions, /sessions/{name}, /sessions/{name}/open, /sessions/{name}/entry, /hooks/{event}; ✓ every documentation station produced a usable document. |

## Blocking problems
- the Security Reviewer's verdict is FAIL

## Self-correction
The build was sent back to the Developer 1 time(s) before delivery:
- Attempt 1: score 69 (D) → sent back with the findings
- Attempt 2: score 69 (D) → accepted

## Attempts used up
The factory sent the build back 1 time(s), the most it is allowed to, and it still scores 69/100 against a target of 75. It is delivered with the findings shown here, which are what is left to fix.

## What would raise the score
- **Security**: Resolve the scan findings and the Security Reviewer's blocking items.
- **Code review**: Apply the changes the Code Reviewer requested.
