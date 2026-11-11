# TradeTrust AI — Judge Quickstart

## What this project demonstrates

TradeTrust AI explores how buyer requests, seller quotations,
merchant-controlled approval and payment preparation can be
connected without treating unverified AI output as financial
authority.

The public sample buyer workspace and commercial conflict
scenario use illustrative browser data.

The authenticated merchant workflow is separate and requires
local merchant authorization and corresponding D1 records.

## Requirements

- Node.js 24 and npm
- A local terminal and modern browser
- Cloudflare Wrangler, installed through the API package
- No real payment credentials for exploring sample workflows

This guide describes a local development run. It does not
represent a deployed production service.

## 1. Install and build the frontend

From the repository root:

```bash
cd apps/web
npm ci
npm run build
```

## 2. Install the local API dependencies

In a second terminal, from the repository root:

```bash
cd apps/api
npm ci
```

## 3. Prepare the local D1 schema

From `apps/api`:

```bash
npx wrangler d1 migrations apply DB --local
```

This affects the local development database, not a
production or remote D1 database.

The repository contains seven ordered SQL migrations.

A newly migrated database is not automatically populated
with the private authenticated merchant evidence used
during development.

## 4. Start the local Worker

From `apps/api`:

```bash
npm run dev
```

The configured local Worker port is:

`http://127.0.0.1:8787`

Open this address and check that the TradeTrust interface
loads. The combined local runtime must be verified from
a clean checkout before claiming full judge-run acceptance.

The separate Vite development server does not currently
configure an API proxy. Therefore, visiting the Vite port
alone does not establish authenticated API connectivity.

## 5. Explore the demonstration

The unauthenticated sample experience is intended to
demonstrate:

1. Buyer request options and sample quotation preview.
2. Clearly labelled illustrative prices and invoice status.
3. Shipping-responsibility and delivery-date ambiguity.
4. Discount-policy review before any merchant commitment.
5. Why explicit merchant approval matters.

The sample quotation is not an authenticated seller quote,
a real PayPal invoice or evidence of payment.

## 6. Authenticated merchant evidence

The authenticated merchant desk uses protected local
merchant authorization and D1-backed records.

A fresh checkout does not include a private login,
approved merchant quotation or confidential provider
credentials.

Some protected screens therefore require additional
authorized local test setup and may be unavailable from
a clean repository checkout.

Do not use another person's credentials, and do not
interpret an unavailable protected record as a completed
merchant approval.

## 7. AI and PayPal integration boundaries

The project's development verification included separate
Workers AI advisory execution and a PayPal Sandbox invoice
draft operation.

These are not presented as a single end-to-end transaction:
their quote identifiers were different.

No live payment, invoice sending or financial settlement
is claimed.

The browser's sample workflow does not perform AI inference,
send PayPal invoices or initiate payment.

Reproducing protected provider operations requires separate
authorized sandbox configuration. No provider credentials
or private local D1 data are distributed in this repository.

## 8. Run the available engineering checks

From `apps/api`:

```bash
npm run check
```

From `apps/web`:

```bash
npm run build
```

The engineering checks validate code behavior. They do
not substitute for authenticated browser testing or
live-provider acceptance.

## 9. Safety and scope

- This is a hackathon demonstration, not a payment processor.
- AI guidance cannot authorize merchant financial decisions.
- The sample UI is intentionally nonbinding.
- Merchant and payment actions are separately controlled.
- Use only authorized sandbox accounts.
- Never place secrets or private D1 state in the repository.

For the intended presentation flow, see
[Demo Storyboard](DEMO-STORYBOARD.md).
