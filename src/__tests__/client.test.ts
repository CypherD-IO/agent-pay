import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveConfig,
  coerceNum,
  toBalanceCents,
  unwrapCardList,
  findByCardTag,
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
    expect(baseUrl).toBe('https://arch.cypherd.io/v1');
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

describe('findByCardTag', () => {
  const cards = [
    { cardTag: 'tag-1', cardId: 'card-1' },
    { cardTag: 'tag-2', id: 'card-2' },
  ];

  it('finds by cardId field', () => {
    expect(findByCardTag(cards, 'tag-1')).toBe('card-1');
  });

  it('falls back to id field', () => {
    expect(findByCardTag(cards, 'tag-2')).toBe('card-2');
  });

  it('returns undefined for unknown tag', () => {
    expect(findByCardTag(cards, 'tag-999')).toBeUndefined();
  });

  it('returns undefined for empty list', () => {
    expect(findByCardTag([], 'tag-1')).toBeUndefined();
  });

  it('skips non-objects', () => {
    expect(findByCardTag([null, 42, 'str'], 'tag-1')).toBeUndefined();
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
      expect(url).toBe('https://test.example.com/v1/agentpay/auth/request-token');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ email: 'user@example.com' });
      expect(init.headers).not.toHaveProperty('Authorization');
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });
  });

  describe('verifyOtp', () => {
    it('sends POST without Authorization header and returns tokens', async () => {
      const client = makeClient();
      const response = { agentId: 'ag-1', token: 'agt_new' };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.verifyOtp('user@example.com', 1689);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://test.example.com/v1/agentpay/auth/verify-otp');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ email: 'user@example.com', otp: 1689 });
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      expect(result).toEqual(response);
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
