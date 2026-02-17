/** Status of a sync record */
export type SyncStatus = 'pending' | 'synced' | 'failed' | 'skipped';

/** Record of a synced vendor bill */
export interface SyncedBill {
  id: number;
  corpayone_invoice_id: string;
  netsuite_vendor_bill_id: string | null;
  netsuite_vendor_id: string | null;
  status: SyncStatus;
  last_synced_at: string | null;
  error_message: string | null;
  corpayone_status: string;
  corpayone_updated_at: string;
  created_at: string;
  updated_at: string;
}

/** Record of a synced payment */
export interface SyncedPayment {
  id: number;
  corpayone_payment_id: string;
  corpayone_invoice_id: string;
  netsuite_payment_id: string | null;
  netsuite_vendor_bill_id: string | null;
  status: SyncStatus;
  last_synced_at: string | null;
  error_message: string | null;
  corpayone_status: string;
  created_at: string;
  updated_at: string;
}

/** Record of a synced vendor */
export interface SyncedVendor {
  id: number;
  corpayone_vendor_id: string;
  netsuite_vendor_id: string | null;
  vendor_name: string;
  status: SyncStatus;
  last_synced_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/** Sync run log entry */
export interface SyncRun {
  id: number;
  sync_type: 'full' | 'incremental' | 'webhook';
  started_at: string;
  completed_at: string | null;
  bills_processed: number;
  bills_synced: number;
  bills_failed: number;
  payments_processed: number;
  payments_synced: number;
  payments_failed: number;
  error_message: string | null;
}
