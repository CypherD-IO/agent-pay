# agent-pay skill

Agent skill for [Cypher Agent Pay](https://cypherhq.io/agent-pay) — gives AI agents the ability to create virtual Visa cards, make purchases, and manage card lifecycle.

## Install

**Via [skills.sh](https://skills.sh):**
```bash
npx skills add CypherD-IO/agent-pay
```

**Via [Tessl](https://tessl.io):**
```bash
tessl skill install github:CypherD-IO/agent-pay
```

**Manual:**
```bash
cp skills/agent-pay/SKILL.md ~/.claude/commands/agent-pay.md
```

## What it does

When a user asks an AI agent to buy something, this skill handles the full payment flow:

1. **Onboarding** — email OTP, identity verification (once ever)
2. **Funding** — check balance, add funds via redirect URL
3. **Card creation** — virtual Visa sized to the purchase
4. **Checkout** — reveal card details, fill payment forms
5. **3D Secure** — auto-approve or guide user through OTP
6. **Cleanup** — cancel or freeze card after use

## Prerequisites

The skill uses the `@cypherhq/agent-pay` CLI. It is installed automatically on first run:
```bash
npm install -g @cypherhq/agent-pay
```

## Links

- [Website](https://cypherhq.io/agent-pay)
- [npm package](https://www.npmjs.com/package/@cypherhq/agent-pay)
- [GitHub](https://github.com/CypherD-IO/agent-pay)
- [Dashboard & Sign up](https://agentpay.cypherhq.io)
