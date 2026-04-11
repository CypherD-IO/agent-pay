---
name: cypher-pay
description: Integrate CypherHQ Agent-Pay SDK for AI agent virtual card operations. Create and manage programmable Visa cards, fund with fiat, set spend limits, handle 3DS challenges, and track transactions. Use when an agent needs to make real purchases, manage payment cards, enforce spending budgets, or audit transaction history.
---

# Cypher Pay — Virtual Cards for AI Agents

Cypher Pay is a programmable virtual card platform for AI agents. The `@cypherhq/agent-pay` SDK provides a zero-dependency TypeScript client to create virtual Visa cards, fund them with fiat, set spend limits, handle 3DS challenges, and track transactions.

## Core Capabilities

- **Virtual Cards**: Create ecommerce-only Visa cards on demand
- **Spend Controls**: Per-transaction, daily, and monthly limits
- **Card Lifecycle**: Freeze/unfreeze instantly, cancel permanently
- **Fiat Funding**: Fund via Transak (user completes payment in browser)
- **3DS Handling**: Programmatically approve or deny 3DS challenges
- **Transaction Auditing**: Per-card and cross-card transaction history with spend analytics

## Quick Start

1. **Install**: `npm install @cypherhq/agent-pay`
2. **Set environment variable**: `AGENT_PAY_TOKEN=agt_your_token_here`

```typescript
import { createClient } from '@cypherhq/agent-pay';

const ap = createClient(); // reads AGENT_PAY_TOKEN from env

// Check balance
const cents = await ap.getBalanceCents();
console.log(`Balance: $${(cents / 100).toFixed(2)}`);

// Create a card, reveal details, use it, freeze it
const { cardId, tag } = await ap.createCardAndResolve({
  tag: 'order-42',
  purpose: 'Buy headphones',
  maxPerTransactionAmount: 100,
});

const { pan, cvv, expiry } = await ap.revealCard(cardId);
// Use pan/cvv/expiry for checkout — NEVER log these values

await ap.freezeCard(cardId); // Always freeze after use
```

## Authentication

Agents authenticate via email OTP to obtain a bot token (`agt_` prefix).

```typescript
import { createClient } from '@cypherhq/agent-pay';

// Step 1: Request OTP (no auth required)
const ap = createClient({ token: 'agt_temporary' }); // placeholder — auth endpoints don't need a valid token
await ap.requestToken('agent@example.com');

// Step 2: Verify OTP → receive tokens
const { token, webToken } = await ap.verifyOtp('agent@example.com', 123456);

// Step 3: Use the bot token for all subsequent calls
const client = createClient({ token }); // token is agt_...
const balance = await client.getBalanceCents();
```

The bot token is valid for 90 days by default. Rotate it before expiry:

```typescript
const { token: newToken } = await client.rotateToken(); // previous token invalidated immediately
const refreshed = createClient({ token: newToken });
```

## Configuration

```typescript
// Explicit config
const ap = createClient({
  token: 'agt_your_token',
  baseUrl: 'https://arch-dev.cypherd.io/v1', // optional, this is the default
});

// Or via environment variables
// AGENT_PAY_TOKEN=agt_your_token
// AGENT_PAY_BASE_URL=https://arch-dev.cypherd.io/v1
const ap = createClient();
```

## Operations

### Card Creation

`createCard` returns a status and tag but **no `cardId`**. Use `createCardAndResolve` instead — it creates the card and polls the listing until the `cardId` is available.

```typescript
// Simple creation (no cardId returned)
const result = await ap.createCard({
  tag: 'purchase-99',
  purpose: 'Office supplies',
  maxPerTransactionAmount: 200,
  dailyLimitUsd: 500,
  monthlyLimitUsd: 2000,
});
// result: { status: 'APPROVED', tag: 'purchase-99' }

// Create and resolve cardId (recommended)
const { cardId, tag } = await ap.createCardAndResolve({
  tag: 'purchase-99',
  purpose: 'Office supplies',
});
```

### Card Details

```typescript
// Reveal PAN/CVV/expiry — NEVER log or persist these values
const { pan, cvv, expiry } = await ap.revealCard(cardId);

// Parse expiry into month/year
import { parseExpiry } from '@cypherhq/agent-pay';
const { expiryMonth, expiryYear } = parseExpiry(expiry); // "03/27" → { "03", "2027" }

// Get card metadata
const card = await ap.getCard(cardId);
```

### Card Listing

```typescript
const allCards = await ap.listAllCards();
const tagged = await ap.listCardsByTag('order-42');
```

### Card Status

```typescript
// Freeze a card (prevents all charges)
await ap.freezeCard(cardId);

// Unfreeze
await ap.setCardStatus(cardId, 'active');

// Cancel permanently (irreversible)
await ap.cancelCard(cardId, 'Purchase complete');
```

### Card Limits

Default limits: $500/day, $5,000/month, $500/transaction, max 5 cards per agent.

```typescript
const limits = await ap.getCardLimits(cardId);

await ap.updateCardLimits(cardId, {
  dailyLimit: 100,
  monthlyLimit: 500,
  maxTransactionAmount: 50,
});
```

Agent-level rules override card-level limits:

```typescript
await ap.patchRules({
  maxCards: 10,
  dailyLimit: 1000,
  monthlyLimit: 5000,
  maxTransactionAmount: 500,
});
```

### Funding

Funding routes through the CypherD webapp. The SDK returns a `redirectUrl` that the bot hands to the user to open in a browser. The webapp handles the Transak widget, payment, and on-chain verification automatically.

```typescript
const { redirectUrl, quoteId } = await ap.getFundingUrl(50); // $50 USD

// Hand this URL to the user — the bot never touches the payment widget
console.log(`Open this link to add funds: ${redirectUrl}`);

// Poll balance until funds arrive
const cents = await ap.getBalanceCents();
```

The bot's job ends after sending the URL. The webapp handles everything else (rendering Transak, processing payment, reporting status).

`reportFundStatus` is still available as a manual fallback, but in the normal flow the webapp calls it automatically:

```typescript
// Manual fallback only — not needed in the normal flow
await ap.reportFundStatus({
  quoteId,
  transakOrderId: 'txn_abc123',
  status: 'COMPLETED',
});
```

### Web Sessions

If the bot needs to send the user to the CypherD webapp for any authenticated action (not just funding), mint a short-lived web session:

```typescript
const { webToken, expiresInSeconds, fundingUrl } = await ap.createWebSession();
// webToken is a 5-minute JWT — fundingUrl is a ready-to-open deep link
```

### Transactions

```typescript
// Per-card transactions (paginated)
const txns = await ap.getCardTransactions(cardId, {
  limit: 20,
  offset: 'cursor_from_previous_page',
  startDate: 1700000000, // Unix timestamp
  endDate: 1710000000,
});

// Cross-card transactions
const all = await ap.getAllTransactions({ limit: '50' });
```

### Spend Analytics

```typescript
const stats = await ap.getSpendStats({
  startDate: '2025-01-01',
  endDate: '2025-01-31',
});
```

### 3DS Challenge Handling

Some merchants require 3DS verification. The agent polls for pending challenges and approves/denies them programmatically.

```typescript
// Auto-poll and approve (recommended) — polls every 2s for up to 60s
const result = await ap.pollAndApprove3ds(cardId);
if (result.approved) {
  console.log(`3DS approved: ${result.requestId}`);
}

// Manual flow
const { requestId, raw } = await ap.get3dsStatus(cardId);
if (requestId) {
  await ap.approve3ds(requestId);
  // or: await ap.deny3ds(requestId);
}
```

## Common Patterns

### Single-Use Card

Create a card with tight limits, use it for one purchase, freeze immediately.

```typescript
const singleUseCheckout = async (
  ap: AgentPayClient,
  amount: number,
  description: string,
) => {
  const { cardId } = await ap.createCardAndResolve({
    tag: `single-${Date.now()}`,
    purpose: description,
    maxPerTransactionAmount: amount,
  });

  try {
    const { pan, cvv, expiry } = await ap.revealCard(cardId);
    // ... submit payment with pan/cvv/expiry ...

    // Handle 3DS if triggered
    await ap.pollAndApprove3ds(cardId, { timeoutMs: 30_000 });
  } finally {
    await ap.freezeCard(cardId); // Always freeze, even on failure
  }

  return cardId;
};
```

### Budget-Capped Spending

Enforce a spending ceiling by checking balance before each purchase.

```typescript
const spendWithBudget = async (
  ap: AgentPayClient,
  budgetCents: number,
  purchaseAmountCents: number,
) => {
  const available = await ap.getBalanceCents();
  if (available < purchaseAmountCents) {
    throw new Error(`Insufficient balance: ${available}c < ${purchaseAmountCents}c`);
  }
  if (purchaseAmountCents > budgetCents) {
    throw new Error(`Purchase ${purchaseAmountCents}c exceeds budget ${budgetCents}c`);
  }

  const { cardId } = await ap.createCardAndResolve({
    tag: `budget-${Date.now()}`,
    maxPerTransactionAmount: purchaseAmountCents / 100,
  });

  try {
    const details = await ap.revealCard(cardId);
    // ... use details for checkout ...
  } finally {
    await ap.freezeCard(cardId);
  }
};
```

### Spend Auditing

Periodically review all transactions for anomalies.

```typescript
const auditSpending = async (ap: AgentPayClient) => {
  const stats = await ap.getSpendStats({
    startDate: '2025-01-01',
    endDate: '2025-01-31',
  });

  const allTxns = await ap.getAllTransactions({ limit: '100' });
  const cards = await ap.listAllCards();

  // Freeze any cards that are still active but no longer needed
  for (const card of cards) {
    const c = card as { cardId: string; status: string };
    if (c.status === 'active') {
      await ap.freezeCard(c.cardId);
    }
  }
};
```

## Error Handling

The SDK throws two error types, both with a `type` discriminant:

```typescript
import {
  createClient,
  AgentPayAuthError,
  AgentPayApiError,
} from '@cypherhq/agent-pay';

try {
  await ap.getBalanceCents();
} catch (err) {
  if (err instanceof AgentPayAuthError) {
    // err.type === 'auth'
    // Token invalid or expired — re-authenticate
    console.error('Auth failed — rotate or re-issue token');
  } else if (err instanceof AgentPayApiError) {
    // err.type === 'api'
    console.error(`API ${err.status} on ${err.path}: ${err.body}`);
  }
}
```

## Security Rules

1. **Never log, persist, or include in error messages**: PAN, CVV, expiry, or full token values
2. **Always freeze cards after use**, even on failure — use `try/finally`
3. **Token prefix**: must start with `agt_` — the SDK rejects anything else
4. **Rotate tokens** before the 90-day expiry using `rotateToken()`

## SDK Reference

Language: TypeScript (ESM)
Install: `npm install @cypherhq/agent-pay`
Runtime dependencies: None (uses native `fetch`)
Node requirement: >= 22.13.0

Key exports:
- `createClient(config?)` — factory returning a frozen record of functions
- `parseExpiry(expiry)` — parse `MM/YY` or `MM/YYYY` into `{ expiryMonth, expiryYear }`
- `AgentPayAuthError` — thrown on 401
- `AgentPayApiError` — thrown on non-2xx (carries `status`, `path`, `body`)

Environment variables:
- `AGENT_PAY_TOKEN` — bot token (required unless passed in config)
- `AGENT_PAY_BASE_URL` — API base URL (optional)
