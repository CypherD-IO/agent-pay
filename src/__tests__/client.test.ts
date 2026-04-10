import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveConfig,
  coerceNum,
  toBalanceCents,
  unwrapCardList,
  findByAgentTag,
  extractRequestId,
  qs,
} from '../internals.js';
import { parseExpiry, createClient, AgentPayAuthError, AgentPayApiError } from '../index.js';

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('parseExpiry', () => {
  it('parses MM/YY', () => {
    expect(parseExpiry('03/27')).toEqual({ expiryMonth: '03', expiryYear: '2027' });
  });

  it('parses MM/YYYY', () => {
    expect(parseExpiry('12/2030')).toEqual({ expiryMonth: '12', expiryYear: '2030' });
  });

  it('pads single-digit month', () => {
    expect(parseExpiry('1/25')).toEqual({ expiryMonth: '01', expiryYear: '2025' });
  });

  it('trims whitespace', () => {
    expect(parseExpiry(' 06 / 28 ')).toEqual({ expiryMonth: '06', expiryYear: '2028' });
  });

  it('throws on invalid format', () => {
    expect(() => parseExpiry('13')).toThrow('expected MM/YY or MM/YYYY');
  });
});

describe('resolveConfig', () => {
  beforeEach(() => {
    delete process.env.AGENT_PAY_TOKEN;
    delete process.env.AGENT_PAY_BASE_URL;
  });

  it('uses explicit token and baseUrl', () => {
    expect(resolveConfig({ token: 'agt_abc', baseUrl: 'https://example.com/v1' })).toEqual({
      token: 'agt_abc',
      baseUrl: 'https://example.com/v1',
    });
  });

  it('falls back to env vars', () => {
    process.env.AGENT_PAY_TOKEN = 'agt_env';
    process.env.AGENT_PAY_BASE_URL = 'https://env.example.com/v1';
    expect(resolveConfig({})).toEqual({
      token: 'agt_env',
      baseUrl: 'https://env.example.com/v1',
    });
  });

  it('strips trailing slash from baseUrl', () => {
    expect(resolveConfig({ token: 'agt_x', baseUrl: 'https://example.com/' })).toEqual({
      token: 'agt_x',
      baseUrl: 'https://example.com',
    });
  });

  it('throws when no token provided', () => {
    expect(() => resolveConfig({})).toThrow('token not provided');
  });

  it('throws when token does not start with agt_', () => {
    expect(() => resolveConfig({ token: 'bad_token' })).toThrow('must start with "agt_"');
  });

  it('uses default base URL when none provided', () => {
    const { baseUrl } = resolveConfig({ token: 'agt_test' });
    expect(baseUrl).toBe('https://arch-dev.cypherd.io/v1');
  });
});

describe('coerceNum', () => {
  it('returns number as-is', () => {
    expect(coerceNum(42)).toBe(42);
  });

  it('parses string to number', () => {
    expect(coerceNum('3.14')).toBeCloseTo(3.14);
  });

  it('returns NaN for undefined', () => {
    expect(coerceNum(undefined)).toBeNaN();
  });

  it('returns NaN for non-numeric string', () => {
    expect(coerceNum('abc')).toBeNaN();
  });
});

describe('toBalanceCents', () => {
  it('converts string balance to cents', () => {
    expect(toBalanceCents({ balance: '100.50' })).toBe(10050);
  });

  it('converts numeric balance to cents', () => {
    expect(toBalanceCents({ balance: 25 })).toBe(2500);
  });

  it('subtracts amountWithheld', () => {
    expect(toBalanceCents({ balance: '100', amountWithheld: '10' })).toBe(9000);
  });

  it('treats missing amountWithheld as zero', () => {
    expect(toBalanceCents({ balance: '50' })).toBe(5000);
  });

  it('rounds to nearest cent', () => {
    expect(toBalanceCents({ balance: '10.999' })).toBe(1100);
  });

  it('throws on missing balance', () => {
    expect(() => toBalanceCents({})).toThrow('unexpected /balance shape');
  });
});

describe('unwrapCardList', () => {
  it('returns raw array as-is', () => {
    const arr = [{ id: '1' }];
    expect(unwrapCardList(arr)).toBe(arr);
  });

  it('unwraps { cards: [...] }', () => {
    const cards = [{ id: '1' }];
    expect(unwrapCardList({ cards })).toBe(cards);
  });

  it('unwraps { data: [...] }', () => {
    const data = [{ id: '2' }];
    expect(unwrapCardList({ data })).toBe(data);
  });

  it('unwraps { items: [...] }', () => {
    const items = [{ id: '3' }];
    expect(unwrapCardList({ items })).toBe(items);
  });

  it('unwraps { results: [...] }', () => {
    const results = [{ id: '4' }];
    expect(unwrapCardList({ results })).toBe(results);
  });

  it('returns empty array for null', () => {
    expect(unwrapCardList(null)).toEqual([]);
  });

  it('returns empty array for object with no known keys', () => {
    expect(unwrapCardList({ unknown: 'value' })).toEqual([]);
  });
});

describe('findByAgentTag', () => {
  const cards = [
    { agentTag: 'tag-1', cardId: 'card-1' },
    { agentTag: 'tag-2', id: 'card-2' },
    { agentTag: 'tag-3', _id: 'card-3' },
  ];

  it('finds by cardId field', () => {
    expect(findByAgentTag(cards, 'tag-1')).toBe('card-1');
  });

  it('falls back to id field', () => {
    expect(findByAgentTag(cards, 'tag-2')).toBe('card-2');
  });

  it('falls back to _id field', () => {
    expect(findByAgentTag(cards, 'tag-3')).toBe('card-3');
  });

  it('returns undefined for unknown tag', () => {
    expect(findByAgentTag(cards, 'tag-999')).toBeUndefined();
  });

  it('returns undefined for empty list', () => {
    expect(findByAgentTag([], 'tag-1')).toBeUndefined();
  });

  it('skips non-objects', () => {
    expect(findByAgentTag([null, 42, 'str'], 'tag-1')).toBeUndefined();
  });
});

describe('extractRequestId', () => {
  it('extracts requestId from top level', () => {
    expect(extractRequestId({ requestId: 'req-1' })).toBe('req-1');
  });

  it('extracts uniqueId from top level', () => {
    expect(extractRequestId({ uniqueId: 'uid-1' })).toBe('uid-1');
  });

  it('prefers requestId over uniqueId', () => {
    expect(extractRequestId({ requestId: 'req-1', uniqueId: 'uid-1' })).toBe('req-1');
  });

  it('recurses into pendingChallenge', () => {
    expect(extractRequestId({ pendingChallenge: { requestId: 'nested' } })).toBe('nested');
  });

  it('returns undefined for null', () => {
    expect(extractRequestId(null)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(extractRequestId({})).toBeUndefined();
  });

  it('ignores empty string values', () => {
    expect(extractRequestId({ requestId: '' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Client tests (mocked fetch)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

const makeClient = () => {
  vi.stubGlobal('fetch', mockFetch);
  return createClient({ token: 'agt_test', baseUrl: 'https://test.example.com/v1' });
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('createClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('getBalanceCents', () => {
    it('returns balance in cents', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ balance: '42.50', amountWithheld: '0' }));

      const cents = await client.getBalanceCents();
      expect(cents).toBe(4250);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0]![0]).toBe(
        'https://test.example.com/v1/agent-pay-bot/balance',
      );
    });
  });

  describe('createCard', () => {
    it('returns status and tag', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ status: 'APPROVED', tag: 'my-card' }),
      );

      const result = await client.createCard({ tag: 'my-card', purpose: 'test' });
      expect(result).toEqual({ status: 'APPROVED', tag: 'my-card' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://test.example.com/v1/agent-pay-bot/card');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ tag: 'my-card', purpose: 'test' });
    });
  });

  describe('freezeCard', () => {
    it('sends PATCH with inactive status', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await client.freezeCard('card-123');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://test.example.com/v1/agent-pay-bot/card/card-123/status');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ status: 'inactive' });
    });
  });

  describe('auth error (401)', () => {
    it('throws AgentPayAuthError on 401', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

      await expect(client.getAgent()).rejects.toThrow(AgentPayAuthError);
    });
  });

  describe('API error (non-2xx)', () => {
    it('throws AgentPayApiError with status, path, and body', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      try {
        await client.listAllCards();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AgentPayApiError);
        const apiErr = err as InstanceType<typeof AgentPayApiError>;
        expect(apiErr.status).toBe(404);
        expect(apiErr.path).toBe('/card');
        expect(apiErr.body).toBe('Not Found');
      }
    });
  });

  describe('requestToken', () => {
    it('sends POST without Authorization header', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await client.requestToken('user@example.com');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://test.example.com/v1/agent-pay-bot/auth/request-token');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ email: 'user@example.com' });
      expect(init.headers).not.toHaveProperty('Authorization');
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });
  });

  describe('verifyOtp', () => {
    it('sends POST without Authorization header and returns tokens', async () => {
      const client = makeClient();
      const response = { agentId: 'ag-1', token: 'agt_new', webToken: 'jwt.web.token' };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.verifyOtp('user@example.com', 1689);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://test.example.com/v1/agent-pay-bot/auth/verify-otp');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ email: 'user@example.com', otp: 1689 });
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      expect(result).toEqual(response);
    });
  });

  describe('submitApplication', () => {
    it('sends correct body and returns application response', async () => {
      const client = makeClient();
      const dto = {
        firstName: 'John',
        lastName: 'Doe',
        phone: '+15551234567',
        email: 'john@example.com',
        dateOfBirth: '1990-01-15',
        line1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        country: 'US',
        postalCode: '62704',
      };
      const response = { kycAlreadyComplete: false, kycUrl: 'https://sumsub.example.com/verify' };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.submitApplication(dto);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://test.example.com/v1/agent-pay-bot/application');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual(dto);
      expect(result.kycUrl).toBe('https://sumsub.example.com/verify');
    });
  });

  describe('getKycStatus', () => {
    it('returns flat KYC status', async () => {
      const client = makeClient();
      const response = { kycId: 'kyc-1', kycStatus: 'pending', kycProvider: 'SS' };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.getKycStatus();

      expect(mockFetch.mock.calls[0]![0]).toBe('https://test.example.com/v1/agent-pay-bot/kyc');
      expect(result.kycStatus).toBe('pending');
    });
  });

  describe('rotateToken', () => {
    it('sends ttlSeconds when provided', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ token: 'agt_rotated' }));

      const result = await client.rotateToken(86400);

      const [, init] = mockFetch.mock.calls[0]!;
      expect(JSON.parse(init.body as string)).toEqual({ ttlSeconds: 86400 });
      expect(result.token).toBe('agt_rotated');
    });

    it('omits ttlSeconds when not provided', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ token: 'agt_rotated' }));

      await client.rotateToken();

      const [, init] = mockFetch.mock.calls[0]!;
      expect(JSON.parse(init.body as string)).toEqual({});
    });
  });

  describe('getCardRequest', () => {
    it('fetches card request status by requestId', async () => {
      const client = makeClient();
      const response = { agentId: 'ag-1', status: 'AUTO_APPROVED', cardId: 'card-99' };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.getCardRequest('req-42');

      expect(mockFetch.mock.calls[0]![0]).toBe(
        'https://test.example.com/v1/agent-pay-bot/card/requests/req-42',
      );
      expect(result.cardId).toBe('card-99');
    });
  });

  describe('getCard', () => {
    it('fetches card detail by cardId', async () => {
      const client = makeClient();
      const response = { cardId: 'card-1', status: 'active', cardProvider: 'reap' };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.getCard('card-1');

      expect(mockFetch.mock.calls[0]![0]).toBe(
        'https://test.example.com/v1/agent-pay-bot/card/card-1',
      );
      expect(result.cardId).toBe('card-1');
    });
  });

  describe('getCardTransactions', () => {
    it('builds query string from opts and omits undefined params', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.getCardTransactions('card-1', { limit: 10, startDate: 1700000000 });

      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/card/card-1/transactions?');
      expect(url).toContain('limit=10');
      expect(url).toContain('startDate=1700000000');
      expect(url).not.toContain('offset');
      expect(url).not.toContain('endDate');
    });

    it('calls without query string when no opts', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.getCardTransactions('card-1');

      expect(mockFetch.mock.calls[0]![0]).toBe(
        'https://test.example.com/v1/agent-pay-bot/card/card-1/transactions',
      );
    });
  });

  describe('getCardLimits', () => {
    it('fetches limits for a card', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ cusL: { dom: { pos: 1000 } } }));

      const result = await client.getCardLimits('card-1');

      expect(mockFetch.mock.calls[0]![0]).toBe(
        'https://test.example.com/v1/agent-pay-bot/card/card-1/limits',
      );
      expect(result).toEqual({ cusL: { dom: { pos: 1000 } } });
    });
  });

  describe('updateCardLimits', () => {
    it('sends PATCH with limits body', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await client.updateCardLimits('card-1', { cusL: { dom: { pos: 500 } } });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://test.example.com/v1/agent-pay-bot/card/card-1/limits');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ cusL: { dom: { pos: 500 } } });
    });
  });

  describe('getFundingUrl', () => {
    it('sends fiatAmount and returns Transak URL', async () => {
      const client = makeClient();
      const response = {
        transakUrl: 'https://transak.example.com/widget',
        quoteId: 'q-1',
        urlExpiresAt: '2026-04-10T12:00:00Z',
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.getFundingUrl(100);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://test.example.com/v1/agent-pay-bot/fund');
      expect(JSON.parse(init.body as string)).toEqual({ fiatAmount: 100 });
      expect(result.transakUrl).toBe('https://transak.example.com/widget');
    });
  });

  describe('reportFundStatus', () => {
    it('sends correct body shape', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'ok' }));

      const dto = {
        quoteId: 'q-1',
        transakOrderId: 'order-1',
        status: 'COMPLETED',
        transactionHash: '0xabc',
      };
      const result = await client.reportFundStatus(dto);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://test.example.com/v1/agent-pay-bot/fund/status');
      expect(JSON.parse(init.body as string)).toEqual(dto);
      expect(result.message).toBe('ok');
    });
  });

  describe('getAllTransactions', () => {
    it('passes opts as query params', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.getAllTransactions({ limit: '20', cardId: 'card-1' });

      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/transactions?');
      expect(url).toContain('limit=20');
      expect(url).toContain('cardId=card-1');
    });
  });

  describe('getSpendStats', () => {
    it('passes date range as query params', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}));

      await client.getSpendStats({ startDate: '2026-04-01', endDate: '2026-04-10' });

      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/spend-stats?');
      expect(url).toContain('startDate=2026-04-01');
      expect(url).toContain('endDate=2026-04-10');
    });
  });

  describe('pollKycUntilComplete', () => {
    it('resolves when kycStatus is completed', async () => {
      const client = makeClient();
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ kycStatus: 'pending' }))
        .mockResolvedValueOnce(jsonResponse({ kycStatus: 'completed', kycId: 'kyc-1' }));

      const result = await client.pollKycUntilComplete({ timeoutMs: 5_000, intervalMs: 10 });

      expect(result.kycStatus).toBe('completed');
    });

    it('swallows 4xx errors and keeps polling', async () => {
      const client = makeClient();
      mockFetch
        .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
        .mockResolvedValueOnce(jsonResponse({ kycStatus: 'completed' }));

      const result = await client.pollKycUntilComplete({ timeoutMs: 5_000, intervalMs: 10 });

      expect(result.kycStatus).toBe('completed');
    });

    it('throws on timeout', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(jsonResponse({ kycStatus: 'pending' }));

      await expect(
        client.pollKycUntilComplete({ timeoutMs: 50, intervalMs: 10 }),
      ).rejects.toThrow('did not reach "completed" before timeout');
    });
  });
});

// ---------------------------------------------------------------------------
// qs utility tests
// ---------------------------------------------------------------------------

describe('qs', () => {
  it('returns empty string for empty object', () => {
    expect(qs({})).toBe('');
  });

  it('builds query string from params', () => {
    expect(qs({ a: '1', b: 2 })).toBe('?a=1&b=2');
  });

  it('omits undefined values', () => {
    expect(qs({ a: '1', b: undefined, c: '3' })).toBe('?a=1&c=3');
  });

  it('encodes special characters', () => {
    expect(qs({ q: 'hello world' })).toBe('?q=hello%20world');
  });

  it('returns empty string when all values undefined', () => {
    expect(qs({ a: undefined, b: undefined })).toBe('');
  });
});
