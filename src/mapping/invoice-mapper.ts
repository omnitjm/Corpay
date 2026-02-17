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
 * Uses the admin-configured mapping tables (account mappings, tax code mappings,
 * bank account config, subsidiary config) to resolve the correct NetSuite
 * GL accounts, tax codes, bank accounts, and subsidiaries - similar to
 * how the Pleo NetSuite integration works.
 *
 * Fallback chain for accounts:
 *   1. Dynamic mapping table (by CorpayOne account_code + subsidiary)
 *   2. Default mapping (is_default = 1)
 *   3. Static config (NETSUITE_AP_ACCOUNT_ID env var)
 *
 * Fallback chain for tax codes:
 *   1. Dynamic mapping table (by VAT rate + subsidiary + country)
 *   2. Default tax code mapping
 *   3. No tax code (omitted from line)
 *
 * Fallback chain for bank accounts:
 *   1. Dynamic mapping table (by currency + subsidiary)
 *   2. Default bank account mapping
 *   3. Static config (NETSUITE_BANK_ACCOUNT_ID env var)
 *
 * Fallback chain for subsidiaries:
 *   1. Dynamic mapping table (by CorpayOne entity)
 *   2. Default subsidiary mapping
 *   3. Static config (NETSUITE_SUBSIDIARY_ID env var)
 */

/** Resolve the NetSuite GL account ID for a CorpayOne line item */
function resolveAccountId(accountCode?: string, subsidiaryId?: string): string {
  if (accountCode) {
    const mapping = getAccountMapping(accountCode, subsidiaryId);
    if (mapping) return mapping.netsuite_account_id;
  }

  // Fall back to static config
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

/** Map a CorpayOne invoice to a NetSuite vendor bill */
export function mapInvoiceToVendorBill(
  invoice: CorpayOneInvoice,
  netsuiteVendorId: string,
): NetSuiteVendorBill {
  const subsidiary = resolveSubsidiary();
  const subsidiaryId = subsidiary?.id;
  const vendorCountry = invoice.vendor?.address?.country;

  // Build expense lines from CorpayOne line items
  const expenseLines: NetSuiteExpenseLine[] = invoice.line_items.map((lineItem) => {
    const accountId = resolveAccountId(lineItem.account_code, subsidiaryId);

    const line: NetSuiteExpenseLine = {
      account: { id: accountId },
      amount: lineItem.amount,
    };

    if (lineItem.description) {
      line.memo = lineItem.description;
    }

    // Resolve tax code from the VAT rate on the line item
    const taxCode = resolveTaxCode(lineItem.vat_rate, subsidiaryId, vendorCountry);
    if (taxCode) {
      line.taxCode = taxCode;
    }
    if (lineItem.vat_amount !== undefined) {
      line.taxAmount = lineItem.vat_amount;
    }

    return line;
  });

  // If no line items, create a single expense line with the total
  if (expenseLines.length === 0) {
    const defaultAccountId = resolveAccountId(undefined, subsidiaryId);
    const line: NetSuiteExpenseLine = {
      account: { id: defaultAccountId },
      amount: invoice.total_amount,
      memo: invoice.description || `CorpayOne Invoice ${invoice.invoice_number || invoice.id}`,
    };

    // Try to resolve tax code from the invoice-level VAT
    if (invoice.vat_amount && invoice.subtotal) {
      const impliedRate = Math.round((invoice.vat_amount / invoice.subtotal) * 100);
      const taxCode = resolveTaxCode(impliedRate, subsidiaryId, vendorCountry);
      if (taxCode) {
        line.taxCode = taxCode;
        line.taxAmount = invoice.vat_amount;
      }
    }

    expenseLines.push(line);
  }

  const vendorBill: NetSuiteVendorBill = {
    entity: { id: netsuiteVendorId },
    externalId: `corpay-${invoice.id}`,
    memo: buildBillMemo(invoice),
    expense: { items: expenseLines },
  };

  // Set transaction date from invoice date
  if (invoice.invoice_date) {
    vendorBill.tranDate = formatNetSuiteDate(invoice.invoice_date);
  }

  // Set due date
  if (invoice.due_date) {
    vendorBill.dueDate = formatNetSuiteDate(invoice.due_date);
  }

  // Set transaction reference number
  if (invoice.invoice_number) {
    vendorBill.tranId = invoice.invoice_number;
  }

  // Set subsidiary from mapping configuration
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

  // Set payment date
  if (payment.payment_date) {
    vendorPayment.tranDate = formatNetSuiteDate(payment.payment_date);
  }

  // Set bank account from mapping configuration
  if (bankAccount) {
    vendorPayment.account = bankAccount;
  }

  // Set subsidiary from mapping configuration
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
