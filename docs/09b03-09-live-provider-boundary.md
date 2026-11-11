# TradeTrust AI 09B-03-09 — internal OpenAI provider transport boundary

## What is now implemented
- An internal-only adapter that produces a nonbinding `ProviderSuggestion` from the Responses API wire format.
- Mock transport is distinctly labeled `MOCK_TRANSPORT`; a future real call is distinctly labeled `REAL_TRANSPORT`.
- Real `fetch` cannot execute unless the caller explicitly supplies the global fetch function **and** the private environment includes `TRADETRUST_AI_MODE=LIVE_TEST`, `TRADETRUST_AI_REAL_CALL_APPROVED=YES_EXPLICITLY`, and a syntactically valid server-side OpenAI key.
- The current installation never provisions those settings, passes real `fetch`, opens a route, or calls OpenAI.
- Model output is never a binding offer or approval; deterministic code applies merchant discount policy. It does not compute or persist totals.
- Validation rejects unexpected request/context fields, excess buyer input, forged monetary fields, invalid model output, unsafe discounts, incomplete responses, oversized responses, network errors, and failures without exposing upstream secrets.
- No retries are made automatically. Requests have an 8-second timeout. Responses use `store: false`, no tools, strict JSON structure and a low output-token bound.

## Outstanding trust boundary — mandatory before any buyer traffic
- The `TrustedNegotiationContext` is a trusted **internal parameter**, NOT proof that the caller retrieved it from D1. It must be derived by the backend from a verified quote revision, merchant ownership, and persisted policy; never accept it directly from buyer JSON.
- The application currently has NO AI public route, conversation persistence, browser-side OpenAI key, approval integration, or rate limiting. Do not enable a live route until authorization, abuse protection, replay constraints, rate limits, logging redaction, session controls and budget controls are implemented and reviewed.
- The real transport arm is dormant. A separate, consciously authorized single-call runner must be implemented and approved before any real OpenAI request or charge.
- OpenAI model availability, billing limits and key setup must be confirmed on the developer's own OpenAI API account. ChatGPT subscription does not include API usage.
- Real-model output structure has NOT been validated against the live provider; strict parsing may reject legitimate responses and will need a controlled test.

## Financial guardrails
- AI never writes D1, modifies merchant policy, approves a quote, creates an invoice, sends an invoice, or initiates a payment.
- PayPal Sandbox and Cloudflare production remain completely untouched.
- No private API keys in repository, frontend bundle, logs, or screenshots.
