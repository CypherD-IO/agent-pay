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

Agents authenticate via email OTP. The bot token (`agt_` prefix) is provisioned separately via the CypherD webapp.

```typescript
import { createClient } from '@cypherhq/agent-pay';

// Step 1: Request OTP (no auth required)
const ap = createClient({ token: 'agt_temporary' }); // placeholder — auth endpoints don't need a valid token
await ap.requestToken('agent@example.com');

// Step 2: Verify OTP → receive agentId + web token
const { agentId, webToken } = await ap.verifyOtp('agent@example.com', 1234);
// agentId — your agent identifier
// webToken — short-lived JWT for the CypherD web UI (not the bot token)

// The agt_ bot token is provisioned via the CypherD webapp, not this SDK.
// Set it as AGENT_PAY_TOKEN or pass it to createClient({ token: 'agt_...' }).
```

## Configuration

```typescript
// Explicit config
const ap = createClient({
  token: 'agt_your_token',
  baseUrl: 'https://arch.cypherd.io/v1', // optional, this is the default
});

// Or via environment variables
// AGENT_PAY_TOKEN=agt_your_token
// AGENT_PAY_BASE_URL=https://arch.cypherd.io/v1
const ap = createClient();
```

## Operations

### Onboarding

Submit a card application, complete KYC, and verify your agent is set up.

```typescript
// Submit application with personal details
const app = await ap.submitApplication({
  firstName: 'Alice',
  lastName: 'Smith',
  phone: '+14155551234',
  email: 'alice@example.com',
  dateOfBirth: '1990-01-15',
  line1: '123 Main St',
  city: 'San Francisco',
  state: 'CA',
  country: 'US',
  postalCode: '94105',
});
// app.kycUrl — open in browser to complete identity verification

// Poll KYC status until approved (default: 5min timeout, polls every 5s)
const kyc = await ap.pollKycUntilComplete();

// Or check manually
const kycStatus = await ap.getKycStatus();

// Verify agent is active
const agent = await ap.getAgent();
```

### Balance

```typescript
const cents = await ap.getBalanceCents();
console.log(`Available: $${(cents / 100).toFixed(2)}`);
```

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

// Check status of a pending card creation request
const request = await ap.getCardRequest(requestId);
// request: { status, cardId?, purpose?, agentId? }

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

Daily, monthly, and per-transaction limits are controlled at the **agent level** via `patchRules`, or set per card at creation time:

```typescript
// Agent-level rules (apply as ceilings to all cards)
await ap.patchRules({
  maxCards: 10,
  dailyLimit: 1000,
  monthlyLimit: 5000,
  maxTransactionAmount: 500,
});

// Per-card limits set at creation (capped by agent rules)
const { cardId } = await ap.createCardAndResolve({
  tag: 'order-1',
  maxPerTransactionAmount: 50,
  dailyLimitUsd: 200,
  monthlyLimitUsd: 1000,
});
```

`getCardLimits` and `updateCardLimits` expose provider-level card controls (merchant restrictions, transaction channel settings, etc.):

```typescript
const limits = await ap.getCardLimits(cardId);
```

### Funding

Funding routes through the CypherD webapp. The SDK returns a `redirectUrl` that the bot hands to the user to open in a browser. The webapp handles the Transak widget, payment, and on-chain verification automatically.

```typescript
const { redirectUrl, quoteId, urlExpiresAt } = await ap.getFundingUrl(50); // $50 USD

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
4. **Rotate tokens** before the 90-day expiry — token rotation is handled via the CypherD webapp, not this SDK

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

Types:
- `AgentPayClient` — the record type returned by `createClient`
- `AgentPayConfig` — `{ token?, baseUrl? }`
- `AgentPayError` — union: `AgentPayAuthError | AgentPayApiError`
- `CreateCardInput` — input for card creation
- `CreateCardResponse` — response from card creation
- `RevealCardResponse` — PAN/CVV/expiry from reveal
- `ResolvedCard` — `{ cardId, tag }` from `createCardAndResolve`
- `ApplicationInput` — personal details for onboarding
- `ApplicationResponse` — application result with `kycUrl`
- `KycStatusResponse` — KYC verification status
- `VerifyOtpResponse` — `{ agentId, webToken }` from OTP verification
- `CardDetail` — card metadata
- `CardRequestStatus` — card creation request status
- `TransactionQueryOpts` — per-card transaction query parameters
- `FundingUrlResponse` — `{ redirectUrl, quoteId, urlExpiresAt }`
- `FundStatusInput` — manual funding status report
- `CancelCardResponse` — cancel confirmation
- `ThreeDsStatus` — 3DS status check result
- `ThreeDsPollResult` — result of `pollAndApprove3ds`
- `ParsedExpiry` — `{ expiryMonth, expiryYear }`
- `Rules` — agent rule set for `patchRules`

Environment variables:
- `AGENT_PAY_TOKEN` — bot token (required unless passed in config)
- `AGENT_PAY_BASE_URL` — API base URL (optional)
