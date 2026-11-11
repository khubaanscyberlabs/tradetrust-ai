# TradeTrust AI — 09B-03-11 Local Verified-Quote-to-AI Simulation

This internal-only controller links the latest verified D1 quote revision and
server-controlled demonstration policy to the existing structured OpenAI
provider boundary, using a **test-double transport only**. The synthetic
model output is advisory and never an executable financial offer.

Production and buyer-facing HTTP exposure: **not enabled**. No public route,
real OpenAI request, PayPal request, invoice delivery, D1 migration, real D1
writes, or cloud deployment is performed by this milestone.

**Critical trust boundary:** `merchantId`, `quoteId`, and `revisionNo` are
internal selectors only. This module does not authenticate a user, validate
buyer dealroom membership, or derive a persisted merchant policy. A future
HTTP caller must independently verify merchant/buyer access and use actual
server-side merchant policy before invoking any financial approval workflow.

The model gets only the buyer message; it must not control prices. To deliver
a genuinely useful buyer experience, authorized quote details and nonbinding
policy context must be supplied in a reviewed manner and validated through
an authenticated and rate-limited API. That is **not yet implemented**.
