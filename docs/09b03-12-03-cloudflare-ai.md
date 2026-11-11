# TradeTrust AI — 09B-03-12-03 Cloudflare Workers AI Adapter

This milestone adds the `AI` binding to the local-only TradeTrust Worker
configuration and an isolated, pure Cloudflare Gemma-4 request builder plus
strict response parser. **No AI binding is invoked by this patch.**

The selected Workers Free-eligible model is
`@cf/google/gemma-4-26b-a4b-it`. Workers AI has a 10,000-neuron/day free
allocation; requests beyond the Free tier allocation fail. Inference
*consumes actual Cloudflare quota even with a local Worker* when later enabled.

The model is instructed to return JSON, but this adapter does not rely on
JSON Mode support for Gemma 4. Model output is untrusted; malformed or
incomplete output is rejected. Its content is nonbinding negotiation advice,
never a verified quote, discount authorization, merchant approval, invoice,
or payment. Server demonstration ceiling is capped at 5% (500 basis points).

There is no route, remote database configuration, production deployment,
external fetch, model call, local D1 data modification, or expense in the
installer. The `AI` binding being declared does **not** authorize running it.

Next step (separately gated): authenticate the target Cloudflare account and
confirm Workers Free; then explicitly authorize *one* quota-consuming local
inference with a synthetic buyer message and read-only D1 context, retaining
all merchant and quote trust boundaries. Do not expose a buyer route until
rate limiting, authentication and server-authoritative quote policies exist.

References:
- https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/ai/models/@cf/google/gemma-4-26b-a4b-it/
