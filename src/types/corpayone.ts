/** CorpayOne OAuth token response */
export interface CorpayOneTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** Category on a CorpayOne expense or line */
export interface CorpayOneCategory {
  id: string;
  name: string;
  number?: string;
  externalId?: string;
  parent?: { id: string };
}

/** Department on a CorpayOne expense or line */
export interface CorpayOneDepartment {
  id: string;
  name: string;
  externalId?: string;
}

/** Item on a CorpayOne expense or line */
export interface CorpayOneItem {
  id: string;
  name: string;
  externalId?: string;
  quantity?: number;
}

/**
 * Shallow vendor reference embedded in an expense.
 * The v3 API only returns id/name/externalId on the expense object.
 * Full vendor details (address, bank account) are not available at this level.
 */
export interface CorpayOneVendorShallow {
  id: string;
  name: string;
  externalId?: string;
}

/** FX / currency conversion info on an expense */
export interface CorpayOneFx {
  homeAmount: number;
  foreignAmount: number;
  homeCurrency: string;
  foreignCurrency: string;
  isForeignFixedCurrency: boolean;
  exchangeRate: number;
  paymentInstructionType?: string;
}

/**
 * A single amount line on a CorpayOne expense.
 * Lines have a category and amount but NO VAT breakdown.
 * Tax handling is done in NetSuite based on configured tax codes.
 */
export interface CorpayOneExpenseLine {
  id: string;
  category?: CorpayOneCategory;
  departmentId?: string;
  department?: CorpayOneDepartment;
  amount: number;
  note?: string;
  item?: CorpayOneItem;
}

/**
 * CorpayOne expense state (BillStatus in v3 API).
 * Syncable to NetSuite: Booked, Awaiting, Paid.
 * Skip: Pending (draft), Cancelled, Paused, Duplicate.
 */
export type CorpayOneExpenseState =
  | 'Pending'
  | 'Booked'
  | 'Paid'
  | 'Cancelled'
  | 'Awaiting'
  | 'Paused'
  | 'Duplicate'
  | 'Refunded'
  | 'Initialized';

/** CorpayOne expense friendly status (more granular than state) */
export type CorpayOneExpenseFriendlyStatus =
  | 'Pending'
  | 'Booked'
  | 'Paid'
  | 'Cancelled'
  | 'Awaiting'
  | 'Paused'
  | 'Duplicate'
  | 'Refunded'
  | 'Initiated'
  | 'CheckIssued'
  | 'VccIssued'
  | 'Refunding'
  | 'MarkedAsPaid'
  | 'Scheduled'
  | 'Processing'
  | 'OnHold';

/**
 * CorpayOne expense (vendor bill / AP transaction).
 * API: GET /external/v3/expenses/{expenseId}
 * Single responses are wrapped: { data: ExpenseResponse }.
 *
 * Key fields:
 *   - amount    : total amount (no separate VAT breakdown)
 *   - lines     : split lines, each with category + amount (may be empty)
 *   - state     : workflow state (Booked = approved, Paid = settled)
 *   - reference : vendor's invoice/reference number
 *   - issueDate : invoice date from the vendor
 */
export interface CorpayOneExpense {
  id: string;
  type: string;
  reference?: string;
  number?: number;
  amount: number;
  originalAmount?: number;
  currency: string;
  originalCurrency?: string;
  state: CorpayOneExpenseState;
  friendlyStatus: CorpayOneExpenseFriendlyStatus;
  referenceDate?: string;
  issueDate: string;
  dueDate?: string;
  originalDueDate?: string;
  paymentDate?: string;
  ripePaymentId?: string;
  isPayable?: boolean;
  declineReason?: string;
  category?: CorpayOneCategory;
  departments?: CorpayOneDepartment[];
  lines: CorpayOneExpenseLine[];
  vendor?: CorpayOneVendorShallow;
  fx?: CorpayOneFx;
  paymentMethod?: { id: string; type: string };
  creditor?: { id: string };
  owner?: { user?: { id: string }; team?: { id: string } };
}

/**
 * CorpayOne payment record.
 * NOTE: v3 payment endpoint details are not yet fully confirmed.
 * Payment status can also be inferred from expense.state === 'Paid'
 * and expense.paymentDate being set.
 */
export interface CorpayOnePayment {
  id: string;
  expense_id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  payment_method?: string;
  payment_date?: string;
  reference?: string;
  bank_reference?: string;
  created_at: string;
  updated_at: string;
}

/** CorpayOne paginated list response */
export interface CorpayOnePaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}
