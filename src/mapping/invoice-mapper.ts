import { config } from '../config';
import type { CorpayOneInvoice, CorpayOnePayment } from '../types/corpayone';
import type {
  NetSuiteVendorBill,
  NetSuiteVendorPayment,
  NetSuiteExpenseLine,
} from '../types/netsuite';

/**
 * Maps CorpayOne invoices to NetSuite vendor bills and payments.
 *
 * CorpayOne invoices become NetSuite vendor bills (expense-based).
 * CorpayOne payments become NetSuite vendor payments applied against the bill.
 */

/** Map a CorpayOne invoice to a NetSuite vendor bill */
export function mapInvoiceToVendorBill(
  invoice: CorpayOneInvoice,
  netsuiteVendorId: string,
): NetSuiteVendorBill {
  // Build expense lines from CorpayOne line items
  const expenseLines: NetSuiteExpenseLine[] = invoice.line_items.map((lineItem) => {
    const line: NetSuiteExpenseLine = {
      account: lineItem.account_code
        ? { id: lineItem.account_code }
        : { id: config.netsuite.apAccountId },
      amount: lineItem.amount,
    };

    if (lineItem.description) {
      line.memo = lineItem.description;
    }

    return line;
  });

  // If no line items, create a single expense line with the total
  if (expenseLines.length === 0) {
    expenseLines.push({
      account: { id: config.netsuite.apAccountId },
      amount: invoice.total_amount,
      memo: invoice.description || `CorpayOne Invoice ${invoice.invoice_number || invoice.id}`,
    });
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

  // Set subsidiary if configured
  if (config.netsuite.subsidiaryId) {
    vendorBill.subsidiary = { id: config.netsuite.subsidiaryId };
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

  // Set bank account if configured
  if (config.netsuite.bankAccountId) {
    vendorPayment.account = { id: config.netsuite.bankAccountId };
  }

  // Set subsidiary if configured
  if (config.netsuite.subsidiaryId) {
    vendorPayment.subsidiary = { id: config.netsuite.subsidiaryId };
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
function formatNetSuiteDate(dateStr: string): string {
  const date = new Date(dateStr);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

/** Determine if a CorpayOne invoice status means it should be synced to NetSuite */
export function isSyncableStatus(status: string): boolean {
  // Only sync invoices that have been approved or are in a payment-related state
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
