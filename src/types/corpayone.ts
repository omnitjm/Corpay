/** CorpayOne OAuth token response */
export interface CorpayOneTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** CorpayOne vendor/supplier */
export interface CorpayOneVendor {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  vat_number?: string;
  registration_number?: string;
  address?: {
    street?: string;
    city?: string;
    zip?: string;
    country?: string;
  };
  bank_account?: {
    iban?: string;
    swift?: string;
    account_number?: string;
    registration_number?: string;
  };
  created_at: string;
  updated_at: string;
}

/** CorpayOne invoice/bill status */
export type CorpayOneInvoiceStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'scheduled'
  | 'paid'
  | 'partially_paid'
  | 'overdue'
  | 'cancelled'
  | 'voided';

/**
 * CorpayOne invoice/bill (vendor bill).
 *
 * Note: CorpayOne's API only exposes invoice-level totals.
 * There is no line-item detail — each invoice maps to a single
 * expense line in NetSuite.
 */
export interface CorpayOneInvoice {
  id: string;
  invoice_number?: string;
  vendor: CorpayOneVendor;
  status: CorpayOneInvoiceStatus;
  currency: string;
  subtotal: number;
  vat_amount: number;
  total_amount: number;
  due_date?: string;
  invoice_date?: string;
  payment_date?: string;
  description?: string;
  reference?: string;
  po_number?: string;
  /** Expense category (e.g. "IT Equipment", "Cloud Services") — used for GL account mapping */
  category?: string;
  attachments?: Array<{
    id: string;
    filename: string;
    url: string;
    content_type: string;
  }>;
  labels?: string[];
  approval_status?: string;
  created_at: string;
  updated_at: string;
}

/** CorpayOne payment record */
export interface CorpayOnePayment {
  id: string;
  invoice_id: string;
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

/** CorpayOne paginated response */
export interface CorpayOnePaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}
