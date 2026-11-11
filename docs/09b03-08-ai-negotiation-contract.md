# TradeTrust AI 09B-03-08 — structured negotiation intent (MOCK ONLY)

## Trust boundary
- Input: buyer utterance, signed-backend-verified quote/merchant policy supplied internally. Never take `TrustedNegotiationContext` from a buyer request.
- Output: a non-binding suggestion, an intent, requested discount in basis points, and a shipping preference. No financial totals, approval decision, PayPal invoice ID, or payment action.
- The model may REQUEST a discount outside policy, but a deterministic server-side check returns `NEEDS_MERCHANT_REVIEW`; downstream trusted quote services must independently enforce merchant policy.
- Model-generated `reply` is untrusted and must not be presented as a binding offer. Merchant approval is still required.

## This milestone's execution gate
- `TRADETRUST_AI_MODE=MOCK_ONLY`, model name, and literal `test-only-not-a-real-key` are required.
- Caller must inject an in-process synthetic transport. Passing global `fetch` is denied, and there is no implicit network fallback.
- No public route, API key provisioning, live model call, storage of buyer turns, payment, D1 write, or Cloudflare deployment occurs.
- The OpenAI Responses wire format and strict JSON output schema are exercised against 23 mocked tests. A real provider round trip is NOT verified.

## Next milestones
1. Replace the mock-only test boundary with a separately approved server-side OpenAI adapter. Verify exact model support, cost budget, storage/privacy settings, authentication, rate limits, replay limits, abuse controls, and trusted D1 quote selection before enabling real requests.
2. Integrate with the existing authoritative quote engine to calculate actual approved prices and persist offers. Never trust model-generated amounts.
3. Expose a guarded buyer conversation endpoint and connect the React UI. Keep approval, PayPal invoice, and payments separate.

## Guardrails
- No `OPENAI_API_KEY` in Git, frontend bundles, requests, or test logs. OpenAI API billing is separate from a ChatGPT subscription.
- API or provider errors sanitize upstream error details and never disclose credentials.
- OWASP-style allowlist validation, strict response structure, input bounds, fail-closed defaults, and separation of decision authority.
