# TradeTrust AI

**Every term approved. Every draft verified.**

TradeTrust AI is a security-conscious prototype for AI-assisted commercial
negotiation and PayPal invoicing. It focuses on helping smaller merchants
review buyer requests while keeping financial authorization under human and
server-side control.

Built for the PayPal AI Hackathon 2026.

## The problem

A buyer may ask to change discounts, delivery terms or shipping. A merchant
needs to assess those requests without accidentally changing an approved
quotation or creating duplicate invoices.

## Our approach

- Cloudflare Workers AI generates a nonbinding commercial advisory.
- Trusted quotation data and merchant policy are supplied server-side.
- AI cannot independently approve financial changes or initiate payments.
- Approved quotation revisions are bound to immutable financial identities.
- PayPal Sandbox invoice creation is approval-gated.
- Uncertain provider outcomes require reconciliation, not blind retries.
- Provider readback is checked against the approved financial terms.

## Technology

- Frontend: React, TypeScript and Vite
- API: Cloudflare Workers and TypeScript
- Local database: Cloudflare D1
- AI: Cloudflare Workers AI with the Gemma model
- Payments integration: PayPal Invoicing API (Sandbox)

## Prerequisites

Node.js 24 and npm are recommended for reproducing the tested development
environment. Use your own local environment and credentials where required.

## Source structure

- `apps/web/` — React frontend
- `apps/api/` — Cloudflare Workers API, D1 integrations and tests
- `docs/DEMO-STORYBOARD.md` — judge-facing demonstration plan

Each application has its own `package.json` and lockfile. There is no required
root-level npm workspace.

## Offline verification

Run these commands independently from the repository root:

```bash
cd apps/api
npm ci
npm run typecheck
npm test
```

Then, from the repository root:

```bash
cd apps/web
npm ci
npm run build
```

The test suite includes synthetic payment and AI-provider scenarios. Running
these tests is not authorization to make real provider calls.

**Fresh-install verification is pending for this publication candidate.**
The commands above are based on existing package scripts; they still require
validation in a clean judge environment.

## Local interactive application

The API package provides `npm run dev` and the web package also provides
`npm run dev`. Their environment, D1 initialization and authenticated demo
bootstrap must be configured before the full interactive application can be
considered independently reproducible.

This setup path is undergoing release acceptance. Do not assume the
repository contains working credentials or a pre-provisioned merchant login.

## Security boundaries

All provider execution is disabled by default and requires explicit,
environment-specific authorization.

The AI advisory is untrusted and nonbinding, even if its JSON is valid.
Monetary totals, discounts, seller identity and merchant approval are
validated by deterministic application logic.

Real PayPal Live payments, invoice sending and production deployments are
outside the authorized demonstration scope.

Never commit `.dev.vars`, API keys, credentials, D1 local state, private
operation journals or session tokens.

## Verified development evidence

In the private local development environment:

- A real Cloudflare Workers AI advisory was accepted by the structured
  response parser and retained nonbinding financial safeguards.
- A USD 109 PayPal Sandbox draft was independently verified through PayPal
  invoice readback and reconciled into the existing local D1 operation.
- An uncertain initial provider outcome was handled through controlled,
  same-request-identity recovery without a blind automatic retry.

**Important limitation:** the real AI acceptance and real PayPal Sandbox
invoice used different quotation IDs, although their recorded snapshot
hashes matched. They must not be represented as a single fully linked
production transaction.

No real payment or cross-border settlement has been demonstrated.

## Demo and licensing

See [Demo Storyboard](docs/DEMO-STORYBOARD.md).

Proposed license: MIT. Copyright ownership and third-party visual asset
provenance must be confirmed before public publication.

This prototype is not a production payment service.

## Judge quickstart

For local setup, demo boundaries and verification instructions, see the [Judge quickstart](docs/JUDGE-QUICKSTART.md).
