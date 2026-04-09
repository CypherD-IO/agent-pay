# @cypherhq/agent-pay

Framework-agnostic TypeScript client for the CypherHQ Agent-Pay virtual card API. Zero runtime dependencies.

## Install

```bash
npm install @cypherhq/agent-pay
# or
yarn add @cypherhq/agent-pay
# or
pnpm add @cypherhq/agent-pay
# or
bun add @cypherhq/agent-pay
```

## Quick Start

```ts
import { createClient } from '@cypherhq/agent-pay';

const ap = createClient({ token: 'agt_...' });

// 1. Check balance
const cents = await ap.getBalanceCents();
console.log(`Available: $${(cents / 100).toFixed(2)}`);

// 2. Create a card and resolve its ID
const { cardId, tag } = await ap.createCardAndResolve({
  tag: 'order-42',
  purpose: 'Buy supplies',
});

// 3. Reveal card details (SECRET — never log these)
const { pan, cvv, expiry } = await ap.revealCard(cardId);

// 4. Use the card for checkout ...

// 5. Always freeze after use, even on failure
await ap.freezeCard(cardId);
```

### 3DS Challenges

Some merchants require 3D Secure verification. After initiating a payment, poll for and auto-approve challenges:

```ts
const result = await ap.pollAndApprove3ds(cardId, {
  timeoutMs: 60_000,
  intervalMs: 2_000,
});

if (result.approved) {
  console.log('3DS challenge approved');
}
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AGENT_PAY_TOKEN` | Yes (unless passed in config) | Bot token — must start with `agt_` |
| `AGENT_PAY_BASE_URL` | No | API base URL. Defaults to `https://arch-dev.cypherd.io/v1` |

You can pass these directly in the config instead:

```ts
const ap = createClient({
  token: process.env.AGENT_PAY_TOKEN,
  baseUrl: process.env.AGENT_PAY_BASE_URL,
});
```

## API Reference

See the [Agent-Pay API docs](https://docs.cypherhq.com/agent-pay) for full endpoint documentation.

## Security

- **Never log or persist** PAN, CVV, expiry, or full token values returned by `revealCard()`.
- **Always freeze cards** after checkout using `freezeCard()`, even on failure (use `try/finally`).
- Tokens must start with `agt_` — anything else is rejected immediately.

## License

MIT
