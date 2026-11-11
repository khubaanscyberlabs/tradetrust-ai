# TradeTrust AI — 09B-03-04 Local-only Draft Operation Ledger

## Implemented

- `claimPreparedDraft(db, binding, prepared)` performs an atomic CAS from `PREPARED` to `UNCERTAIN` with immutable merchant/approval/quote amount/digest/request ID matching and live approved-revision existence.
- `finalizeVerifiedDraft(db, binding, prepared, claim, verified)` performs a conditional CAS from `UNCERTAIN` to `DRAFT_CREATED`, recording a verified PayPal invoice ID once.
- Readback confirms actual stored state after each successful update; missing/unknown results fail closed.
- Duplicate/parallel claims are rejected; there is no automatic external POST retry.
- Unit tests exercise the repository's real `0005` SQL migration against an in-memory SQLite database with synthetic supporting tables and data.

## Still disabled / not implemented

- No Worker endpoint, no network `fetch`, no PayPal API call, no public URL, no remote D1 operation.
- No invocation of these ledger helpers from a merchant action. Calling code must first run the existing signed-identity, membership, and persisted-approval checks in `prepareApprovedDraft`.
- The `verified` argument MUST come from `createSandboxDraftMockOnly` after provider readback, not from user input or a forged test result.
- Trusted merchant and buyer enrollment binding, mock-only end-to-end orchestration, actual Sandbox creation, send/payment flow, provider reconciliation, and AI negotiation remain future tasks.
- Once a request has been claimed `UNCERTAIN`, do not resubmit it automatically. Reconciliation must establish provider state before any new action.

## Security note

The ledger module is an internal primitive, not an authorization endpoint. It does not prove the caller's identity by itself. Exposing it as an HTTP endpoint would be a security vulnerability.
