import type { CorpayOneExpense, CorpayOnePayment } from '../types/corpayone';

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
  mapExpenseToVendorBill,
  mapPaymentToVendorPayment,
  isSyncableStatus,
  isSyncablePayment,
} from './invoice-mapper';

const mockExpense: CorpayOneExpense = {
  id: 'exp-001',
  type: 'Bill',
  reference: 'INV-2025-001',
  amount: 10000,
  currency: 'DKK',
  state: 'Booked',
  friendlyStatus: 'Booked',
  issueDate: '2025-02-01T00:00:00Z',
  dueDate: '2025-03-01T00:00:00Z',
  category: { id: 'cat-1', name: 'Consulting', number: '5000' },
  vendor: { id: 'vendor-001', name: 'Test Vendor ApS' },
  lines: [
    {
      id: 'line-1',
      category: { id: 'cat-1', name: 'Consulting', number: '5000' },
      amount: 7000,
      note: 'Consulting services Q1',
    },
    {
      id: 'line-2',
      category: { id: 'cat-2', name: 'Office Supplies', number: '5020' },
      amount: 3000,
      note: 'Printer paper and toner',
    },
  ],
};

const mockPayment: CorpayOnePayment = {
  id: 'pay-001',
  expense_id: 'exp-001',
  amount: 10000,
  currency: 'DKK',
  status: 'completed',
  payment_method: 'bank_transfer',
  payment_date: '2025-02-15T00:00:00Z',
  reference: 'PAY-REF-001',
  created_at: '2025-02-15T00:00:00Z',
  updated_at: '2025-02-15T00:00:00Z',
};

describe('mapExpenseToVendorBill', () => {
  it('should map a CorpayOne expense to a NetSuite vendor bill', () => {
    const result = mapExpenseToVendorBill(mockExpense, '42');

    expect(result.entity).toEqual({ id: '42' });
    expect(result.externalId).toBe('corpay-exp-001');
    expect(result.tranId).toBe('INV-2025-001');
    expect(result.tranDate).toBe('02/01/2025');
    expect(result.dueDate).toBe('03/01/2025');
    expect(result.subsidiary).toEqual({ id: '1' });
    expect(result.memo).toContain('INV-2025-001');
    expect(result.memo).toContain('[CorpayOne: exp-001]');
  });

  it('should create multiple expense lines when expense has lines', () => {
    const result = mapExpenseToVendorBill(mockExpense, '42');

    expect(result.expense?.items).toHaveLength(2);
    expect(result.expense?.items[0].amount).toBe(7000);
    expect(result.expense?.items[0].memo).toBe('Consulting services Q1');
    expect(result.expense?.items[1].amount).toBe(3000);
    expect(result.expense?.items[1].memo).toBe('Printer paper and toner');
  });

  it('should create single expense line when no lines present', () => {
    const noLinesExpense: CorpayOneExpense = {
      ...mockExpense,
      lines: [],
    };
    const result = mapExpenseToVendorBill(noLinesExpense, '42');

    expect(result.expense?.items).toHaveLength(1);
    expect(result.expense?.items[0].amount).toBe(10000);
    expect(result.expense?.items[0].memo).toBe('INV-2025-001');
  });

  it('should use AP account as fallback when no mapping exists', () => {
    const result = mapExpenseToVendorBill(mockExpense, '42');

    // With mocked mapping-db returning undefined, falls back to apAccountId
    expect(result.expense?.items[0].account).toEqual({ id: '200' });
    expect(result.expense?.items[1].account).toEqual({ id: '200' });
  });

  it('should not set tax codes (v3 API has no VAT data)', () => {
    const result = mapExpenseToVendorBill(mockExpense, '42');

    expect(result.expense?.items[0].taxCode).toBeUndefined();
    expect(result.expense?.items[0].taxAmount).toBeUndefined();
    expect(result.expense?.items[1].taxCode).toBeUndefined();
    expect(result.expense?.items[1].taxAmount).toBeUndefined();
  });

  it('should use fx.homeAmount when FX data is present', () => {
    const fxExpense: CorpayOneExpense = {
      ...mockExpense,
      lines: [],
      currency: 'EUR',
      amount: 1000,
      fx: {
        homeAmount: 7450,
        foreignAmount: 1000,
        homeCurrency: 'DKK',
        foreignCurrency: 'EUR',
        isForeignFixedCurrency: false,
        exchangeRate: 7.45,
      },
    };
    const result = mapExpenseToVendorBill(fxExpense, '42');

    expect(result.expense?.items).toHaveLength(1);
    expect(result.expense?.items[0].amount).toBe(7450); // homeAmount, not 1000
  });

  it('should handle expense with no reference', () => {
    const noRefExpense: CorpayOneExpense = {
      ...mockExpense,
      reference: undefined,
      lines: [],
    };
    const result = mapExpenseToVendorBill(noRefExpense, '42');

    expect(result.tranId).toBeUndefined();
    expect(result.expense?.items[0].memo).toBe('CorpayOne expense exp-001');
  });
});

describe('mapPaymentToVendorPayment', () => {
  it('should map a CorpayOne payment to a NetSuite vendor payment', () => {
    const result = mapPaymentToVendorPayment(mockPayment, mockExpense, '42', '99');

    expect(result.entity).toEqual({ id: '42' });
    expect(result.externalId).toBe('corpay-pay-pay-001');
    expect(result.tranDate).toBe('02/15/2025');
    expect(result.account).toEqual({ id: '100' });
    expect(result.subsidiary).toEqual({ id: '1' });
    expect(result.memo).toContain('PAY-REF-001');
    expect(result.memo).toContain('INV-2025-001');
  });

  it('should create apply lines for the vendor bill', () => {
    const result = mapPaymentToVendorPayment(mockPayment, mockExpense, '42', '99');

    expect(result.apply?.items).toHaveLength(1);
    expect(result.apply?.items[0]).toEqual({
      apply: true,
      doc: 99,
      amount: 10000,
    });
  });
});

describe('isSyncableStatus', () => {
  it('should return true for Booked expenses', () => {
    expect(isSyncableStatus('Booked')).toBe(true);
  });

  it('should return true for Awaiting expenses', () => {
    expect(isSyncableStatus('Awaiting')).toBe(true);
  });

  it('should return true for Paid expenses', () => {
    expect(isSyncableStatus('Paid')).toBe(true);
  });

  it('should return false for Pending expenses', () => {
    expect(isSyncableStatus('Pending')).toBe(false);
  });

  it('should return false for Cancelled expenses', () => {
    expect(isSyncableStatus('Cancelled')).toBe(false);
  });

  it('should return false for Paused expenses', () => {
    expect(isSyncableStatus('Paused')).toBe(false);
  });

  it('should return false for Duplicate expenses', () => {
    expect(isSyncableStatus('Duplicate')).toBe(false);
  });

  it('should return false for Initialized expenses', () => {
    expect(isSyncableStatus('Initialized')).toBe(false);
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
