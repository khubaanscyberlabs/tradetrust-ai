# 09B-03-06 — Local React buyer and merchant UX prototype

The React application now shows an interactive buyer-to-merchant **UI-only** flow with fictional data. It uses local React state, a small deterministic illustration of discount policy, a synthetic $109 initial quote, merchant approval *preview*, and an invoice *preview*.

**NOT** a real AI agent, signed merchant approval, authoritative D1 quote, PayPal API request, sent invoice, or payment. The production PayPal payment button is deliberately disabled. This deliverable exists to replace the default Vite starter UI with an explicit, honest hackathon demo shell, not to represent completed financial integration.

`apps/web/src/App.tsx` is preserved; `apps/web/src/main.tsx` imports the new frontend component. Source is isolated in `apps/web/src/tradetrust`. No API source, migrations, Cloudflare Worker public routes, or real D1 records are changed.

Local preview, after passing tests: `cd ~/projects/tradetrust-ai/apps/web && npm run dev -- --host 127.0.0.1`. In a Windows browser with WSL port forwarding enabled, open `http://localhost:5173/`. Do not expose the dev server to the network or deploy this mock UI as if it were payment-ready.

**Critical next work:** integrate real signed buyer/merchant authentication and quote flows, genuine model-mediated negotiation with strict tool/rule boundaries, and authorized PayPal Sandbox invoice/payment/reconciliation. The mock UI can be replaced progressively without deleting the existing backend modules.
