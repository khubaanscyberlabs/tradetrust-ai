# TradeTrust AI — 09B-03-10 Trusted D1 Negotiation Context

This module is **internal and local-simulation only**. It reads the most recent persisted quote revision, validates the SHA-256 over the persisted snapshot JSON, verifies the merchant/quote identity and USD currency, and binds a server-owned **demonstration** discount ceiling (0–500 basis points).

It returns only the merchant ID, quote ID, revision digest, currency and nonbinding demo policy for use by the existing negotiation adapter. It does **not** expose the quote JSON or payment details to a model, and has no public route, D1 writes, OpenAI call, PayPal call or deployment.

**Security limitation:** The caller must verify merchant/dealroom authorization before invoking this resolver. The demo policy is not a verified merchant-specific persisted policy and must never approve an executable financial quote. Neither the fake provider transport nor live provider is enabled by this milestone.

Only after the session and business policy are independently verified should the resolver be connected to a buyer-facing API.
