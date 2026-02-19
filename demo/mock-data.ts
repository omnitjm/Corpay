/**
 * Mock data representing realistic CorpayOne invoices, payments, and vendors,
 * and their expected NetSuite counterparts.
 *
 * Note: CorpayOne's API only returns invoice-level totals — no line items.
 */
import type { CorpayOneInvoice, CorpayOnePayment, CorpayOneVendor } from '../src/types/corpayone';

// ─── Vendors ───────────────────────────────────────────────────────

export const vendors: Record<string, CorpayOneVendor> = {
  'vendor-001': {
    id: 'vendor-001',
    name: 'TechSupply ApS',
    email: 'faktura@techsupply.dk',
    phone: '+45 70 20 30 40',
    vat_number: 'DK12345678',
    registration_number: '12345678',
    address: {
      street: 'Vestergade 12',
      city: 'Copenhagen',
      zip: '1456',
      country: 'DK',
    },
    bank_account: {
      iban: 'DK5000400440116243',
      swift: 'DABADKKK',
    },
    created_at: '2025-01-15T10:00:00Z',
    updated_at: '2025-01-15T10:00:00Z',
  },
  'vendor-002': {
    id: 'vendor-002',
    name: 'CloudHost GmbH',
    email: 'billing@cloudhost.de',
    phone: '+49 30 1234567',
    vat_number: 'DE987654321',
    address: {
      street: 'Berliner Str. 42',
      city: 'Berlin',
      zip: '10115',
      country: 'DE',
    },
    bank_account: {
      iban: 'DE89370400440532013000',
      swift: 'COBADEFFXXX',
    },
    created_at: '2025-02-01T08:30:00Z',
    updated_at: '2025-02-01T08:30:00Z',
  },
  'vendor-003': {
    id: 'vendor-003',
    name: 'Office Solutions Ltd',
    email: 'accounts@officesolutions.co.uk',
    phone: '+44 20 7946 0958',
    vat_number: 'GB123456789',
    address: {
      street: '10 Downing Business Park',
      city: 'London',
      zip: 'SW1A 2AA',
      country: 'GB',
    },
    created_at: '2025-03-10T14:00:00Z',
    updated_at: '2025-03-10T14:00:00Z',
  },
};

// ─── Invoices ──────────────────────────────────────────────────────

export const invoices: CorpayOneInvoice[] = [
  {
    id: 'inv-1001',
    invoice_number: 'TS-2025-0042',
    vendor: vendors['vendor-001'],
    status: 'approved',
    currency: 'DKK',
    subtotal: 8000,
    vat_amount: 2000,
    total_amount: 10000,
    due_date: '2025-03-15T00:00:00Z',
    invoice_date: '2025-02-15T00:00:00Z',
    description: 'IT Equipment - Q1 2025',
    reference: 'PO-2025-101',
    po_number: 'PO-2025-101',
    category: 'IT Equipment',
    labels: ['IT', 'Q1-2025'],
    created_at: '2025-02-15T09:00:00Z',
    updated_at: '2025-02-16T11:30:00Z',
  },
  {
    id: 'inv-1002',
    invoice_number: 'CH-8834',
    vendor: vendors['vendor-002'],
    status: 'approved',
    currency: 'EUR',
    subtotal: 2500,
    vat_amount: 475,
    total_amount: 2975,
    due_date: '2025-04-01T00:00:00Z',
    invoice_date: '2025-03-01T00:00:00Z',
    description: 'Cloud hosting services - March 2025',
    category: 'Cloud Services',
    labels: ['Infrastructure'],
    created_at: '2025-03-01T08:00:00Z',
    updated_at: '2025-03-02T10:00:00Z',
  },
  {
    id: 'inv-1003',
    invoice_number: 'OS-2025-771',
    vendor: vendors['vendor-003'],
    status: 'paid',
    currency: 'GBP',
    subtotal: 1200,
    vat_amount: 240,
    total_amount: 1440,
    due_date: '2025-03-20T00:00:00Z',
    invoice_date: '2025-02-20T00:00:00Z',
    description: 'Office furniture delivery',
    category: 'Office Furniture',
    created_at: '2025-02-20T14:00:00Z',
    updated_at: '2025-03-18T09:00:00Z',
  },
  {
    id: 'inv-1004',
    invoice_number: 'DRAFT-99',
    vendor: vendors['vendor-001'],
    status: 'draft',
    currency: 'DKK',
    subtotal: 500,
    vat_amount: 125,
    total_amount: 625,
    due_date: '2025-04-15T00:00:00Z',
    invoice_date: '2025-03-15T00:00:00Z',
    description: 'Miscellaneous supplies (draft)',
    created_at: '2025-03-15T12:00:00Z',
    updated_at: '2025-03-15T12:00:00Z',
  },
];

// ─── Payments ──────────────────────────────────────────────────────

export const payments: CorpayOnePayment[] = [
  {
    id: 'pay-2001',
    invoice_id: 'inv-1003',
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
    invoice_id: 'inv-1001',
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
