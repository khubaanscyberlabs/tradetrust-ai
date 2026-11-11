# TradeTrust AI — Cross-Border Dealroom

## Product

Turn international buyer enquiries into verified,
merchant-approved quotes and PayPal Sandbox payments.

## Trust Boundaries

1. Buyer input is untrusted.
2. AI output is untrusted.
3. Product prices come from the trusted backend catalogue.
4. Stock and shipping rules are server-enforced.
5. AI cannot authorize discounts or financial actions.
6. Merchant approval must be authenticated and persisted.
7. Approved quote totals must be immutable.
8. PayPal credentials remain server-side.
9. PayPal results must be verified using provider APIs.
10. Payment notifications require signature verification.
11. Duplicate financial operations must be idempotent.
12. Audit events must not contain secrets or payment credentials.

## Proposed Workflow

Buyer enquiry
  -> AI extracts intent (future)
  -> Trusted quote proposal
  -> Authenticated merchant approval (future)
  -> Immutable approved quote in D1 (future)
  -> PayPal Sandbox invoice/order (future)
  -> Provider payment verification (future)
  -> Audit record and merchant dashboard (future)

## Current Stage

The deterministic quote proposal module is the first
implementation. It is not yet connected to a Worker,
database, AI model or PayPal.

The synthetic catalogue is test data, not actual
merchant inventory.

No checkout, invoice sending or financial action is
permitted at this stage.
