# @cypherhq/agent-pay

[![npm version](https://img.shields.io/npm/v/@cypherhq/agent-pay.svg)](https://www.npmjs.com/package/@cypherhq/agent-pay)
[![npm downloads](https://img.shields.io/npm/dm/@cypherhq/agent-pay.svg)](https://www.npmjs.com/package/@cypherhq/agent-pay)
[![license](https://img.shields.io/npm/l/@cypherhq/agent-pay.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/@cypherhq/agent-pay.svg)](./src/index.ts)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)

> Zero-dependency TypeScript client for the **CypherHQ Agent-Pay** virtual card API.
> Build AI agents that issue programmable Visa cards, fund them with fiat, and make real purchases — with spend limits, 3DS handling, and card lifecycle management.

---

## Why

LLM agents need a way to pay for things without a human swiping a card. `@cypherhq/agent-pay` gives your agent a programmatic interface to:

- **Mint virtual Visa cards on demand** with per-transaction, daily, and monthly limits
- **Reveal card details** (PAN/CVV/expiry) for checkout
- **Auto-approve 3D Secure challenges** during payment
- **Cancel or freeze cards** after use
- **Audit every transaction** across all cards

Framework-agnostic. Zero npm dependencies — uses only Node.js built-ins (`fetch`, `node:crypto`).

## Install

```bash
npm install @cypherhq/agent-pay
# or: yarn add | pnpm add | bun add
```

Requires **Node.js ≥ 22.13**.

## Quick start

```ts
import { createClient } from '@cypherhq/agent-pay';

const ap = createClient({ token: process.env.AGENT_PAY_TOKEN });

// 1. Check balance
const cents = await ap.getBalanceCents();
console.log(`Available: $${(cents / 100).toFixed(2)}`);

// 2. Create a card with a $50 per-transaction cap
const { cardId } = await ap.createCardAndResolve({
  tag: `order-${Date.now()}`,
  purpose: 'Buy headphones',
  maxPerTransactionAmount: 50,
});

try {
  // 3. Reveal card details for checkout — NEVER log these
  const { pan, cvv, expiry } = await ap.revealCard(cardId);
  // ... pass pan/cvv/expiry to merchant checkout ...

  // 4. Auto-approve any 3DS challenge
  await ap.pollAndApprove3ds(cardId);
} finally {
  // 5. Always cancel after use, even on failure
  await ap.cancelCard(cardId);
}
```

## Authentication

Bot tokens are provisioned via [agentpay.cypherhq.io](https://agentpay.cypherhq.io). Pass via env or config:

```ts
// Option A: environment
// AGENT_PAY_TOKEN=agt_...
const ap = createClient();

// Option B: explicit
const ap = createClient({ token: 'agt_...' });
```

For first-time onboarding (OTP → bot token), see [`SKILL.md`](./SKILL.md#authentication).

## Configuration

| Option | Env var | Default | Notes |
|---|---|---|---|
| `token` | `AGENT_PAY_TOKEN` | — | **Required.** Must start with `agt_`. |
| `baseUrl` | `AGENT_PAY_BASE_URL` | `https://arch.cypherd.io/v1` | Override for self-hosted or staging. |

## API at a glance

```ts
const ap = createClient(config);

// Balance + funding
ap.getBalanceCents()
ap.getFundingUrl(usdAmount)

// Cards
ap.createCardAndResolve({ tag, purpose, maxPerTransactionAmount, dailyLimitUsd, monthlyLimitUsd })
ap.revealCard(cardId)            // SECRET — never log
ap.cancelCard(cardId, reason?)
ap.freezeCard(cardId)            // reusable-card mode only
ap.listAllCards()
ap.listCardsByTag(tag)

// 3DS
ap.pollAndApprove3ds(cardId, { timeoutMs?, intervalMs? })

// Limits + rules
ap.patchRules({ maxCards, dailyLimit, monthlyLimit, maxTransactionAmount })

// Transactions + analytics
ap.getCardTransactions(cardId, opts?)
ap.getAllTransactions(opts?)
ap.getSpendStats({ startDate, endDate })
```

Full surface and JSDoc available via TypeScript autocomplete. Integration walkthrough in [`SKILL.md`](./SKILL.md).

## Error handling

Two error types, both with a `type` discriminant:

```ts
import { AgentPayAuthError, AgentPayApiError } from '@cypherhq/agent-pay';

try {
  await ap.getBalanceCents();
} catch (err) {
  if (err instanceof AgentPayAuthError) {
    // 401 — token invalid or expired
  } else if (err instanceof AgentPayApiError) {
    console.error(`API ${err.status} on ${err.path}: ${err.body}`);
  }
}
```

## Security

1. **Never log, persist, or transmit** PAN, CVV, expiry, or full token values returned by `revealCard()`.
2. **Always cancel cards after use**, even on failure — wrap reveal in `try/finally`. Use `freezeCard` only in reusable-card mode.
3. Card reveal uses **client-side decryption** — PAN/CVV never touch the backend.
4. Tokens must start with `agt_` — anything else is rejected immediately.

To report a security issue, see [`SECURITY.md`](./SECURITY.md).

## License

[MIT](./LICENSE) © CypherHQ
