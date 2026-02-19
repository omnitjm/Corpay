import { config } from '../config';
import { logger } from '../logger';
import type {
  CorpayOneTokenResponse,
  CorpayOneExpense,
  CorpayOnePayment,
  CorpayOnePaginatedResponse,
} from '../types/corpayone';

/**
 * Client for the CorpayOne API v3.
 *
 * Auth: OAuth2 client credentials via https://identity.corpayone.com/connect/token
 * Base URL: https://api.corpayone.com
 * Swagger: https://api.corpayone.com/docs/index.html
 *
 * Required scopes:
 *   expenses.list, expenses.read  — to fetch expenses (vendor bills)
 *   payments.all                  — to fetch payments
 *   teams.vendors.all             — to read vendor data
 */
export class CorpayOneClient {
  private baseUrl: string;
  private clientId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  /** CorpayOne identity server token endpoint */
  private readonly tokenUrl = 'https://identity.corpayone.com/connect/token';

  constructor() {
    this.baseUrl = config.corpayone.apiBaseUrl;
    this.clientId = config.corpayone.clientId;
    this.clientSecret = config.corpayone.clientSecret;
  }

  /** Authenticate with CorpayOne using OAuth2 client credentials */
  private async authenticate(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return;
    }

    logger.debug('Authenticating with CorpayOne API...');

    const response = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'expenses.list expenses.read payments.all teams.vendors.all',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`CorpayOne authentication failed (${response.status}): ${errorText}`);
    }

    const tokenData = (await response.json()) as CorpayOneTokenResponse;
    this.accessToken = tokenData.access_token;
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
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
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
      throw new Error(`CorpayOne API error ${method} ${path} (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Fetch a page of expenses (vendor bills) from CorpayOne.
   * API: GET /external/v3/expenses
   *
   * @param options.page        - Page number (1-based)
   * @param options.perPage     - Items per page (max 100)
   * @param options.state       - Filter by expense state (e.g. 'Booked', 'Paid')
   */
  async getExpenses(options: {
    page?: number;
    perPage?: number;
    state?: string;
  } = {}): Promise<CorpayOnePaginatedResponse<CorpayOneExpense>> {
    const params: Record<string, string> = {};
    if (options.page) params.page = String(options.page);
    if (options.perPage) params.per_page = String(options.perPage);
    if (options.state) params.state = options.state;

    return this.request<CorpayOnePaginatedResponse<CorpayOneExpense>>(
      'GET',
      '/external/v3/expenses',
      undefined,
      params,
    );
  }

  /**
   * Fetch all expenses using pagination, collecting every page.
   */
  async getAllExpenses(options: {
    state?: string;
  } = {}): Promise<CorpayOneExpense[]> {
    const all: CorpayOneExpense[] = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getExpenses({ page, perPage, ...options });
      all.push(...response.data);
      hasMore = page < response.pagination.total_pages;
      page++;
    }

    logger.info({ count: all.length }, 'Fetched all expenses from CorpayOne');
    return all;
  }

  /**
   * Fetch a single expense by ID.
   * API: GET /external/v3/expenses/{expenseId}
   * Response is wrapped: { data: ExpenseResponse }
   */
  async getExpense(expenseId: string): Promise<CorpayOneExpense> {
    const response = await this.request<{ data: CorpayOneExpense }>(
      'GET',
      `/external/v3/expenses/${expenseId}`,
    );
    return response.data;
  }

  /**
   * Fetch payments from CorpayOne.
   * NOTE: The exact v3 payment list endpoint is pending confirmation.
   */
  async getPayments(options: {
    page?: number;
    perPage?: number;
    expenseId?: string;
  } = {}): Promise<CorpayOnePaginatedResponse<CorpayOnePayment>> {
    const params: Record<string, string> = {};
    if (options.page) params.page = String(options.page);
    if (options.perPage) params.per_page = String(options.perPage);
    if (options.expenseId) params.expense_id = options.expenseId;

    return this.request<CorpayOnePaginatedResponse<CorpayOnePayment>>(
      'GET',
      '/external/v3/payments',
      undefined,
      params,
    );
  }

  /** Fetch all payments using pagination */
  async getAllPayments(options: {
    expenseId?: string;
  } = {}): Promise<CorpayOnePayment[]> {
    const all: CorpayOnePayment[] = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getPayments({ page, perPage, ...options });
      all.push(...response.data);
      hasMore = page < response.pagination.total_pages;
      page++;
    }

    logger.info({ count: all.length }, 'Fetched all payments from CorpayOne');
    return all;
  }

  /** Fetch a single payment by ID */
  async getPayment(paymentId: string): Promise<CorpayOnePayment> {
    const response = await this.request<{ data: CorpayOnePayment }>(
      'GET',
      `/external/v3/payments/${paymentId}`,
    );
    return response.data;
  }
}
