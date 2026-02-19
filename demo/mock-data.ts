/**
 * Mock data representing realistic CorpayOne v3 API responses.
 *
 * Reflects the actual v3 API structure:
 *   - Expenses (not invoices): GET /external/v3/expenses
 *   - Lines array with category + amount per line (no VAT in API)
 *   - State enum: Booked, Awaiting, Paid, Pending, Cancelled, etc.
 *   - Vendor is shallow: only id/name/externalId
 */
import type { CorpayOneExpense, CorpayOnePayment } from '../src/types/corpayone';

// ─── Expenses ──────────────────────────────────────────────────────

export const expenses: CorpayOneExpense[] = [
  {
    // Multi-line expense — 2 split lines across different categories
    id: 'exp-1001',
    type: 'Bill',
    reference: 'TS-2025-0042',
    amount: 10000,
    currency: 'DKK',
    state: 'Booked',
    friendlyStatus: 'Booked',
    issueDate: '2025-02-15T00:00:00Z',
    dueDate: '2025-03-15T00:00:00Z',
    category: { id: 'cat-1', name: 'IT Equipment', number: '5010' },
    vendor: { id: 'vendor-001', name: 'TechSupply ApS', externalId: 'corpay-vendor-001' },
    lines: [
      {
        id: 'line-1',
        category: { id: 'cat-1', name: 'IT Equipment', number: '5010' },
        amount: 7500,
        note: 'Dell Latitude 5550 Laptop x2',
      },
      {
        id: 'line-2',
        category: { id: 'cat-2', name: 'Office Supplies', number: '5020' },
        amount: 2500,
        note: 'Logitech MX Master 3S Mouse x4',
      },
    ],
  },
  {
    // Single-line expense — no line splits
    id: 'exp-1002',
    type: 'Bill',
    reference: 'CH-8834',
    amount: 2975,
    currency: 'EUR',
    state: 'Awaiting',
    friendlyStatus: 'Awaiting',
    issueDate: '2025-03-01T00:00:00Z',
    dueDate: '2025-04-01T00:00:00Z',
    category: { id: 'cat-3', name: 'Cloud Services', number: '6100' },
    vendor: { id: 'vendor-002', name: 'CloudHost GmbH', externalId: 'corpay-vendor-002' },
    lines: [],
  },
  {
    // Paid expense — payment already settled
    id: 'exp-1003',
    type: 'Bill',
    reference: 'OS-2025-771',
    amount: 1440,
    currency: 'GBP',
    state: 'Paid',
    friendlyStatus: 'Paid',
    issueDate: '2025-02-20T00:00:00Z',
    dueDate: '2025-03-20T00:00:00Z',
    paymentDate: '2025-03-18T09:00:00Z',
    category: { id: 'cat-4', name: 'Office Furniture', number: '5030' },
    vendor: { id: 'vendor-003', name: 'Office Solutions Ltd', externalId: 'corpay-vendor-003' },
    lines: [
      {
        id: 'line-5',
        category: { id: 'cat-4', name: 'Office Furniture', number: '5030' },
        amount: 1440,
        note: 'Standing desk - Flexispot E7 x2',
      },
    ],
  },
  {
    // Pending (draft) — should be skipped
    id: 'exp-1004',
    type: 'Bill',
    reference: 'DRAFT-99',
    amount: 625,
    currency: 'DKK',
    state: 'Pending',
    friendlyStatus: 'Pending',
    issueDate: '2025-03-15T00:00:00Z',
    dueDate: '2025-04-15T00:00:00Z',
    vendor: { id: 'vendor-001', name: 'TechSupply ApS' },
    lines: [],
  },
];

// ─── Payments ──────────────────────────────────────────────────────

export const payments: CorpayOnePayment[] = [
  {
    id: 'pay-2001',
    expense_id: 'exp-1003',
    amount: 1440,
    currency: 'GBP',
    status: 'completed',
    payment_method: 'bank_transfer',
    payment_date: '2025-03-18T09:00:00Z',
    reference: 'BACS-2025-0318-001',
    bank_reference: 'REF-GBP-001',
    created_at: '2025-03-18T09:00:00Z',
    updated_at: '2025-03-18T09:05:00Z',
  },
  {
    id: 'pay-2002',
    expense_id: 'exp-1001',
    amount: 10000,
    currency: 'DKK',
    status: 'pending',
    payment_method: 'bank_transfer',
    payment_date: '2025-03-15T00:00:00Z',
    reference: 'NETS-2025-0315-042',
    created_at: '2025-03-15T10:00:00Z',
    updated_at: '2025-03-15T10:00:00Z',
  },
];

// ─── NetSuite mock records (pre-existing in the mock) ──────────────

export const netsuiteAccounts = {
  '152': { id: '152', name: 'CorpayOne Bank Account (DKK)', type: 'Bank' },
  '153': { id: '153', name: 'CorpayOne Bank Account (EUR)', type: 'Bank' },
  '154': { id: '154', name: 'CorpayOne Bank Account (GBP)', type: 'Bank' },
  '201': { id: '201', name: 'IT Equipment', type: 'Expense' },
  '202': { id: '202', name: 'Office Supplies', type: 'Expense' },
  '203': { id: '203', name: 'Office Furniture', type: 'Expense' },
  '301': { id: '301', name: 'Cloud & Hosting Services', type: 'Expense' },
  '400': { id: '400', name: 'Accounts Payable', type: 'Other Current Liability' },
};

export const netsuiteTaxCodes = {
  'DK-S-25': { id: 'DK-S-25', name: 'DK Moms 25%', rate: 25 },
  'DE-S-19': { id: 'DE-S-19', name: 'DE Umsatzsteuer 19%', rate: 19 },
  'GB-S-20': { id: 'GB-S-20', name: 'GB VAT 20%', rate: 20 },
};

export const netsuiteSubsidiaries = {
  '1': { id: '1', name: 'Corpay Denmark ApS' },
  '2': { id: '2', name: 'Corpay Europe GmbH' },
};
