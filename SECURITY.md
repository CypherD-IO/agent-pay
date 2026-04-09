# Security Policy

## Supported Versions

Only the latest published version of `@cypherhq/agent-pay` receives security updates.

## Reporting a Vulnerability

If you believe you have found a security vulnerability in this SDK, please report it privately. **Do not open a public GitHub issue.**

Email: **support@cypherhq.io**

Include:
- A description of the issue
- Steps to reproduce
- Affected version(s)
- Any proof-of-concept code

You should receive an acknowledgement within 3 business days. We will work with you to assess the issue, prepare a fix, and coordinate disclosure.

## Handling Card Data

This SDK exposes virtual card PAN, CVV, and expiry through `revealCard()`. Consumers MUST NOT log, persist, or transmit these values outside of the immediate checkout flow.
