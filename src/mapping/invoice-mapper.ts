import { config } from '../config';
import {
  getAccountMapping,
  getTaxCodeMapping,
  getBankAccountConfig,
  getSubsidiaryConfig,
} from '../database/mapping-db';
import type { CorpayOneExpense, CorpayOnePayment } from '../types/corpayone';
import type {
  NetSuiteVendorBill,
  NetSuiteVendorPayment,
  NetSuiteExpenseLine,
} from '../types/netsuite';

/**
 * Maps CorpayOne v3 expenses to NetSuite vendor bills and payments.
 *
 * This is a ONE-WAY sync: CorpayOne → NetSuite only.
 *
 * CorpayOne v3 API key facts:
 *   - Entity is called "expense", not "invoice"
 *   - Endpoint: GET /external/v3/expenses
 *   - Lines ARE available (expense.lines[]), each with category + amount
 *   - NO VAT breakdown in the API at any level
 *   - Vendor is shallow: only id/name/externalId
 *   - State field (not "status"): Booked, Awaiting, Paid, Pending, Cancelled, etc.
 *
 * Mapping strategy:
 *   - If expense.lines is non-empty → one NS expense line per CorpayOne line
 *   - If expense.lines is empty    → single NS expense line from expense.amount
 *   - GL account: resolved from category name via admin-configured mapping table
 *   - No tax codes are set from API data — NetSuite applies tax by its own rules
 *   - FX: if expense.fx exists, use fx.homeAmount as the NS line amount
 *
 * GL account fallback chain:
 *   1. Match by category name + subsidiary
 *   2. Match by category name (no subsidiary)
 *   3. Default mapping (is_default = 1)
 *   4. Static config (NETSUITE_AP_ACCOUNT_ID env var)
 */

/** Resolve the NetSuite GL account from a CorpayOne category name */
function resolveAccountId(categoryName?: string, subsidiaryId?: string): string {
  const mapping = getAccountMapping(categoryName, undefined, subsidiaryId);
  if (mapping) return mapping.netsuite_account_id;
  return config.netsuite.apAccountId;
}

/** Resolve the NetSuite tax code for a given VAT rate (used only if configured) */
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
function resolveSubsidiary(): { id: string } | undefined {
  const mapping = getSubsidiaryConfig(undefined);
  if (mapping) return { id: mapping.netsuite_subsidiary_id };
  if (config.netsuite.subsidiaryId) return { id: config.netsuite.subsidiaryId };
  return undefined;
}

/** Resolve the NetSuite bank account for payments */
function resolveBankAccount(currency?: string, subsidiaryId?: string): { id: string } | undefined {
  const mapping = getBankAccountConfig(currency, subsidiaryId);
  if (mapping) return { id: mapping.netsuite_bank_account_id };
  if (config.netsuite.bankAccountId) return { id: config.netsuite.bankAccountId };
  return undefined;
}

/**
 * Map a CorpayOne expense to a NetSuite vendor bill.
 *
 * If the expense has split lines, each line becomes a separate NS expense line.
 * If no lines, a single line is created from the expense total.
 *
 * No VAT is mapped — the CorpayOne v3 API does not expose VAT breakdowns.
 */
export function mapExpenseToVendorBill(
  expense: CorpayOneExpense,
  netsuiteVendorId: string,
): NetSuiteVendorBill {
  const subsidiary = resolveSubsidiary();
  const subsidiaryId = subsidiary?.id;

  let expenseLines: NetSuiteExpenseLine[];

  if (expense.lines && expense.lines.length > 0) {
    // Multi-line: one NS line per CorpayOne line
    expenseLines = expense.lines.map((line) => ({
      account: { id: resolveAccountId(line.category?.name, subsidiaryId) },
      amount: line.amount,
      memo: line.note || line.category?.name || expense.reference,
    }));
  } else {
    // Single line from expense-level total
    // If FX: use homeAmount so the bill is in the home currency
    const amount = expense.fx ? expense.fx.homeAmount : expense.amount;
    expenseLines = [
      {
        account: { id: resolveAccountId(expense.category?.name, subsidiaryId) },
        amount,
        memo: expense.reference || `CorpayOne expense ${expense.id}`,
      },
    ];
  }

  const vendorBill: NetSuiteVendorBill = {
    entity: { id: netsuiteVendorId },
    externalId: `corpay-${expense.id}`,
    memo: buildBillMemo(expense),
    expense: { items: expenseLines },
  };

  if (expense.issueDate) {
    vendorBill.tranDate = formatNetSuiteDate(expense.issueDate);
  }

  if (expense.dueDate) {
    vendorBill.dueDate = formatNetSuiteDate(expense.dueDate);
  }

  if (expense.reference) {
    vendorBill.tranId = expense.reference;
  }

  if (subsidiary) {
    vendorBill.subsidiary = subsidiary;
  }

  return vendorBill;
}

/** Map a CorpayOne payment to a NetSuite vendor payment */
export function mapPaymentToVendorPayment(
  payment: CorpayOnePayment,
  expense: CorpayOneExpense,
  netsuiteVendorId: string,
  netsuiteVendorBillId: string,
): NetSuiteVendorPayment {
  const subsidiary = resolveSubsidiary();
  const bankAccount = resolveBankAccount(payment.currency, subsidiary?.id);

  const vendorPayment: NetSuiteVendorPayment = {
    entity: { id: netsuiteVendorId },
    externalId: `corpay-pay-${payment.id}`,
    memo: `CorpayOne payment ${payment.reference || payment.id} for expense ${expense.reference || expense.id}`,
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
function buildBillMemo(expense: CorpayOneExpense): string {
  const parts: string[] = [];
  if (expense.reference) parts.push(expense.reference);
  if (expense.category?.name) parts.push(expense.category.name);
  parts.push(`[CorpayOne: ${expense.id}]`);
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

/**
 * Determine if a CorpayOne expense state means it should be synced to NetSuite.
 * Booked = approved by approver, Awaiting = ready for payment, Paid = settled.
 */
export function isSyncableStatus(state: string): boolean {
  return ['Booked', 'Awaiting', 'Paid'].includes(state);
}

/** Determine if a CorpayOne payment should be synced */
export function isSyncablePayment(payment: CorpayOnePayment): boolean {
  return payment.status === 'completed';
}

// ── Keep old name as alias so other files can be updated gradually ──
export { mapExpenseToVendorBill as mapInvoiceToVendorBill };
