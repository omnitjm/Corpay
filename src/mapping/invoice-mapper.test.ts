import type { CorpayOneInvoice, CorpayOnePayment } from '../types/corpayone';

// Mock config
jest.mock('../config', () => ({
  config: {
    netsuite: {
      apAccountId: '200',
      bankAccountId: '100',
      subsidiaryId: '1',
    },
    database: {
      path: ':memory:',
    },
    logLevel: 'warn',
  },
}));

// Mock the logger to avoid pino init issues in tests
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
  },
}));

// Mock the mapping-db module — return undefined for all lookups
// so the mapper falls back to static config values
jest.mock('../database/mapping-db', () => ({
  getAccountMapping: jest.fn().mockReturnValue(undefined),
  getTaxCodeMapping: jest.fn().mockReturnValue(undefined),
  getBankAccountConfig: jest.fn().mockReturnValue(undefined),
  getSubsidiaryConfig: jest.fn().mockReturnValue(undefined),
}));

import {
  mapInvoiceToVendorBill,
  mapPaymentToVendorPayment,
  isSyncableStatus,
  isSyncablePayment,
} from './invoice-mapper';

const mockInvoice: CorpayOneInvoice = {
  id: 'inv-001',
  invoice_number: 'INV-2025-001',
  vendor: {
    id: 'vendor-001',
    name: 'Test Vendor ApS',
    email: 'vendor@test.dk',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  },
  status: 'approved',
  currency: 'DKK',
  subtotal: 8000,
  vat_amount: 2000,
  total_amount: 10000,
  due_date: '2025-03-01T00:00:00Z',
  invoice_date: '2025-02-01T00:00:00Z',
  description: 'Consulting services',
  reference: 'REF-123',
  po_number: 'PO-456',
  category: 'Consulting',
  created_at: '2025-02-01T00:00:00Z',
  updated_at: '2025-02-01T00:00:00Z',
};

const mockPayment: CorpayOnePayment = {
  id: 'pay-001',
  invoice_id: 'inv-001',
  amount: 10000,
  currency: 'DKK',
  status: 'completed',
  payment_method: 'bank_transfer',
  payment_date: '2025-02-15T00:00:00Z',
  reference: 'PAY-REF-001',
  created_at: '2025-02-15T00:00:00Z',
  updated_at: '2025-02-15T00:00:00Z',
};

describe('mapInvoiceToVendorBill', () => {
  it('should map a CorpayOne invoice to a NetSuite vendor bill', () => {
    const result = mapInvoiceToVendorBill(mockInvoice, '42');

    expect(result.entity).toEqual({ id: '42' });
    expect(result.externalId).toBe('corpay-inv-001');
    expect(result.tranId).toBe('INV-2025-001');
    expect(result.tranDate).toBe('02/01/2025');
    expect(result.dueDate).toBe('03/01/2025');
    expect(result.subsidiary).toEqual({ id: '1' });
    expect(result.memo).toContain('Consulting services');
    expect(result.memo).toContain('REF-123');
    expect(result.memo).toContain('PO-456');
    expect(result.memo).toContain('[CorpayOne: inv-001]');
  });

  it('should always create exactly one expense line from invoice totals', () => {
    const result = mapInvoiceToVendorBill(mockInvoice, '42');

    expect(result.expense?.items).toHaveLength(1);
    expect(result.expense?.items[0].amount).toBe(8000); // subtotal
    expect(result.expense?.items[0].taxAmount).toBe(2000); // vat_amount
    expect(result.expense?.items[0].memo).toBe('Consulting services');
  });

  it('should use AP account as fallback when no mapping exists', () => {
    const result = mapInvoiceToVendorBill(mockInvoice, '42');

    expect(result.expense?.items[0].account).toEqual({ id: '200' });
  });

  it('should compute implied VAT rate for tax code lookup', () => {
    // 2000 / 8000 = 25% → should attempt to resolve tax code for 25%
    const result = mapInvoiceToVendorBill(mockInvoice, '42');

    // With mocked mapping-db returning undefined, no taxCode is set
    expect(result.expense?.items[0].taxCode).toBeUndefined();
    // But taxAmount is always passed through
    expect(result.expense?.items[0].taxAmount).toBe(2000);
  });

  it('should handle invoice with zero VAT', () => {
    const noVatInvoice = { ...mockInvoice, vat_amount: 0, total_amount: 8000 };
    const result = mapInvoiceToVendorBill(noVatInvoice, '42');

    expect(result.expense?.items).toHaveLength(1);
    expect(result.expense?.items[0].amount).toBe(8000);
    expect(result.expense?.items[0].taxAmount).toBeUndefined();
  });
});

describe('mapPaymentToVendorPayment', () => {
  it('should map a CorpayOne payment to a NetSuite vendor payment', () => {
    const result = mapPaymentToVendorPayment(mockPayment, mockInvoice, '42', '99');

    expect(result.entity).toEqual({ id: '42' });
    expect(result.externalId).toBe('corpay-pay-pay-001');
    expect(result.tranDate).toBe('02/15/2025');
    expect(result.account).toEqual({ id: '100' });
    expect(result.subsidiary).toEqual({ id: '1' });
    expect(result.memo).toContain('PAY-REF-001');
    expect(result.memo).toContain('INV-2025-001');
  });

  it('should create apply lines for the vendor bill', () => {
    const result = mapPaymentToVendorPayment(mockPayment, mockInvoice, '42', '99');

    expect(result.apply?.items).toHaveLength(1);
    expect(result.apply?.items[0]).toEqual({
      apply: true,
      doc: 99,
      amount: 10000,
    });
  });
});

describe('isSyncableStatus', () => {
  it('should return true for approved invoices', () => {
    expect(isSyncableStatus('approved')).toBe(true);
  });

  it('should return true for scheduled invoices', () => {
    expect(isSyncableStatus('scheduled')).toBe(true);
  });

  it('should return true for paid invoices', () => {
    expect(isSyncableStatus('paid')).toBe(true);
  });

  it('should return true for partially paid invoices', () => {
    expect(isSyncableStatus('partially_paid')).toBe(true);
  });

  it('should return false for draft invoices', () => {
    expect(isSyncableStatus('draft')).toBe(false);
  });

  it('should return false for pending approval invoices', () => {
    expect(isSyncableStatus('pending_approval')).toBe(false);
  });

  it('should return false for rejected invoices', () => {
    expect(isSyncableStatus('rejected')).toBe(false);
  });

  it('should return false for cancelled invoices', () => {
    expect(isSyncableStatus('cancelled')).toBe(false);
  });
});

describe('isSyncablePayment', () => {
  it('should return true for completed payments', () => {
    expect(isSyncablePayment(mockPayment)).toBe(true);
  });

  it('should return false for pending payments', () => {
    expect(isSyncablePayment({ ...mockPayment, status: 'pending' })).toBe(false);
  });

  it('should return false for failed payments', () => {
    expect(isSyncablePayment({ ...mockPayment, status: 'failed' })).toBe(false);
  });
});
