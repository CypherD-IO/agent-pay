/**
 * CypherHQ Agent-Pay — TypeScript client
 *
 * Framework-agnostic client for the Agent-Pay bot API.
 * No npm dependencies — uses Node.js built-ins only (`fetch`, `node:crypto`).
 *
 * Security:
 *   - PAN/CVV/expiry from `revealCard()` are SECRETS. Never log, never persist.
 *   - Card reveal uses client-side decryption — PAN/CVV never touch the backend.
 *   - Always call `cancelCard()` after checkout, even on failure (use try/finally).
 */

import { createPublicKey, publicEncrypt, createDecipheriv, randomBytes, constants as cryptoConstants } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentPayConfig {
  /** Bot token, must start with `agt_`. Defaults to `process.env.AGENT_PAY_TOKEN`. */
  readonly token?: string;
  /** API base URL incl. `/v1`. Defaults to `process.env.AGENT_PAY_BASE_URL` or `https://arch.cypherd.io/v1`. */
  readonly baseUrl?: string;
}

export interface CreateCardInput {
  readonly purpose?: string;
  readonly tag?: string;
  readonly maxPerTransactionAmount?: number;
  readonly dailyLimitUsd?: number;
  readonly monthlyLimitUsd?: number;
}

export interface CreateCardResponse {
  readonly status: 'APPROVED' | 'CARD_CREATED';
  readonly cardId?: string;
  readonly tag?: string;
}

export interface RevealCardResponse {
  readonly pan: string;
  readonly cvv: string;
  readonly expiry: string;
  readonly cardId: string;
}

export interface ParsedExpiry {
  readonly expiryMonth: string;
  readonly expiryYear: string;
}

export interface ThreeDsStatus {
  readonly requestId?: string;
  readonly message?: string;
  readonly raw: unknown;
}

export interface ThreeDsPollResult {
  readonly approved: boolean;
  readonly requestId?: string;
  /** 3DS OTP sent to user's email — agent cannot auto-approve. */
  readonly requiresUserOtp?: boolean;
  readonly message?: string;
}

export interface Rules {
  readonly maxCards?: number;
  readonly dailyLimit?: number;
  readonly monthlyLimit?: number;
  readonly maxTransactionAmount?: number;
}

export interface ResolvedCard {
  readonly cardId: string;
  readonly tag: string;
}

export interface AuthStatusResponse {
  readonly enrolled: boolean;
  readonly kycComplete: boolean;
}

export interface VerifyOtpResponse {
  readonly agentId: string;
  readonly token: string;
}

export interface ApplicationInput {
  readonly firstName: string;
  readonly middleName?: string;
  readonly lastName: string;
  readonly phone: string;
  readonly email: string;
  readonly dateOfBirth: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly state: string;
  readonly country: string;
  readonly postalCode: string;
}

export interface ApplicationResponse {
  readonly kycAlreadyComplete?: boolean;
  readonly kycId?: string;
  readonly applicationStatus?: string;
  readonly kycUrl?: string;
  readonly [key: string]: unknown;
}

export interface KycStatusResponse {
  readonly kycId?: string;
  readonly kycStatus?: string;
  readonly inquiryId?: string;
  readonly url?: string;
}

export interface CardRequestStatus {
  readonly agentId?: string;
  readonly status?: string;
  readonly purpose?: string;
  readonly cardId?: string;
  readonly [key: string]: unknown;
}

export interface CardDetail {
  readonly cardId: string;
  readonly last4?: string;
  readonly network?: string;
  readonly cardTag?: string;
  readonly agentId?: string;
  readonly isOneTimeCard?: boolean;
  readonly dailyLimit?: number | null;
  readonly monthlyLimit?: number | null;
  readonly status?: string;
  readonly createdAt?: string;
  readonly [key: string]: unknown;
}

export interface TransactionQueryOpts {
  readonly limit?: number;
  readonly offset?: string;
  readonly startDate?: number;
  readonly endDate?: number;
}

export interface CancelCardResponse {
  readonly cardId: string;
  readonly status: string;
  readonly [key: string]: unknown;
}

export interface FundingUrlResponse {
  readonly transakUrl: string;
  readonly quoteId: string;
  readonly urlExpiresAt: string;
}

export interface FundStatusInput {
  readonly quoteId: string;
  readonly providerOrderId: string;
  readonly status: string;
  readonly transactionHash?: string;
}

// ---------------------------------------------------------------------------
// Errors — discriminated union via `type` tag, thrown at the boundary
// ---------------------------------------------------------------------------

export class AgentPayAuthError extends Error {
  readonly type = 'auth' as const;
  constructor(
    message = 'Agent-Pay token invalid/expired — re-run setup and refresh AGENT_PAY_TOKEN',
  ) {
    super(message);
    this.name = 'AgentPayAuthError';
  }
}

export class AgentPayApiError extends Error {
  readonly type = 'api' as const;
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Agent-Pay ${status} on ${path}: ${body}`);
    this.name = 'AgentPayApiError';
  }
}

export type AgentPayError = AgentPayAuthError | AgentPayApiError;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

const DEFAULT_BASE = 'https://arch.cypherd.io/v1';

/** Validate + normalize config into a resolved `{ token, baseUrl }` pair. */
export const resolveConfig = (
  config: AgentPayConfig,
): Readonly<{ token: string; baseUrl: string }> => {
  const token = config.token ?? process.env.AGENT_PAY_TOKEN ?? '';
  if (!token) {
    throw new Error(
      'agent-pay: token not provided and AGENT_PAY_TOKEN env var is not set.',
    );
  }
  if (!token.startsWith('agt_')) {
    throw new Error(
      'agent-pay: token must start with "agt_" — looks like a non-bot token was passed.',
    );
  }
  const baseUrl = (config.baseUrl ?? process.env.AGENT_PAY_BASE_URL ?? DEFAULT_BASE).replace(
    /\/$/,
    '',
  );
  return { token, baseUrl };
};

/** Parse a string-or-number into a number, returning NaN on undefined. */
export const coerceNum = (v: string | number | undefined): number =>
  v === undefined ? NaN : typeof v === 'number' ? v : parseFloat(v);

/** Convert the raw `/balance` response into available cents. */
export const toBalanceCents = (data: {
  balance?: string | number;
  amountWithheld?: string | number;
}): number => {
  const balance = coerceNum(data.balance);
  const withheld = coerceNum(data.amountWithheld) || 0;
  if (Number.isNaN(balance)) {
    throw new Error(`agent-pay: unexpected /balance shape: ${JSON.stringify(data)}`);
  }
  return Math.round((balance - withheld) * 100);
};

/** Normalize the backend's card-list response into a plain array. */
export const unwrapCardList = (raw: unknown): readonly unknown[] => {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const k of ['cards', 'data', 'items', 'results'] as const) {
      const v = obj[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
};

/** Find a card's id in a listing by its `cardTag`. */
export const findByCardTag = (cards: readonly unknown[], tag: string): string | undefined =>
  cards.reduce<string | undefined>((found, c) => {
    if (found) return found;
    if (!c || typeof c !== 'object') return undefined;
    const obj = c as Record<string, unknown>;
    if (obj.cardTag !== tag) return undefined;
    const id = obj.cardId ?? obj.id;
    return typeof id === 'string' ? id : undefined;
  }, undefined);

/**
 * Best-effort extraction of a 3DS challenge requestId from the
 * provider-dependent response. Walks known field candidates shallowly,
 * then recurses into `pendingChallenge` if present.
 */
export const extractRequestId = (raw: unknown): string | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const found = (['requestId', 'uniqueId'] as const)
    .map((k) => obj[k])
    .find((v): v is string => typeof v === 'string' && v.length > 0);
  return found ?? extractRequestId(obj.pendingChallenge);
};

/**
 * Parse the provider-dependent expiry string into normalized month + year.
 * Accepts both `MM/YY` and `MM/YYYY`.
 */
export const parseExpiry = (expiry: string): ParsedExpiry => {
  const [mmRaw, yyRaw] = expiry.split('/').map((s) => s.trim());
  if (!mmRaw || !yyRaw) {
    throw new Error(`parseExpiry: unable to parse "${expiry}" — expected MM/YY or MM/YYYY`);
  }
  return {
    expiryMonth: mmRaw.padStart(2, '0'),
    expiryYear: yyRaw.length === 2 ? `20${yyRaw}` : yyRaw,
  };
};

/** Build a query string from an object, omitting undefined values. */
export const qs = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
};

// ---------------------------------------------------------------------------
// Crypto helpers (card reveal — client-side decryption for PCI compliance)
// ---------------------------------------------------------------------------

/** RSA-OAEP SHA-1 encrypt the base64-encoded AES key with the provider's public key. */
export const rsaEncrypt = (aesKeyBase64: string, publicKeyBase64: string): string => {
  const pem = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----`;
  const key = createPublicKey(pem);
  const encrypted = publicEncrypt(
    { key, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(aesKeyBase64, 'utf8'),
  );
  return encrypted.toString('base64');
};

/** Decrypt an AES-128-GCM encrypted field (iv + data with appended auth tag). */
export const aesGcmDecrypt = (
  field: { readonly iv: string; readonly data: string },
  keyHex: string,
): string => {
  const aesKey = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(field.iv, 'base64');
  const raw = Buffer.from(field.data, 'base64');
  const authTag = raw.subarray(-16);
  const ciphertext = raw.subarray(0, -16);
  const decipher = createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

/** Parse PAN, CVV, and expiry from the provider's hosted HTML reveal page. */
export const parseRevealHtml = (
  html: string,
): { readonly pan: string; readonly cvv: string; readonly expiry: string } => {
  const pan = html.match(/id="pan-value">([^<]+)/)?.[1]?.trim();
  const cvv = html.match(/id="cvv-value">([^<]+)/)?.[1]?.trim();
  const expiry = html.match(/id="expiry-value">([^<]+)/)?.[1]?.trim();
  if (!pan || !cvv || !expiry) {
    throw new Error('agent-pay: unable to parse card details from reveal page');
  }
  return { pan, cvv, expiry };
};

// ---------------------------------------------------------------------------
// Async combinators
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retry `fn` up to `maxAttempts` times when `shouldRetry` returns true.
 * Each attempt receives a 0-indexed attempt number for tag generation etc.
 * Backs off by `backoffs[attempt]` ms between attempts.
 */
const retryOn = async <T>(
  fn: (attempt: number) => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  backoffs: readonly number[],
): Promise<T> => {
  const go = async (attempt: number, lastErr: unknown): Promise<T> => {
    if (attempt >= backoffs.length) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(String(lastErr));
    }
    if (backoffs[attempt]! > 0) await delay(backoffs[attempt]!);
    try {
      return await fn(attempt);
    } catch (err) {
      if (shouldRetry(err)) return go(attempt + 1, err);
      throw err;
    }
  };
  return go(0, undefined);
};

/**
 * Poll `fn` every `intervalMs` for up to `timeoutMs`. Returns the first
 * non-undefined result. Swallows errors (treats them as "not ready yet").
 */
const pollUntil = async <T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs: number,
): Promise<T | undefined> => {
  const deadline = Date.now() + timeoutMs;
  const go = async (): Promise<T | undefined> => {
    if (Date.now() >= deadline) return undefined;
    try {
      const result = await fn();
      if (result !== undefined) return result;
    } catch { /* transient — keep polling */ }
    await delay(intervalMs);
    return go();
  };
  return go();
};

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/** The public API surface returned by `createClient`. */
export interface AgentPayClient {
  readonly getAuthStatus: (email: string) => Promise<AuthStatusResponse>;
  /** Send a one-time password to the given email. No auth required. */
  readonly requestToken: (email: string) => Promise<void>;
  /** Verify OTP and receive bot + web tokens. No auth required. */
  readonly verifyOtp: (email: string, otp: number) => Promise<VerifyOtpResponse>;
  /** Submit a KYC application. */
  readonly submitApplication: (dto: ApplicationInput) => Promise<ApplicationResponse>;
  /** Check current KYC status. */
  readonly getKycStatus: () => Promise<KycStatusResponse>;
  /** Poll KYC status until completed or timeout. */
  readonly pollKycUntilComplete: (opts?: { readonly timeoutMs?: number; readonly intervalMs?: number }) => Promise<KycStatusResponse>;
  readonly getAgent: () => Promise<Record<string, unknown>>;
  readonly getBalanceCents: () => Promise<number>;
  readonly createCard: (input: CreateCardInput) => Promise<CreateCardResponse>;
  readonly createCardAndResolve: (input: CreateCardInput & { readonly tag: string }) => Promise<ResolvedCard>;
  readonly listAllCards: (opts?: { readonly includeCancelled?: boolean }) => Promise<readonly unknown[]>;
  readonly listCardsByTag: (tag: string, opts?: { readonly includeCancelled?: boolean }) => Promise<readonly unknown[]>;
  /** Get the status of a card creation request. */
  readonly getCardRequest: (requestId: string) => Promise<CardRequestStatus>;
  /** Get full card metadata by card ID. */
  readonly getCard: (cardId: string) => Promise<CardDetail>;
  /** Permanently cancel a card. The card is closed at the provider and cannot be reactivated. */
  readonly cancelCard: (cardId: string, reason?: string) => Promise<CancelCardResponse>;
  readonly revealCard: (cardId: string) => Promise<RevealCardResponse>;
  readonly getCardTransactions: (cardId: string, opts?: TransactionQueryOpts) => Promise<unknown>;
  readonly waitForTransaction: (
    cardId: string,
    opts?: { readonly timeoutMs?: number; readonly intervalMs?: number },
  ) => Promise<{ readonly settled: boolean; readonly transactions: readonly unknown[] }>;
  /** Get provider-level limits for a card. */
  readonly getCardLimits: (cardId: string) => Promise<unknown>;
  /** Update provider-level limits for a card. */
  readonly updateCardLimits: (cardId: string, limits: Record<string, unknown>) => Promise<unknown>;
  readonly setCardStatus: (cardId: string, status: 'active' | 'inactive') => Promise<void>;
  readonly freezeCard: (cardId: string) => Promise<void>;
  readonly patchRules: (rules: Rules) => Promise<unknown>;
  readonly get3dsStatus: (cardId: string) => Promise<ThreeDsStatus>;
  readonly approve3ds: (requestId: string) => Promise<void>;
  readonly deny3ds: (requestId: string) => Promise<void>;
  readonly pollAndApprove3ds: (
    cardId: string,
    opts?: { readonly timeoutMs?: number; readonly intervalMs?: number },
  ) => Promise<ThreeDsPollResult>;
  /** Get a funding redirect URL. The bot hands this URL to the user to open in a browser. */
  readonly getFundingUrl: (fiatAmount: number) => Promise<FundingUrlResponse>;
  /** Report funding status manually. In the normal flow the webapp handles this automatically. */
  readonly reportFundStatus: (dto: FundStatusInput) => Promise<{ readonly message: string }>;
  /** Get cross-card transaction history. */
  readonly getAllTransactions: (opts?: Record<string, string>) => Promise<unknown>;
  /** Get spending statistics. */
  readonly getSpendStats: (opts?: { readonly startDate?: string; readonly endDate?: string }) => Promise<unknown>;
}

/**
 * Create an Agent-Pay client. Returns a frozen record of functions — no
 * classes, no `this`, no mutable state. Config is captured once via closure.
 *
 * ```ts
 * const ap = createClient({ token: 'agt_...' });
 * const cents = await ap.getBalanceCents();
 * ```
 */
export const createClient = (config: AgentPayConfig = {}): AgentPayClient => {
  const { token, baseUrl } = resolveConfig(config);

  // -- Transport (single side-effect boundary) --

  const botFetch = async <T = unknown>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...((init.headers as Record<string, string>) ?? {}),
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };

    const res = await fetch(`${baseUrl}/agentpay${path}`, { ...init, headers });

    if (res.status === 401) throw new AgentPayAuthError();
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AgentPayApiError(res.status, path, body);
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };

  const get = <T = unknown>(path: string) => botFetch<T>(path);
  const post = <T = unknown>(path: string, body?: unknown) =>
    botFetch<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const patch = <T = unknown>(path: string, body: unknown) =>
    botFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  const del = <T = unknown>(path: string, body?: unknown) =>
    botFetch<T>(path, { method: 'DELETE', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  /** Unauthenticated POST — used only for auth endpoints (no Authorization header). */
  const publicPost = async <T = unknown>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${baseUrl}/agentpay${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AgentPayApiError(res.status, path, text);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };

  // -- API functions (closed over transport, no `this`) --

  const getAuthStatus = async (email: string): Promise<AuthStatusResponse> => {
    const res = await fetch(`${baseUrl}/agentpay/auth/status?email=${encodeURIComponent(email)}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AgentPayApiError(res.status, '/auth/status', text);
    }
    return (await res.json()) as AuthStatusResponse;
  };

  const requestToken = (email: string) =>
    publicPost<void>('/auth/request-token', { email });

  const verifyOtp = (email: string, otp: number) =>
    publicPost<VerifyOtpResponse>('/auth/verify-otp', { email, otp });

  const submitApplication = (dto: ApplicationInput) =>
    post<ApplicationResponse>('/application', dto);

  const getKycStatus = () =>
    get<KycStatusResponse>('/kyc');

  const getAgent = () => get<Record<string, unknown>>('/agent');

  const getBalanceCents = async () =>
    toBalanceCents(
      (await get<{ balance?: string | number; amountWithheld?: string | number }>('/balance')) ??
        {},
    );

  const createCard = (input: CreateCardInput) =>
    post<CreateCardResponse>('/card', input);

  const listAllCards = async (opts?: { readonly includeCancelled?: boolean }) => {
    const cards = unwrapCardList(await get('/card'));
    if (opts?.includeCancelled) return cards;
    return cards.filter((c) => {
      if (!c || typeof c !== 'object') return true;
      return (c as Record<string, unknown>).status !== 'CANCELLED';
    });
  };

  const listCardsByTag = async (tag: string, opts?: { readonly includeCancelled?: boolean }) => {
    const cards = unwrapCardList(await get(`/card?tag=${encodeURIComponent(tag)}`));
    if (opts?.includeCancelled) return cards;
    return cards.filter((c) => {
      if (!c || typeof c !== 'object') return true;
      return (c as Record<string, unknown>).status !== 'CANCELLED';
    });
  };

  const getCardRequest = (requestId: string) =>
    get<CardRequestStatus>(`/card/requests/${requestId}`);

  const getCard = (cardId: string) =>
    get<CardDetail>(`/card/${cardId}`);

  const cancelCard = (cardId: string, reason?: string) =>
    del<CancelCardResponse>(`/card/${cardId}`, reason !== undefined ? { reason } : undefined);

  const revealCard = async (cardId: string): Promise<RevealCardResponse> => {
    const step1 = await post<{ readonly type: string; readonly [key: string]: unknown }>(
      `/card/${cardId}/reveal`,
    );

    if (step1.type === 'url') {
      const res = await fetch(String(step1.accessUrl));
      const html = await res.text();
      const parsed = parseRevealHtml(html);
      return { ...parsed, cardId };
    }

    if (step1.type === 'session_required') {
      const aesKeyHex = randomBytes(16).toString('hex');
      const aesKeyBase64 = Buffer.from(aesKeyHex, 'hex').toString('base64');
      const sessionId = rsaEncrypt(aesKeyBase64, String(step1.publicKey));

      const step2 = await post<{
        readonly encryptedPan: { readonly iv: string; readonly data: string };
        readonly encryptedCvc: { readonly iv: string; readonly data: string };
        readonly expirationMonth: string;
        readonly expirationYear: string;
        readonly cardId: string;
      }>(`/card/${cardId}/reveal`, { sessionId });

      const pan = aesGcmDecrypt(step2.encryptedPan, aesKeyHex);
      const cvv = aesGcmDecrypt(step2.encryptedCvc, aesKeyHex);
      const expiry = `${step2.expirationMonth}/${step2.expirationYear}`;
      return { pan, cvv, expiry, cardId };
    }

    throw new Error('agent-pay: unexpected reveal response');
  };

  const getCardTransactions = (cardId: string, opts?: TransactionQueryOpts) =>
    get<unknown>(`/card/${cardId}/transactions${qs(opts as Record<string, string | number | undefined> ?? {})}`);

  const unwrapTransactions = (raw: unknown): readonly unknown[] => {
    if (!raw || typeof raw !== 'object') return [];
    const obj = raw as Record<string, unknown>;
    const records = obj.records ?? obj.transactions ?? obj.data ?? obj.items;
    return Array.isArray(records) ? records : [];
  };

  const waitForTransaction = async (
    cardId: string,
    opts: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
  ): Promise<{ readonly settled: boolean; readonly transactions: readonly unknown[] }> => {
    const result = await pollUntil(
      async () => {
        const raw = await getCardTransactions(cardId, { limit: 1 });
        const txns = unwrapTransactions(raw);
        return txns.length > 0 ? txns : undefined;
      },
      opts.timeoutMs ?? 30_000,
      opts.intervalMs ?? 3_000,
    );
    return result
      ? { settled: true, transactions: result }
      : { settled: false, transactions: [] };
  };

  const getCardLimits = (cardId: string) =>
    get<unknown>(`/card/${cardId}/limits`);

  const updateCardLimits = (cardId: string, limits: Record<string, unknown>) =>
    patch<unknown>(`/card/${cardId}/limits`, limits);

  const setCardStatus = (cardId: string, status: 'active' | 'inactive') =>
    patch<void>(`/card/${cardId}/status`, { status });

  const freezeCard = (cardId: string) => setCardStatus(cardId, 'inactive');

  const patchRules = (rules: Rules) => patch('/rules', { rules });

  const getFundingUrl = (fiatAmount: number) =>
    post<FundingUrlResponse>('/fund', { fiatAmount });

  const reportFundStatus = (dto: FundStatusInput) =>
    post<{ message: string }>('/fund/status', {
      quoteId: dto.quoteId,
      transakOrderId: dto.providerOrderId,
      status: dto.status,
      ...(dto.transactionHash ? { transactionHash: dto.transactionHash } : {}),
    });

  const getAllTransactions = (opts?: Record<string, string>) =>
    get<unknown>(`/transactions${qs(opts as Record<string, string | number | undefined> ?? {})}`);

  const getSpendStats = (opts?: { readonly startDate?: string; readonly endDate?: string }) =>
    get<unknown>(`/spend-stats${qs(opts as Record<string, string | number | undefined> ?? {})}`);

  const get3dsStatus = async (cardId: string): Promise<ThreeDsStatus> => {
    const raw = await get(`/3ds/status/${cardId}`);
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      requestId: extractRequestId(raw),
      message: typeof obj.message === 'string' ? obj.message : undefined,
      raw,
    };
  };

  const approve3ds = (requestId: string) =>
    post<void>(`/3ds/approve/${requestId}`);

  const deny3ds = (requestId: string) =>
    post<void>(`/3ds/deny/${requestId}`);

  const isRetryableCreateError = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('RequestId not found');
  };

  const createCardAndResolve = async (
    input: CreateCardInput & { readonly tag: string },
  ): Promise<ResolvedCard> => {
    // Step 1: POST /card with automatic retry on transient failures.
    const resolvedTag = await retryOn(
      async (attempt) => {
        const tag = attempt === 0 ? input.tag : `${input.tag}-r${attempt + 1}`;
        const created = await createCard({ ...input, tag });
        // Forward-compat: if backend starts returning cardId, short-circuit.
        if (created.cardId) return { cardId: created.cardId, tag };
        return { tag };
      },
      isRetryableCreateError,
      [0, 2_000, 5_000],
    );

    if ('cardId' in resolvedTag && resolvedTag.cardId) {
      return resolvedTag as ResolvedCard;
    }

    // Step 2: poll listing until the card surfaces.
    const cardId = await pollUntil(
      async () => findByCardTag(await listAllCards(), resolvedTag.tag),
      30_000,
      1_000,
    );

    if (!cardId) {
      throw new Error(
        `createCardAndResolve: card with tag "${resolvedTag.tag}" did not appear in listing within 30s.`,
      );
    }

    return { cardId, tag: resolvedTag.tag };
  };

  const pollAndApprove3ds = async (
    cardId: string,
    opts: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
  ): Promise<ThreeDsPollResult> => {
    const initial = await get3dsStatus(cardId);
    if (initial.message) {
      return { approved: false, requiresUserOtp: true, message: initial.message };
    }
    if (initial.requestId) {
      await approve3ds(initial.requestId);
      return { approved: true, requestId: initial.requestId };
    }

    const result = await pollUntil(
      async () => {
        const { requestId, message } = await get3dsStatus(cardId);
        if (message) return { approved: false as const, requiresUserOtp: true, message };
        if (!requestId) return undefined;
        await approve3ds(requestId);
        return { approved: true as const, requestId };
      },
      opts.timeoutMs ?? 60_000,
      opts.intervalMs ?? 2_000,
    );
    return result ?? { approved: false };
  };

  const pollKycUntilComplete = async (
    opts: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
  ): Promise<KycStatusResponse> => {
    const result = await pollUntil(
      async () => {
        const status = await getKycStatus();
        return status.kycStatus === 'completed' ? status : undefined;
      },
      opts.timeoutMs ?? 300_000,
      opts.intervalMs ?? 5_000,
    );
    if (!result) {
      throw new Error('pollKycUntilComplete: KYC did not reach "completed" before timeout.');
    }
    return result;
  };

  return Object.freeze({
    getAuthStatus,
    requestToken,
    verifyOtp,
    submitApplication,
    getKycStatus,
    pollKycUntilComplete,
    getAgent,
    getBalanceCents,
    createCard,
    createCardAndResolve,
    listAllCards,
    listCardsByTag,
    getCardRequest,
    getCard,
    cancelCard,
    revealCard,
    getCardTransactions,
    waitForTransaction,
    getCardLimits,
    updateCardLimits,
    setCardStatus,
    freezeCard,
    patchRules,
    get3dsStatus,
    approve3ds,
    deny3ds,
    pollAndApprove3ds,
    getFundingUrl,
    reportFundStatus,
    getAllTransactions,
    getSpendStats,
  });
};
