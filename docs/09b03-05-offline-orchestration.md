# TRADETRUST-DEALROOM-09B-03-05 — Offline Approval-to-Draft Orchestration

## Purpose

Implement one **synthetic**, **mock-only**, **local** internal pipeline:

signed Access human identity + D1 approval via existing `prepareApprovedDraft` → atomic D1 `PREPARED` to `UNCERTAIN` claim → existing `createSandboxDraftMockOnly` using **hardcoded in-process synthetic responses** → read-back matching → immutable `DRAFT_CREATED` finalization.

This milestone does **not** invoke real PayPal, does **not** expose a Worker route, does **not** change actual Cloudflare D1, does **not** deploy anything, and does **not** send or charge a buyer. Tests use isolated in-memory SQLite fixtures only.

## Safety restrictions

- Offline gate `TRADETRUST_OFFLINE_SIMULATION=ENABLED_LOCAL_ONLY` and `PAYPAL_DRAFT_CREATE_MODE=MOCK_ONLY` are mandatory.
- `PAYPAL_ENVIRONMENT=SANDBOX`; live is rejected before a ledger claim.
- Merchant and buyer emails come only from explicit synthetic mock configuration. Do not expose these as client-controlled fields or reuse this mock configuration for production onboarding.
- No use of global `fetch`. Synthetic OAuth, invoice POST and GET are handled by a private closure that cannot forward network traffic.
- Replay, timeout, invalid provider amount, malformed ids and tampering cannot create another external operation. `UNCERTAIN` requires a separate reconciliation workflow.
- The direct `executePreparedDraftOffline` helper is for fixture tests only; it does not authenticate humans and must never be routed. Only `simulateApprovedDraftOffline` calls real signed-human verification and persisted D1 approval through `prepareApprovedDraft`.
- This is not a real PayPal integration acceptance test. Actual Sandbox behavior, trusted buyer onboarding, authenticating merchant user actions and payment verification remain pending.

## Next priority

Build an authenticated browser-visible merchant approval and buyer dealroom vertical slice, then support a separately approved genuine PayPal Sandbox draft creation and safe reconciliation, and real AI negotiation. Preserve no-production/no-remote constraints until authorized.
