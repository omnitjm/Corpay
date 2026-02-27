/** NetSuite record reference (used for linked records like entity, subsidiary, etc.) */
export interface NetSuiteRef {
  id: string;
  refName?: string;
}

/** NetSuite vendor record */
export interface NetSuiteVendor {
  id?: string;
  entityId?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  taxIdNum?: string;
  subsidiary?: NetSuiteRef;
  externalId?: string;
}

/** NetSuite vendor bill expense line */
export interface NetSuiteExpenseLine {
  account: NetSuiteRef;
  amount: number;
  memo?: string;
  department?: NetSuiteRef;
  class?: NetSuiteRef;
  location?: NetSuiteRef;
  taxCode?: NetSuiteRef;
  taxAmount?: number;
}

/** NetSuite vendor bill item line */
export interface NetSuiteItemLine {
  item: NetSuiteRef;
  quantity?: number;
  rate?: number;
  amount?: number;
  description?: string;
  department?: NetSuiteRef;
  class?: NetSuiteRef;
  location?: NetSuiteRef;
  taxCode?: NetSuiteRef;
}

/** NetSuite vendor bill record for creation */
export interface NetSuiteVendorBill {
  id?: string;
  entity: NetSuiteRef;
  tranId?: string;
  tranDate?: string;
  dueDate?: string;
  subsidiary?: NetSuiteRef;
  currency?: NetSuiteRef;
  exchangeRate?: number;
  account?: NetSuiteRef;
  memo?: string;
  externalId?: string;
  expense?: {
    items: NetSuiteExpenseLine[];
  };
  item?: {
    items: NetSuiteItemLine[];
  };
}

/** NetSuite vendor payment apply line */
export interface NetSuiteApplyLine {
  apply: boolean;
  doc: number;
  amount: number;
  refNum?: string;
}

/** NetSuite vendor payment record for creation */
export interface NetSuiteVendorPayment {
  id?: string;
  entity: NetSuiteRef;
  account?: NetSuiteRef;
  tranDate?: string;
  subsidiary?: NetSuiteRef;
  currency?: NetSuiteRef;
  memo?: string;
  externalId?: string;
  apply?: {
    items: NetSuiteApplyLine[];
  };
}

/** NetSuite API error response */
export interface NetSuiteError {
  type: string;
  title: string;
  status: number;
  'o:errorDetails'?: Array<{
    detail: string;
    'o:errorCode': string;
  }>;
}

/** NetSuite SuiteQL query response */
export interface NetSuiteSuiteQLResponse {
  links?: Array<{ rel: string; href: string }>;
  count?: number;
  hasMore?: boolean;
  offset?: number;
  totalResults?: number;
  items: Record<string, unknown>[];
}
