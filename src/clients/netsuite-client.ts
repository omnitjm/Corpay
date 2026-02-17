import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
import type {
  NetSuiteVendor,
  NetSuiteVendorBill,
  NetSuiteVendorPayment,
  NetSuiteSuiteQLResponse,
} from '../types/netsuite';

/**
 * Client for the NetSuite SuiteTalk REST API.
 *
 * Uses OAuth 1.0a (Token-Based Authentication) for all requests.
 * Supports creating/reading vendor bills, vendor payments, and vendors.
 *
 * API reference: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/book_1559132836.html
 */
export class NetSuiteClient {
  private accountId: string;
  private consumerKey: string;
  private consumerSecret: string;
  private tokenKey: string;
  private tokenSecret: string;
  private baseUrl: string;

  constructor() {
    this.accountId = config.netsuite.accountId;
    this.consumerKey = config.netsuite.consumerKey;
    this.consumerSecret = config.netsuite.consumerSecret;
    this.tokenKey = config.netsuite.tokenKey;
    this.tokenSecret = config.netsuite.tokenSecret;

    // NetSuite account IDs use underscores in URLs (e.g., 1234567_SB1)
    const accountSlug = this.accountId.replace(/_/g, '-').toLowerCase();
    this.baseUrl = `https://${accountSlug}.suitetalk.api.netsuite.com`;
  }

  /**
   * Generate OAuth 1.0a authorization header for a request.
   * NetSuite uses HMAC-SHA256 signature method.
   */
  private generateOAuthHeader(method: string, url: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA256',
      oauth_timestamp: timestamp,
      oauth_token: this.tokenKey,
      oauth_version: '1.0',
    };

    // Create signature base string
    const parsedUrl = new URL(url);
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

    // Combine OAuth params and query params, sort them
    const allParams = { ...oauthParams };
    parsedUrl.searchParams.forEach((value, key) => {
      allParams[key] = value;
    });

    const paramString = Object.keys(allParams)
      .sort()
      .map(
        (key) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(allParams[key])}`,
      )
      .join('&');

    const signatureBaseString = [
      method.toUpperCase(),
      encodeURIComponent(baseUrl),
      encodeURIComponent(paramString),
    ].join('&');

    // Create signing key
    const signingKey = `${encodeURIComponent(this.consumerSecret)}&${encodeURIComponent(this.tokenSecret)}`;

    // Generate HMAC-SHA256 signature
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(signatureBaseString)
      .digest('base64');

    oauthParams.oauth_signature = signature;

    // Build Authorization header
    const headerParts = Object.keys(oauthParams)
      .sort()
      .map(
        (key) => `${encodeURIComponent(key)}="${encodeURIComponent(oauthParams[key])}"`,
      )
      .join(', ');

    return `OAuth realm="${this.accountId}", ${headerParts}`;
  }

  /** Make an authenticated request to the NetSuite REST API */
  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: this.generateOAuthHeader(method, url),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = { method, headers };
    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    logger.debug({ method, path }, 'NetSuite API request');

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { method, path, status: response.status, error: errorText },
        'NetSuite API error',
      );
      throw new Error(
        `NetSuite API error ${method} ${path} (${response.status}): ${errorText}`,
      );
    }

    // For DELETE or responses with no content
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Create a record and extract the internal ID from the Location header.
   * NetSuite returns a 204 with the new record's URL in the Location header.
   */
  private async createRecord(path: string, body: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: this.generateOAuthHeader('POST', url),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'respond-async, wait=15',
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { path, status: response.status, error: errorText },
        'NetSuite create record error',
      );
      throw new Error(
        `NetSuite create error ${path} (${response.status}): ${errorText}`,
      );
    }

    // Extract internal ID from Location header
    const location = response.headers.get('Location');
    if (location) {
      const idMatch = location.match(/\/(\d+)$/);
      if (idMatch) {
        return idMatch[1];
      }
    }

    // Fallback: try to get ID from response body
    try {
      const responseBody = await response.json();
      if (responseBody && typeof responseBody === 'object' && 'id' in responseBody) {
        return String((responseBody as Record<string, unknown>).id);
      }
    } catch {
      // Response may not have a body
    }

    throw new Error(`Could not extract record ID from NetSuite response for ${path}`);
  }

  // --- Vendor operations ---

  /** Search for a vendor by external ID (CorpayOne vendor ID) */
  async findVendorByExternalId(externalId: string): Promise<NetSuiteVendor | null> {
    try {
      const result = await this.suiteQL<{ id: string; entityid: string; companyname: string }>(
        `SELECT id, entityid, companyname FROM vendor WHERE externalid = '${externalId}'`,
      );
      if (result.items.length > 0) {
        const vendor = result.items[0];
        return {
          id: String(vendor.id),
          entityId: String(vendor.entityid),
          companyName: String(vendor.companyname),
        };
      }
      return null;
    } catch (error) {
      logger.warn({ externalId, error }, 'Failed to find vendor by external ID');
      return null;
    }
  }

  /** Search for a vendor by name */
  async findVendorByName(name: string): Promise<NetSuiteVendor | null> {
    try {
      const escapedName = name.replace(/'/g, "''");
      const result = await this.suiteQL<{ id: string; entityid: string; companyname: string }>(
        `SELECT id, entityid, companyname FROM vendor WHERE companyname = '${escapedName}'`,
      );
      if (result.items.length > 0) {
        const vendor = result.items[0];
        return {
          id: String(vendor.id),
          entityId: String(vendor.entityid),
          companyName: String(vendor.companyname),
        };
      }
      return null;
    } catch (error) {
      logger.warn({ name, error }, 'Failed to find vendor by name');
      return null;
    }
  }

  /** Create a vendor in NetSuite */
  async createVendor(vendor: Partial<NetSuiteVendor>): Promise<string> {
    const body: Record<string, unknown> = {};
    if (vendor.companyName) body.companyName = vendor.companyName;
    if (vendor.entityId) body.entityId = vendor.entityId;
    if (vendor.email) body.email = vendor.email;
    if (vendor.phone) body.phone = vendor.phone;
    if (vendor.taxIdNum) body.taxIdNum = vendor.taxIdNum;
    if (vendor.externalId) body.externalId = vendor.externalId;
    if (vendor.subsidiary) body.subsidiary = vendor.subsidiary;

    const id = await this.createRecord('/services/rest/record/v1/vendor', body);
    logger.info({ vendorId: id, name: vendor.companyName }, 'Created vendor in NetSuite');
    return id;
  }

  // --- Vendor Bill operations ---

  /** Create a vendor bill in NetSuite */
  async createVendorBill(bill: NetSuiteVendorBill): Promise<string> {
    const body: Record<string, unknown> = {
      entity: bill.entity,
    };

    if (bill.tranId) body.tranId = bill.tranId;
    if (bill.tranDate) body.tranDate = bill.tranDate;
    if (bill.dueDate) body.dueDate = bill.dueDate;
    if (bill.subsidiary) body.subsidiary = bill.subsidiary;
    if (bill.currency) body.currency = bill.currency;
    if (bill.exchangeRate) body.exchangeRate = bill.exchangeRate;
    if (bill.account) body.account = bill.account;
    if (bill.memo) body.memo = bill.memo;
    if (bill.externalId) body.externalId = bill.externalId;
    if (bill.expense) body.expense = bill.expense;
    if (bill.item) body.item = bill.item;

    const id = await this.createRecord('/services/rest/record/v1/vendorBill', body);
    logger.info(
      { vendorBillId: id, externalId: bill.externalId },
      'Created vendor bill in NetSuite',
    );
    return id;
  }

  /** Get a vendor bill by internal ID */
  async getVendorBill(id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/services/rest/record/v1/vendorBill/${id}`,
    );
  }

  /** Find a vendor bill by external ID (CorpayOne invoice ID) */
  async findVendorBillByExternalId(externalId: string): Promise<{ id: string } | null> {
    try {
      const result = await this.suiteQL<{ id: string }>(
        `SELECT id FROM transaction WHERE type = 'VendBill' AND externalid = '${externalId}'`,
      );
      if (result.items.length > 0) {
        return { id: String(result.items[0].id) };
      }
      return null;
    } catch {
      return null;
    }
  }

  // --- Vendor Payment operations ---

  /** Create a vendor payment (bill payment) in NetSuite */
  async createVendorPayment(payment: NetSuiteVendorPayment): Promise<string> {
    const body: Record<string, unknown> = {
      entity: payment.entity,
    };

    if (payment.account) body.account = payment.account;
    if (payment.tranDate) body.tranDate = payment.tranDate;
    if (payment.subsidiary) body.subsidiary = payment.subsidiary;
    if (payment.currency) body.currency = payment.currency;
    if (payment.memo) body.memo = payment.memo;
    if (payment.externalId) body.externalId = payment.externalId;
    if (payment.apply) body.apply = payment.apply;

    const id = await this.createRecord('/services/rest/record/v1/vendorPayment', body);
    logger.info(
      { paymentId: id, externalId: payment.externalId },
      'Created vendor payment in NetSuite',
    );
    return id;
  }

  /** Find a vendor payment by external ID */
  async findVendorPaymentByExternalId(externalId: string): Promise<{ id: string } | null> {
    try {
      const result = await this.suiteQL<{ id: string }>(
        `SELECT id FROM transaction WHERE type = 'VendPymt' AND externalid = '${externalId}'`,
      );
      if (result.items.length > 0) {
        return { id: String(result.items[0].id) };
      }
      return null;
    } catch {
      return null;
    }
  }

  // --- SuiteQL ---

  /** Execute a SuiteQL query */
  async suiteQL<T = Record<string, unknown>>(
    query: string,
    limit = 1000,
    offset = 0,
  ): Promise<NetSuiteSuiteQLResponse & { items: T[] }> {
    const url = `${this.baseUrl}/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;

    const headers: Record<string, string> = {
      Authorization: this.generateOAuthHeader('POST', url),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'transient',
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ q: query }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`NetSuite SuiteQL error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<NetSuiteSuiteQLResponse & { items: T[] }>;
  }
}
