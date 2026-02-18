import { config } from '../config';
import {
  getAccountMapping,
  getTaxCodeMapping,
  getBankAccountConfig,
  getSubsidiaryConfig,
} from '../database/mapping-db';
import type { CorpayOneInvoice, CorpayOnePayment } from '../types/corpayone';
import type {
  NetSuiteVendorBill,
  NetSuiteVendorPayment,
  NetSuiteExpenseLine,
} from '../types/netsuite';

/**
 * Maps CorpayOne invoices to NetSuite vendor bills and payments.
 *
 * This is a ONE-WAY sync: CorpayOne → NetSuite only.
 * CorpayOne is read-only — all mapping configuration lives in NetSuite
 * (via the Suitelet dashboard or the /api/config REST API).
 *
 * CorpayOne's API does NOT expose line-item detail — only invoice-level
 * totals (subtotal, vat_amount, total_amount). Each invoice therefore
 * maps to a single expense line in NetSuite.
 *
 * The admin configures the mapping in NetSuite to say:
 *   category "IT Equipment" → NS Account 201
 *   25% DK                  → NS Tax Code DK-S-25
 *   DKK                     → NS Bank Account 152
 *
 * Fallback chain for GL accounts:
 *   1. Match by category + subsidiary
 *   2. Match by category (no subsidiary)
 *   3. Default mapping (is_default = 1)
 *   4. Static config (NETSUITE_AP_ACCOUNT_ID env var)
 *
 * Fallback chain for tax codes:
 *   1. Match by VAT rate + country + subsidiary
 *   2. Match by VAT rate + country
 *   3. Match by VAT rate only
 *   4. Default tax code mapping
 *   5. No tax code (omitted — NetSuite uses its default)
 *
 * Tax amounts: The vat_amount from the CorpayOne invoice is always
 * passed through to NetSuite as taxAmount on the expense line,
 * regardless of whether a tax code mapping was found.
 */

/** Resolve the NetSuite GL account for a CorpayOne invoice */
function resolveAccountId(
  category?: string,
  subsidiaryId?: string,
): string {
  const mapping = getAccountMapping(category, undefined, subsidiaryId);
  if (mapping) return mapping.netsuite_account_id;

  return config.netsuite.apAccountId;
}

/** Resolve the NetSuite tax code for a CorpayOne VAT rate */
function resolveTaxCode(
  vatRate?: number,
  subsidiaryId?: string,
  countryCode?: string,
): { id: string } | undefined {
  if (vatRate === undefined || vatRate === null) return undefined;

  const mapping = getTaxCodeMapping(vatRate, subsidiaryId, countryCode);
  if (mapping) return { id: mapping.netsuite_tax_code_id };

  return undefined;
}

/** Resolve the NetSuite subsidiary */
function resolveSubsidiary(corpayone_entity_id?: string): { id: string } | undefined {
  const mapping = getSubsidiaryConfig(corpayone_entity_id);
  if (mapping) return { id: mapping.netsuite_subsidiary_id };

  if (config.netsuite.subsidiaryId) {
    return { id: config.netsuite.subsidiaryId };
  }

  return undefined;
}

/** Resolve the NetSuite bank account for payments */
function resolveBankAccount(
  currency?: string,
  subsidiaryId?: string,
): { id: string } | undefined {
  const mapping = getBankAccountConfig(currency, subsidiaryId);
  if (mapping) return { id: mapping.netsuite_bank_account_id };

  if (config.netsuite.bankAccountId) {
    return { id: config.netsuite.bankAccountId };
  }

  return undefined;
}

/**
 * Map a CorpayOne invoice to a NetSuite vendor bill.
 *
 * Always creates exactly ONE expense line using the invoice-level totals,
 * because CorpayOne's API does not expose line-item detail.
 */
export function mapInvoiceToVendorBill(
  invoice: CorpayOneInvoice,
  netsuiteVendorId: string,
): NetSuiteVendorBill {
  const subsidiary = resolveSubsidiary();
  const subsidiaryId = subsidiary?.id;
  const vendorCountry = invoice.vendor?.address?.country;

  // Single expense line from invoice-level totals
  const accountId = resolveAccountId(invoice.category, subsidiaryId);

  const line: NetSuiteExpenseLine = {
    account: { id: accountId },
    amount: invoice.subtotal,
    memo: invoice.description || `CorpayOne Invoice ${invoice.invoice_number || invoice.id}`,
  };

  // Resolve tax code from the invoice-level VAT
  if (invoice.vat_amount && invoice.subtotal) {
    const impliedRate = Math.round((invoice.vat_amount / invoice.subtotal) * 100);
    const taxCode = resolveTaxCode(impliedRate, subsidiaryId, vendorCountry);
    if (taxCode) {
      line.taxCode = taxCode;
    }
    line.taxAmount = invoice.vat_amount;
  }

  const vendorBill: NetSuiteVendorBill = {
    entity: { id: netsuiteVendorId },
    externalId: `corpay-${invoice.id}`,
    memo: buildBillMemo(invoice),
    expense: { items: [line] },
  };

  if (invoice.invoice_date) {
    vendorBill.tranDate = formatNetSuiteDate(invoice.invoice_date);
  }

  if (invoice.due_date) {
    vendorBill.dueDate = formatNetSuiteDate(invoice.due_date);
  }

  if (invoice.invoice_number) {
    vendorBill.tranId = invoice.invoice_number;
  }

  if (subsidiary) {
    vendorBill.subsidiary = subsidiary;
  }

  return vendorBill;
}

/** Map a CorpayOne payment to a NetSuite vendor payment */
export function mapPaymentToVendorPayment(
  payment: CorpayOnePayment,
  invoice: CorpayOneInvoice,
  netsuiteVendorId: string,
  netsuiteVendorBillId: string,
): NetSuiteVendorPayment {
  const subsidiary = resolveSubsidiary();
  const bankAccount = resolveBankAccount(payment.currency, subsidiary?.id);

  const vendorPayment: NetSuiteVendorPayment = {
    entity: { id: netsuiteVendorId },
    externalId: `corpay-pay-${payment.id}`,
    memo: `CorpayOne payment ${payment.reference || payment.id} for invoice ${invoice.invoice_number || invoice.id}`,
    apply: {
      items: [
        {
          apply: true,
          doc: parseInt(netsuiteVendorBillId, 10),
          amount: payment.amount,
        },
      ],
    },
  };

  if (payment.payment_date) {
    vendorPayment.tranDate = formatNetSuiteDate(payment.payment_date);
  }

  if (bankAccount) {
    vendorPayment.account = bankAccount;
  }

  if (subsidiary) {
    vendorPayment.subsidiary = subsidiary;
  }

  return vendorPayment;
}

/** Build a memo string for the vendor bill */
function buildBillMemo(invoice: CorpayOneInvoice): string {
  const parts: string[] = [];
  if (invoice.description) {
    parts.push(invoice.description);
  }
  if (invoice.reference) {
    parts.push(`Ref: ${invoice.reference}`);
  }
  if (invoice.po_number) {
    parts.push(`PO: ${invoice.po_number}`);
  }
  parts.push(`[CorpayOne: ${invoice.id}]`);
  return parts.join(' | ');
}

/**
 * Format a date string to NetSuite's expected format (MM/DD/YYYY).
 * Accepts ISO date strings.
 */
export function formatNetSuiteDate(dateStr: string): string {
  const date = new Date(dateStr);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

/** Determine if a CorpayOne invoice status means it should be synced to NetSuite */
export function isSyncableStatus(status: string): boolean {
  const syncableStatuses = [
    'approved',
    'scheduled',
    'paid',
    'partially_paid',
  ];
  return syncableStatuses.includes(status);
}

/** Determine if a CorpayOne payment should be synced */
export function isSyncablePayment(payment: CorpayOnePayment): boolean {
  return payment.status === 'completed';
}
