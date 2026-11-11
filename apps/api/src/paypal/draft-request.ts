import {
  mapStoredQuoteToInvoiceDraft,
  type StoredQuoteRevision,
} from './invoice-mapper.ts';

/**
 * PayPal Sandbox draft request composition.
 *
 * Input approval records MUST ultimately come from a
 * trusted D1 query. Passing an object here is not proof
 * of merchant authorization.
 *
 * No HTTP requests or database writes.
 */

type ApprovalRecord = Readonly<{
  id: string;
  merchant_id: string;
  quote_id: string;
  revision_no: number;
  snapshot_sha256: string;
}>;

export type DraftContext = Readonly<{
  merchantId: string;
  approval: ApprovalRecord;
  stored: StoredQuoteRevision;
  invoicerEmail: string;
  invoicerBusinessName: string;
  buyerEmail: string;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

function reject(): never {
  throw Error('PAYPAL_DRAFT_CONTEXT_REJECTED');
}

function validEmail(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 5 ||
    value.length > 254 ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }

  const parts = value.split('@');

  if (parts.length !== 2) return false;

  const [local, domain] = parts;

  if (
    !local ||
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/
      .test(local)
  ) {
    return false;
  }

  const labels = domain.split('.');

  return (
    labels.length >= 2 &&
    labels.every(label =>
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
        .test(label)
    )
  );
}

async function stableInvoiceNumber(
  merchantId: string,
  approvalId: string,
): Promise<string> {
  const source =
    `TradeTrustAI:invoice:v1:${merchantId}:${approvalId}`;

  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  );

  const hex = Array.from(new Uint8Array(bytes))
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');

  // PayPal invoice number maximum is 25 characters.
  return `TT-${hex.slice(0, 20)}`;
}

export async function composeDraftRequest(
  context: DraftContext,
) {
  if (
    !context ||
    typeof context !== 'object' ||
    !context.approval ||
    typeof context.approval !== 'object' ||
    !context.stored ||
    typeof context.stored !== 'object' ||
    typeof context.merchantId !== 'string' ||
    !ID.test(context.merchantId) ||
    typeof context.approval.id !== 'string' ||
    !ID.test(context.approval.id) ||
    context.approval.merchant_id !==
      context.merchantId ||
    context.approval.quote_id !==
      context.stored.quote_id ||
    !Number.isSafeInteger(
      context.approval.revision_no
    ) ||
    context.approval.revision_no < 1 ||
    !HASH.test(
      context.approval.snapshot_sha256 ?? ''
    ) ||
    context.approval.snapshot_sha256 !==
      context.stored.snapshot_sha256 ||
    !validEmail(context.invoicerEmail) ||
    !validEmail(context.buyerEmail) ||
    context.invoicerEmail.toLowerCase() ===
      context.buyerEmail.toLowerCase() ||
    typeof context.invoicerBusinessName !==
      'string' ||
    context.invoicerBusinessName.length < 1 ||
    context.invoicerBusinessName.length > 120 ||
    context.invoicerBusinessName.trim() !==
      context.invoicerBusinessName ||
    /[\u0000-\u001f\u007f]/.test(
      context.invoicerBusinessName
    )
  ) {
    reject();
  }

  const mapped = await mapStoredQuoteToInvoiceDraft(
    context.stored,
  );

  const invoiceNumber = await stableInvoiceNumber(
    context.merchantId,
    context.approval.id,
  );

  const financials = mapped.draftFinancials;

  const draftBody = {
    detail: {
      ...financials.detail,
      invoice_number: invoiceNumber,
      payment_term: {
        term_type: 'DUE_ON_RECEIPT' as const,
      },
    },

    invoicer: {
      email_address: context.invoicerEmail,
      business_name: context.invoicerBusinessName,
    },

    primary_recipients: [{
      billing_info: {
        email_address: context.buyerEmail,
      },
    }],

    items: financials.items,

    ...(financials.amount
      ? { amount: financials.amount }
      : {}),

    configuration: {
      allow_tip: false,
      partial_payment: {
        allow_partial_payment: false,
      },
      save_item_for_future: false,
    },
  };

  return Object.freeze({
    draftBody,
    expectedTotal: mapped.expectedTotal,
    verifiedSnapshotSha256:
      mapped.verifiedSnapshotSha256,
    approvalId: context.approval.id,
    invoiceNumber,
  });
}
