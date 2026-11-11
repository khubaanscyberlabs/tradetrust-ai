# TRADETRUST-DEALROOM-09B-03-03 — MOCK-ONLY Sandbox draft HTTP adapter

Scope: two NEW source files; no edits to existing source or D1 migration.

- Adds PayPal Invoicing v2 OAuth -> POST create draft -> GET full invoice verification using a mandatory injected transport.
- Requires PAYPAL_ENVIRONMENT=SANDBOX, PAYPAL_DRAFT_CREATE_MODE=MOCK_ONLY, and a trusted merchant email, and refuses missing or incorrect scopes.
- Refuses unclaimed PREPARED operations; requires status UNCERTAIN and validates a SHA-256 digest of the exact request body.
- Compares the PayPal response with expected invoice number, USD amount, sender, buyer and item lines.
- No implicit retries after ambiguous external outcomes. They require later reconciliation.
- NOT wired into src/index.ts. No real HTTP/PayPal requests, D1 writes, deployment or sending occur in this milestone.
- The MOCK_ONLY flag is an application gate, not network isolation if future code deliberately passes native fetch. No such caller is installed.

Remaining dependencies BEFORE a real PayPal POST:
1. A backend-only path retrieving trusted merchant/buyer identities and verified D1 approval.
2. Atomic PREPARED->UNCERTAIN D1 compare-and-set, with idempotent claim protection.
3. Server-owned request-body SHA-256 and stored PayPal-Request-Id verification.
4. Fail-closed reconciliation after any ambiguity; no new invoice number or request ID.
5. Persist DRAFT_CREATED only after provider GET and financial match.
6. Explicit authorization to allow actual Sandbox network writes. No Live environment support.
