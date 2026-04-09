/**
 * CypherHQ Agent-Pay — TypeScript client 
 *
 * Framework-agnostic client for the Agent-Pay bot API.
 * No dependencies beyond `fetch`.
 *
 * Security:
 *   - PAN/CVV/expiry from `revealCard()` are SECRETS. Never log, never persist.
 *   - Always call `freezeCard()` after checkout, even on failure (use try/finally).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentPayConfig {
  /** Bot token, must start with `agt_`. Defaults to `process.env.AGENT_PAY_TOKEN`. */
  readonly token?: string;
  /** API base URL incl. `/v1`. Defaults to `process.env.AGENT_PAY_BASE_URL` or arch-dev. */
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
  readonly status: 'APPROVED' | 'AUTO_APPROVED';
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
  readonly raw: unknown;
}

export interface ThreeDsPollResult {
  readonly approved: boolean;
  readonly requestId?: string;
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

const DEFAULT_BASE = 'https://arch-dev.cypherd.io/v1';

/** Validate + normalize config into a resolved `{ token, baseUrl }` pair. */
const resolveConfig = (
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
      'agent-pay: token must start with "agt_" — looks like a webToken was passed.',
    );
  }
  const baseUrl = (config.baseUrl ?? process.env.AGENT_PAY_BASE_URL ?? DEFAULT_BASE).replace(
    /\/$/,
    '',
  );
  return { token, baseUrl };
};

/** Parse a string-or-number into a number, returning NaN on undefined. */
const coerceNum = (v: string | number | undefined): number =>
  v === undefined ? NaN : typeof v === 'number' ? v : parseFloat(v);

/** Convert the raw `/balance` response into available cents. */
const toBalanceCents = (data: {
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
const unwrapCardList = (raw: unknown): readonly unknown[] => {
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

/** Find a card's id in a listing by its `agentTag`. */
const findByAgentTag = (cards: readonly unknown[], tag: string): string | undefined =>
  cards.reduce<string | undefined>((found, c) => {
    if (found) return found;
    if (!c || typeof c !== 'object') return undefined;
    const obj = c as Record<string, unknown>;
    if (obj.agentTag !== tag) return undefined;
    const id = obj.cardId ?? obj.id ?? obj._id;
    return typeof id === 'string' ? id : undefined;
  }, undefined);

/**
 * Best-effort extraction of a 3DS challenge requestId from the
 * provider-dependent response. Walks known field candidates shallowly,
 * then recurses into `pendingChallenge` if present.
 */
const extractRequestId = (raw: unknown): string | undefined => {
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
  readonly getAgent: () => Promise<Record<string, unknown>>;
  readonly getBalanceCents: () => Promise<number>;
  readonly createCard: (input: CreateCardInput) => Promise<CreateCardResponse>;
  readonly createCardAndResolve: (input: CreateCardInput & { readonly tag: string }) => Promise<ResolvedCard>;
  readonly listAllCards: () => Promise<readonly unknown[]>;
  readonly listCardsByTag: (tag: string) => Promise<readonly unknown[]>;
  readonly revealCard: (cardId: string) => Promise<RevealCardResponse>;
  readonly setCardStatus: (cardId: string, status: 'active' | 'inactive') => Promise<void>;
  readonly freezeCard: (cardId: string) => Promise<void>;
  readonly patchRules: (rules: Rules) => Promise<unknown>;
  readonly markOnboarded: () => Promise<{ readonly agentOnboarded: boolean }>;
  readonly get3dsStatus: (cardId: string) => Promise<ThreeDsStatus>;
  readonly approve3ds: (requestId: string) => Promise<void>;
  readonly deny3ds: (requestId: string) => Promise<void>;
  readonly pollAndApprove3ds: (
    cardId: string,
    opts?: { readonly timeoutMs?: number; readonly intervalMs?: number },
  ) => Promise<ThreeDsPollResult>;
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

    const res = await fetch(`${baseUrl}/agent-pay-bot${path}`, { ...init, headers });

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

  // -- API functions (closed over transport, no `this`) --

  const getAgent = () => get<Record<string, unknown>>('/agent');

  const getBalanceCents = async () =>
    toBalanceCents(
      (await get<{ balance?: string | number; amountWithheld?: string | number }>('/balance')) ??
        {},
    );

  const createCard = (input: CreateCardInput) =>
    post<CreateCardResponse>('/card', input);

  const listAllCards = async () =>
    unwrapCardList(await get('/card'));

  const listCardsByTag = async (tag: string) =>
    unwrapCardList(await get(`/card?tag=${encodeURIComponent(tag)}`));

  const revealCard = (cardId: string) =>
    post<RevealCardResponse>(`/card/${cardId}/reveal`);

  const setCardStatus = (cardId: string, status: 'active' | 'inactive') =>
    patch<void>(`/card/${cardId}/status`, { status });

  const freezeCard = (cardId: string) => setCardStatus(cardId, 'inactive');

  const patchRules = (rules: Rules) => patch('/rules', { rules });

  const markOnboarded = () =>
    post<{ agentOnboarded: boolean }>('/onboarded');

  const get3dsStatus = async (cardId: string): Promise<ThreeDsStatus> => {
    const raw = await get(`/3ds/status/${cardId}`);
    return { requestId: extractRequestId(raw), raw };
  };

  const approve3ds = (requestId: string) =>
    post<void>(`/3ds/approve/${requestId}`);

  const deny3ds = (requestId: string) =>
    post<void>(`/3ds/deny/${requestId}`);

  const isRetryableCreateError = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('fdActionRequestId not found');
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
      async () => findByAgentTag(await listAllCards(), resolvedTag.tag),
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
    const result = await pollUntil(
      async () => {
        const { requestId } = await get3dsStatus(cardId);
        if (!requestId) return undefined;
        await approve3ds(requestId);
        return { approved: true as const, requestId };
      },
      opts.timeoutMs ?? 60_000,
      opts.intervalMs ?? 2_000,
    );
    return result ?? { approved: false };
  };

  return Object.freeze({
    getAgent,
    getBalanceCents,
    createCard,
    createCardAndResolve,
    listAllCards,
    listCardsByTag,
    revealCard,
    setCardStatus,
    freezeCard,
    patchRules,
    markOnboarded,
    get3dsStatus,
    approve3ds,
    deny3ds,
    pollAndApprove3ds,
  });
};
