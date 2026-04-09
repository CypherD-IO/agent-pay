# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

`@cypherhq/agent-pay` — zero-dependency TypeScript client for the CypherHQ Agent-Pay virtual card API. Consumers are developers building AI agents that make real purchases.

Public API lives in `src/index.ts`. Implementation in `src/client.ts`. Module-private pure functions re-exported via `src/internals.ts` for tests only.

## Architecture (non-negotiable)

- **Functional, not OO.** `createClient` is a factory returning a `Object.freeze()`'d record of arrow functions. Config captured via closure. No `this`, no `new`, no classes (except the two error classes).
- **Single side-effect boundary:** all network I/O goes through `botFetch` inside the closure. Wrapped by `get`/`post`/`patch`/`del` helpers.
- **Pure functions** for all data transformation. No I/O, no time, no randomness.
- **Async combinators** (`retryOn`, `pollUntil`) use recursive inner `go` functions, not mutable loops.
- **Errors** are a discriminated union via a `type` tag (`'auth' | 'api'`), thrown only at the boundary.

When adding functionality, follow these patterns. No classes, no `let`, no mutation.

## Security rules — MUST follow

1. **Never log, persist, or include in error messages:** PAN, CVV, expiry, full tokens.
2. **Never expose backend implementation details** — no DB names, internal field names, vendor names, or infra references in code, comments, types, or tests. Public package — treat the API as a black box.
3. **Token validation:** must start with `agt_`. Reject anything else immediately.
4. **Card lifecycle:** always freeze after use, even on failure. Document in JSDoc.

## API quirks (not obvious from code)

- `POST /card` → `{ status, tag, cardId? }`. Sync success: `status === "CARD_CREATED"` with `cardId`. Sync miss: `status === "APPROVED"`, `cardId` undefined (finalizes async). `createCardAndResolve` short-circuits when `cardId` present, else polls listing.
- `GET /balance` returns **string-encoded USD**, not numbers. `toBalanceCents` handles it.
- Card listing returns varying shapes (raw array, or wrapped in `cards`/`data`/`items`/`results`). `unwrapCardList` normalizes.
- Cards match by `cardTag` field (not `tag`).
- 3DS response shape is provider-dependent — `extractRequestId` walks candidate fields.
- Tags must be unique per agent. `createCardAndResolve` appends `-r2`/`-r3` on retry.

## Conventions

- `readonly` on all interface fields. `const` only — never `let`. Arrow functions everywhere except error class constructors. JSDoc on all public exports. Comments minimal and user-facing.

## Environment variables

- `AGENT_PAY_TOKEN` — bot token, must start with `agt_`. Required unless passed in config.
- `AGENT_PAY_BASE_URL` — defaults to `https://arch.cypherd.io/v1`.

## Testing

`npm test` (vitest). Pure functions imported from `src/internals.ts`. Client tested with mocked `fetch` via `vi.stubGlobal`. Tests excluded from build via `tsconfig.json`.

## What NOT to do

- Add runtime dependencies. Stay zero-dep.
- Add framework-specific code (Mastra, LangChain, etc.). Integrations belong in separate packages.
- Add caching, storage, or filesystem operations. Consumers handle persistence.
- Convert to classes.
- Reference backend infrastructure anywhere in the codebase.
