import { NetSuiteClient } from './netsuite-client';

// Mock config
jest.mock('../config', () => ({
  config: {
    netsuite: {
      accountId: 'TSTDRV12345',
      consumerKey: 'test-consumer-key',
      consumerSecret: 'test-consumer-secret',
      tokenKey: 'test-token-key',
      tokenSecret: 'test-token-secret',
      subsidiaryId: '1',
      apAccountId: '200',
      bankAccountId: '100',
    },
    logLevel: 'silent',
  },
}));

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('NetSuiteClient', () => {
  let client: NetSuiteClient;

  beforeEach(() => {
    client = new NetSuiteClient();
  });

  it('should construct the correct base URL from account ID', () => {
    // Access private field via any for testing
    const baseUrl = (client as unknown as { baseUrl: string }).baseUrl;
    expect(baseUrl).toBe('https://tstdrv12345.suitetalk.api.netsuite.com');
  });

  it('should generate OAuth headers with required parameters', () => {
    // Access private method via any for testing
    const generateOAuth = (
      client as unknown as {
        generateOAuthHeader: (method: string, url: string) => string;
      }
    ).generateOAuthHeader.bind(client);

    const header = generateOAuth(
      'GET',
      'https://tstdrv12345.suitetalk.api.netsuite.com/services/rest/record/v1/vendor',
    );

    expect(header).toContain('OAuth');
    expect(header).toContain('realm="TSTDRV12345"');
    expect(header).toContain('oauth_consumer_key');
    expect(header).toContain('oauth_token');
    expect(header).toContain('oauth_signature_method="HMAC-SHA256"');
    expect(header).toContain('oauth_signature');
    expect(header).toContain('oauth_nonce');
    expect(header).toContain('oauth_timestamp');
    expect(header).toContain('oauth_version="1.0"');
  });
});
