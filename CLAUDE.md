# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# @cypherhq/agent-pay

## What this is

A framework-agnostic TypeScript client for the CypherHQ Agent-Pay virtual card API. Zero runtime dependencies — only uses `fetch`. Published as `@cypherhq/agent-pay` on npm.

Users of this package are developers building AI agents that need to make real purchases. They call `createClient()`, then use the returned functions to create virtual cards, reveal card details, handle 3DS challenges, and freeze cards after checkout.

## Architecture

This package is written in a **functional style**:

- **No classes for the client.** `createClient(config)` is a factory that returns a `Object.freeze()`'d record of functions. Config is captured via closure — no `this`, no `new`, no mutable state.
- **Pure functions** for all data transformations (`parseExpiry`, `toBalanceCents`, `unwrapCardList`, `findByCardTag`, `extractRequestId`, `coerceNum`, `resolveConfig`). Only `parseExpiry` is part of the public API (`index.ts`). The rest are exported from `client.ts` for testability via `internals.ts`, but not re-exported from `index.ts`.
- **Generic async combinators** (`retryOn`, `pollUntil`, `delay`) handle retry/polling logic. Both use recursive inner functions (`go`) instead of mutable loops.
- **All types are `readonly`.**
- **Errors** use a discriminated union via a `type` tag (`'auth' | 'api'`) and are thrown at the side-effect boundary (`botFetch`).
- **Single side-effect boundary:** all network I/O goes through `botFetch`, which is wrapped by `get`/`post`/`patch` helpers inside the closure.

When adding new functionality, follow these patterns. Do not introduce classes, mutable state, or `let` bindings.

## File structure

```
src/
  client.ts        — All logic: types, errors, pure functions, combinators, client factory
  index.ts         — Public re-exports only
  internals.ts     — Re-exports module-private pure functions for testing (not part of public API)
  __tests__/
    client.test.ts — Unit tests for pure functions + client with mocked fetch
```

## Commands

```bash
npm run build        # tsc → dist/
npm test             # vitest run
npx vitest run -t 'test name'  # run a single test by name
npx tsc --noEmit     # type-check without emitting
```

## Public API surface

Exported from `index.ts`:

| Export | Kind | Description |
|---|---|---|
| `createClient(config?)` | function | Factory — returns a frozen `AgentPayClient` record |
| `parseExpiry(expiry)` | function | Parse `MM/YY` or `MM/YYYY` into `{ expiryMonth, expiryYear }` |
| `AgentPayAuthError` | class | Thrown on 401 — token invalid/expired |
| `AgentPayApiError` | class | Thrown on non-2xx — carries `status`, `path`, `body` |
| `AgentPayClient` | type | The record type returned by `createClient` |
| `AgentPayConfig` | type | `{ token?, baseUrl? }` |
| `AgentPayError` | type | Union: `AgentPayAuthError \| AgentPayApiError` |
| `CreateCardInput` | type | Input for card creation |
| `CreateCardResponse` | type | Response from `POST /card` |
| `RevealCardResponse` | type | PAN/CVV/expiry from `/reveal` |
| `ThreeDsStatus` | type | 3DS status check result |
| `ThreeDsPollResult` | type | Result of `pollAndApprove3ds` |
| `ResolvedCard` | type | `{ cardId, tag }` from `createCardAndResolve` |
| `ParsedExpiry` | type | `{ expiryMonth, expiryYear }` |
| `Rules` | type | Agent rule set for `patchRules` |

## `AgentPayClient` methods

The record returned by `createClient()` has these functions:

| Function | Description |
|---|---|
| `requestToken(email)` | Request an OTP for authentication. |
| `verifyOtp(email, otp)` | Verify OTP and receive a bot token. |
| `submitApplication(details)` | Submit KYC/onboarding application. |
| `getKycStatus()` | Check KYC verification status. |
| `pollKycUntilComplete(opts?)` | Poll until KYC reaches `"completed"`. |
| `getAgent()` | Validate the token. Throws `AgentPayAuthError` on 401. |
| `getBalanceCents()` | Available balance in USD cents. |
| `createCard(input)` | Create a virtual card. Returns `{ status, tag }` — **no `cardId`**. |
| `createCardAndResolve(input)` | Create + poll listing to resolve `cardId`. Retries on transient failures. |
| `listAllCards()` | List all cards on the agent. |
| `listCardsByTag(tag)` | List cards filtered by tag. |
| `getCardRequest(cardId)` | Get the original card creation request. |
| `getCard(cardId)` | Get card details by ID. |
| `cancelCard(cardId, reason?)` | Permanently cancel a card. Closed at the provider, cannot be reactivated. |
| `revealCard(cardId)` | Reveal PAN/CVV/expiry. **SECRET — never log.** |
| `getCardTransactions(cardId)` | Get transactions for a specific card. |
| `getCardLimits(cardId)` | Get spend limits for a card. |
| `updateCardLimits(cardId, limits)` | Update spend limits for a card. |
| `setCardStatus(cardId, status)` | Freeze (`'inactive'`) or unfreeze (`'active'`). |
| `freezeCard(cardId)` | Shorthand for `setCardStatus(cardId, 'inactive')`. |
| `patchRules(rules)` | Update agent rules (limits, max cards). |
| `get3dsStatus(cardId)` | Check for pending 3DS challenge. |
| `approve3ds(requestId)` | Approve a 3DS challenge. |
| `deny3ds(requestId)` | Deny a 3DS challenge. |
| `pollAndApprove3ds(cardId, opts?)` | Poll for 3DS challenges and auto-approve. Default: 60s timeout, 2s interval. |
| `getFundingUrl()` | Get a URL for funding the agent's balance. |
| `reportFundStatus(status)` | Report funding completion status. |
| `getAllTransactions(params?)` | Get all transactions across cards. |
| `getSpendStats(params?)` | Get aggregated spend statistics. |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AGENT_PAY_TOKEN` | Yes (unless passed in config) | Bot token, must start with `agt_` |
| `AGENT_PAY_BASE_URL` | No | API base URL. Defaults to `https://arch-dev.cypherd.io/v1` |

## Security rules — MUST follow

1. **Never log, persist, or include in error messages:** PAN, CVV, expiry, or full token values.
2. **Never expose backend implementation details** in comments, error messages, or type names. This is a public package — no references to specific databases, internal field names, or infrastructure. Treat the API as a black box.
3. **Token validation:** must start with `agt_`. Reject anything else immediately.
4. **Card lifecycle:** always freeze after use, even on failure. Document this expectation in JSDoc.

## API behavior to be aware of

- `POST /card` returns `{ status: "APPROVED", tag }` with **no `cardId`**. The `createCardAndResolve` function handles this by polling the card listing.
- `GET /balance` returns **string-encoded USD**, not numbers. The `toBalanceCents` pure function handles parsing.
- The card listing endpoint returns varying shapes (raw array, or wrapped in `cards`/`data`/`items`/`results`). The `unwrapCardList` function normalizes this.
- Cards are matched in listings by the `cardTag` field (not `tag`).
- 3DS challenge response shape is provider-dependent — `extractRequestId` walks multiple candidate field names.
- Tags must be unique per agent. `createCardAndResolve` appends retry suffixes (`-r2`, `-r3`) on transient failures.

## Conventions

- All interfaces use `readonly` fields
- No `let` — use `const` exclusively
- No mutation — use recursive functions or `reduce` instead of mutable loops
- Arrow functions for everything except error class constructors
- JSDoc on all public exports
- Keep comments minimal and user-facing (no internal implementation details)

## Testing

Tests use vitest (`npm test`). Test file: `src/__tests__/client.test.ts`. Tests are excluded from the TypeScript build via `tsconfig.json`.

Pure functions are tested by importing from `src/internals.ts` (which re-exports module-private functions from `client.ts`). Client functions are tested with a mocked `fetch` via `vi.stubGlobal`.

## What NOT to do

- Do not add runtime dependencies. This package must stay zero-dep.
- Do not add framework-specific code (Mastra, LangChain, etc.). Framework integrations belong in separate packages.
- Do not add caching, storage, or filesystem operations. Consumers handle their own persistence.
- Do not convert the functional architecture to classes.
- Do not reference backend infrastructure (database names, internal services, queue systems) anywhere in the codebase.

