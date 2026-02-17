import { config } from '../config';
import { logger } from '../logger';
import type {
  CorpayOneTokenResponse,
  CorpayOneInvoice,
  CorpayOnePayment,
  CorpayOnePaginatedResponse,
} from '../types/corpayone';

/**
 * Client for the CorpayOne API.
 *
 * Handles OAuth2 authentication and provides methods for fetching
 * invoices (vendor bills) and payment records from CorpayOne.
 *
 * API reference: https://developers.corpayone.com/
 * Swagger docs: https://api.corpayone.com/docs/index.html
 */
export class CorpayOneClient {
  private baseUrl: string;
  private clientId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    this.baseUrl = config.corpayone.apiBaseUrl;
    this.clientId = config.corpayone.clientId;
    this.clientSecret = config.corpayone.clientSecret;
  }

  /** Authenticate with CorpayOne using OAuth2 client credentials flow */
  private async authenticate(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return; // Token still valid
    }

    logger.debug('Authenticating with CorpayOne API...');

    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `CorpayOne authentication failed (${response.status}): ${errorText}`,
      );
    }

    const tokenData = (await response.json()) as CorpayOneTokenResponse;
    this.accessToken = tokenData.access_token;
    // Refresh 60 seconds before actual expiry
    this.tokenExpiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;

    logger.debug('CorpayOne authentication successful');
  }

  /** Make an authenticated request to the CorpayOne API */
  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string>,
  ): Promise<T> {
    await this.authenticate();

    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json',
    };

    const fetchOptions: RequestInit = { method, headers };

    if (body) {
      headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `CorpayOne API error ${method} ${path} (${response.status}): ${errorText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Fetch invoices (vendor bills) from CorpayOne.
   *
   * @param options.page - Page number (1-based)
   * @param options.perPage - Items per page
   * @param options.updatedSince - ISO datetime string to filter invoices updated after this time
   * @param options.status - Filter by invoice status
   */
  async getInvoices(options: {
    page?: number;
    perPage?: number;
    updatedSince?: string;
    status?: string;
  } = {}): Promise<CorpayOnePaginatedResponse<CorpayOneInvoice>> {
    const params: Record<string, string> = {};
    if (options.page) params.page = String(options.page);
    if (options.perPage) params.per_page = String(options.perPage);
    if (options.updatedSince) params.updated_since = options.updatedSince;
    if (options.status) params.status = options.status;

    return this.request<CorpayOnePaginatedResponse<CorpayOneInvoice>>(
      'GET',
      '/v1/invoices',
      undefined,
      params,
    );
  }

  /**
   * Fetch all invoices using pagination.
   * Iterates through all pages to collect every invoice matching the criteria.
   */
  async getAllInvoices(options: {
    updatedSince?: string;
    status?: string;
  } = {}): Promise<CorpayOneInvoice[]> {
    const allInvoices: CorpayOneInvoice[] = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getInvoices({
        page,
        perPage,
        ...options,
      });

      allInvoices.push(...response.data);

      hasMore = page < response.pagination.total_pages;
      page++;
    }

    logger.info({ count: allInvoices.length }, 'Fetched all invoices from CorpayOne');
    return allInvoices;
  }

  /** Fetch a single invoice by ID */
  async getInvoice(invoiceId: string): Promise<CorpayOneInvoice> {
    return this.request<CorpayOneInvoice>('GET', `/v1/invoices/${invoiceId}`);
  }

  /**
   * Fetch payments from CorpayOne.
   *
   * @param options.page - Page number
   * @param options.perPage - Items per page
   * @param options.invoiceId - Filter payments for a specific invoice
   * @param options.updatedSince - ISO datetime string
   */
  async getPayments(options: {
    page?: number;
    perPage?: number;
    invoiceId?: string;
    updatedSince?: string;
  } = {}): Promise<CorpayOnePaginatedResponse<CorpayOnePayment>> {
    const params: Record<string, string> = {};
    if (options.page) params.page = String(options.page);
    if (options.perPage) params.per_page = String(options.perPage);
    if (options.invoiceId) params.invoice_id = options.invoiceId;
    if (options.updatedSince) params.updated_since = options.updatedSince;

    return this.request<CorpayOnePaginatedResponse<CorpayOnePayment>>(
      'GET',
      '/v1/payments',
      undefined,
      params,
    );
  }

  /** Fetch all payments using pagination */
  async getAllPayments(options: {
    invoiceId?: string;
    updatedSince?: string;
  } = {}): Promise<CorpayOnePayment[]> {
    const allPayments: CorpayOnePayment[] = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getPayments({
        page,
        perPage,
        ...options,
      });

      allPayments.push(...response.data);

      hasMore = page < response.pagination.total_pages;
      page++;
    }

    logger.info({ count: allPayments.length }, 'Fetched all payments from CorpayOne');
    return allPayments;
  }

  /** Fetch a single payment by ID */
  async getPayment(paymentId: string): Promise<CorpayOnePayment> {
    return this.request<CorpayOnePayment>('GET', `/v1/payments/${paymentId}`);
  }

  /** Fetch payments for a specific invoice */
  async getPaymentsForInvoice(invoiceId: string): Promise<CorpayOnePayment[]> {
    return this.getAllPayments({ invoiceId });
  }
}
