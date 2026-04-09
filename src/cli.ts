#!/usr/bin/env node

/**
 * @cypherhq/agent-pay CLI
 *
 * Thin argv → client bridge. Zero dependencies. All output is JSON to stdout,
 * all errors go to stderr. Exit 0 on success, 1 on usage error, 2 on API error.
 *
 * Environment:
 *   AGENT_PAY_TOKEN   — required, must start with `agt_`
 *   AGENT_PAY_BASE_URL — optional, defaults to production
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClient, AgentPayAuthError, AgentPayApiError, parseExpiry } from './client.js';

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

const TOKEN_DIR = join(homedir(), '.config', 'cypher-pay');
const TOKEN_FILE = join(TOKEN_DIR, 'token');

const loadStoredToken = (): string | undefined => {
  try {
    const t = readFileSync(TOKEN_FILE, 'utf8').trim();
    return t.startsWith('agt_') ? t : undefined;
  } catch { return undefined; }
};

const storeToken = (t: string): void => {
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
};

// ---------------------------------------------------------------------------
// Argv helpers (zero-dep)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0] ?? '';
const BOOL_FLAGS = new Set(['pretty', 'masked', 'reveal', 'json', 'all']);

/** Pull `--flag value` from args. Returns undefined if absent. */
const flag = (name: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
};

/** Pull `--flag value` as a number. */
const numFlag = (name: string): number | undefined => {
  const v = flag(name);
  return v === undefined ? undefined : Number(v);
};

/** Positional arg at index (0-based, after the subcommand). */
const positional = (i: number): string | undefined => {
  // Skip flag pairs to find bare positionals; boolean flags have no value to skip
  const bare: string[] = [];
  let skip = false;
  for (const a of args.slice(1)) {
    if (skip) { skip = false; continue; }
    if (a.startsWith('--')) {
      if (!BOOL_FLAGS.has(a.slice(2))) skip = true;
      continue;
    }
    bare.push(a);
  }
  return bare[i];
};

// ---------------------------------------------------------------------------
// ANSI colors + spinner (zero-dep)
// ---------------------------------------------------------------------------

const noColor = process.env.NO_COLOR !== undefined;
const isTTY = process.stderr.isTTY ?? false;
const ansi = (code: string) => (s: string) => noColor ? s : `\x1b[${code}m${s}\x1b[0m`;

const DOTS = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'] as const;

const spinner = (msg: string) => {
  if (!isTTY) return { stop: () => {} };
  let i = 0;
  const id = setInterval(() => {
    process.stderr.write(`\r${cyan(DOTS[i % DOTS.length]!)} ${msg}`);
    i++;
  }, 80);
  return {
    stop: () => {
      clearInterval(id);
      process.stderr.write(`\r${' '.repeat(msg.length + 4)}\r`);
    },
  };
};
const bold = ansi('1');
const dim = ansi('2');
const green = ansi('32');
const cyan = ansi('36');
const yellow = ansi('33');
const red = ansi('31');

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const json = args.includes('--json');

const out = (data: unknown): never => {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  return process.exit(0);
};

const print = (text: string): never => {
  if (json) return out(text);
  process.stdout.write(text + '\n');
  return process.exit(0);
};

const printLines = (lines: readonly string[]): never => {
  process.stdout.write(lines.join('\n') + '\n');
  return process.exit(0);
};

const label = (key: string, value: string) => `${dim(key)} ${bold(value)}`;

const statusColor = (s: string): string => {
  const lower = s.toLowerCase();
  if (lower === 'active') return green(s);
  if (lower === 'cancelled') return red(s);
  if (lower === 'inactive' || lower === 'frozen') return yellow(s);
  return s;
};

/** Format a card row for list-cards table. */
const formatCardRow = (c: Record<string, unknown>): string => {
  const tag = String(c.cardTag ?? c.tag ?? '—').padEnd(24);
  const last4 = String(c.last4 ?? '????').padStart(4);
  const status = statusColor(String(c.status ?? ''));
  return `  ${bold(tag)} ${dim('****')} ${last4}   ${status}`;
};

const die = (msg: string, code = 1): never => {
  process.stderr.write(`Error: ${msg}\n`);
  return process.exit(code);
};

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP = `Usage: agent-pay <command> [options]

Commands:
  auth-status <email>               Check if email is enrolled and KYC-complete (no OTP sent)
  request-token <email>             Send a one-time password to an email address
  verify-otp <email> <otp>          Verify OTP and receive bot token
  submit-application                Submit KYC application
    --firstName <text>             First name (required)
    --lastName <text>              Last name (required)
    --email <text>                 Email (required)
    --phone <text>                 Phone (required)
    --dob <text>                   Date of birth YYYY-MM-DD (required)
    --line1 <text>                 Address line 1 (required)
    --line2 <text>                 Address line 2
    --city <text>                  City (required)
    --state <text>                 State (required)
    --country <text>               Country code (required)
    --postalCode <text>            Postal code (required)
    --middleName <text>            Middle name
  balance                          Get available balance in USD cents
  create-card                      Create a virtual card and wait for it to resolve
    --purpose <text>               Card purpose description
    --tag <text>                   Unique tag for this card (required)
    --limit <usd>                  Per-transaction limit in USD
    --daily-limit <usd>            Daily spending limit in USD
    --monthly-limit <usd>          Monthly spending limit in USD
    --reveal                       Show full PAN/CVV/expiry
    --pretty                       Show ASCII art card
  freeze <cardId|--tag>            Freeze (deactivate) a card
  unfreeze <cardId|--tag>          Unfreeze (reactivate) a card
  cancel-card <cardId|--tag>       Permanently cancel a card
    --reason <text>                Optional cancellation reason
  list-cards                       List active cards (--all includes cancelled)
  get-card <cardId|--tag>          Get card details
    --reveal                       Show full PAN/CVV/expiry
    --pretty                       Show ASCII art card
  kyc-status                       Check KYC application status
  agent                            Get agent account info
  3ds-poll <cardId>                Poll for 3DS challenge and auto-approve
    --timeout <ms>                 Poll timeout (default 60000)
    --interval <ms>                Poll interval (default 2000)
  wait-for-txn <cardId>            Poll until a transaction appears on the card
    --timeout <ms>                 Poll timeout (default 30000)
    --interval <ms>                Poll interval (default 3000)
  fund <amount>                    Get a funding redirect URL (amount in USD)
  transactions                     Get cross-card transaction history
  spend-stats                      Get spending statistics
    --start <date>                 Start date (ISO string)
    --end <date>                   End date (ISO string)

Environment:
  AGENT_PAY_TOKEN      Bot token (required, must start with agt_)
  AGENT_PAY_BASE_URL   API base URL (optional)

Flags:
  --help, -h             Show this help message
  --schema               Output machine-readable JSON schema of all commands
`;

// ---------------------------------------------------------------------------
// Schema — machine-readable command descriptions for AI agents
// ---------------------------------------------------------------------------

const SCHEMA = {
  name: '@cypherhq/agent-pay',
  description: 'CLI for the CypherHQ Agent-Pay virtual card API. Create and manage virtual cards for AI agent purchases.',
  env: {
    AGENT_PAY_TOKEN: { required: true, description: 'Bot token, must start with agt_' },
    AGENT_PAY_BASE_URL: { required: false, description: 'API base URL (defaults to production)' },
  },
  commands: {
    'auth-status': {
      description: 'Check if an email is already enrolled in Agent-Pay and whether KYC is complete. No OTP sent, no auth required. Use this to decide whether to run onboarding.',
      args: [{ name: 'email', type: 'string', required: true, description: 'Email address to check' }],
      flags: [],
      output: { enrolled: 'boolean', kycComplete: 'boolean' },
    },
    'request-token': {
      description: 'Send a one-time password to an email address. No auth token required. First step of onboarding.',
      args: [{ name: 'email', type: 'string', required: true, description: 'Email address to send OTP to' }],
      flags: [],
      output: 'void (OTP sent to email)',
    },
    'verify-otp': {
      description: 'Verify OTP received by email. Returns bot token (agt_...) for all subsequent commands. No auth token required.',
      args: [
        { name: 'email', type: 'string', required: true, description: 'Email used in request-token' },
        { name: 'otp', type: 'number', required: true, description: 'One-time password from email' },
      ],
      flags: [],
      output: { agentId: 'string', token: 'string — save this as AGENT_PAY_TOKEN' },
    },
    'submit-application': {
      description: 'Submit KYC identity verification application. Required before creating cards.',
      args: [],
      flags: [
        { name: 'firstName', type: 'string', required: true, description: 'First name' },
        { name: 'lastName', type: 'string', required: true, description: 'Last name' },
        { name: 'email', type: 'string', required: true, description: 'Email address' },
        { name: 'phone', type: 'string', required: true, description: 'Phone number' },
        { name: 'dob', type: 'string', required: true, description: 'Date of birth (YYYY-MM-DD)' },
        { name: 'line1', type: 'string', required: true, description: 'Address line 1' },
        { name: 'line2', type: 'string', required: false, description: 'Address line 2' },
        { name: 'city', type: 'string', required: true, description: 'City' },
        { name: 'state', type: 'string', required: true, description: 'State/province' },
        { name: 'country', type: 'string', required: true, description: 'Country code (e.g. US)' },
        { name: 'postalCode', type: 'string', required: true, description: 'Postal/ZIP code' },
        { name: 'middleName', type: 'string', required: false, description: 'Middle name' },
      ],
      output: { kycAlreadyComplete: 'boolean', kycId: 'string', applicationStatus: 'string', kycUrl: 'string|undefined' },
    },
    balance: {
      description: 'Get available balance in USD cents',
      args: [],
      flags: [],
      output: { balanceCents: 'number', currency: 'string' },
    },
    'create-card': {
      description: 'Create a single-use virtual card and wait until it is ready. Returns the card ID needed for reveal/freeze.',
      args: [],
      flags: [
        { name: 'tag', type: 'string', required: true, description: 'Unique identifier for this card. Must be unique per agent.' },
        { name: 'purpose', type: 'string', required: false, description: 'Human-readable purpose (e.g. "Buy headphones on Amazon")' },
        { name: 'limit', type: 'number', required: false, description: 'Max per-transaction amount in USD' },
        { name: 'daily-limit', type: 'number', required: false, description: 'Daily spending limit in USD' },
        { name: 'monthly-limit', type: 'number', required: false, description: 'Monthly spending limit in USD' },
        { name: 'reveal', type: 'boolean', required: false, description: 'Auto-reveal card details (PAN/CVV/expiry) after creation' },
        { name: 'pretty', type: 'boolean', required: false, description: 'Show ASCII art card (requires --reveal)' },
        { name: 'masked', type: 'boolean', required: false, description: 'Hide full PAN+CVV in pretty output (requires --reveal --pretty)' },
      ],
      output: { cardId: 'string', tag: 'string' },
    },
    freeze: {
      description: 'Freeze (deactivate) a card. Blocks all charges until unfrozen.',
      args: [{ name: 'cardId', type: 'string', required: true }],
      flags: [],
      output: { cardId: 'string', status: 'string' },
    },
    unfreeze: {
      description: 'Unfreeze (reactivate) a frozen card. Use in reusable-card mode to re-enable a card for the next purchase.',
      args: [{ name: 'cardId', type: 'string', required: true }],
      flags: [],
      output: { cardId: 'string', status: 'string' },
    },
    'cancel-card': {
      description: 'Permanently cancel a card. Cannot be undone.',
      args: [{ name: 'cardId', type: 'string', required: true }],
      flags: [
        { name: 'reason', type: 'string', required: false, description: 'Cancellation reason' },
      ],
      output: { cardId: 'string', status: 'string' },
    },
    'list-cards': {
      description: 'List all cards for this agent',
      args: [],
      flags: [],
      output: 'array of card objects',
    },
    'get-card': {
      description: 'Get card details. Use --reveal to show full PAN/CVV/expiry. Use --pretty for ASCII art card. Accepts cardId or --tag.',
      args: [{ name: 'cardIdOrTag', type: 'string', required: false, description: 'Card ID (or use --tag instead)' }],
      flags: [
        { name: 'tag', type: 'string', required: false, description: 'Card tag (alternative to cardId)' },
        { name: 'reveal', type: 'boolean', required: false, description: 'Show full PAN/CVV/expiry' },
        { name: 'pretty', type: 'boolean', required: false, description: 'Show ASCII art card' },
      ],
      output: { cardId: 'string', last4: 'string', status: 'string', cardTag: 'string', dailyLimit: 'number|null', monthlyLimit: 'number|null' },
    },
    'kyc-status': {
      description: 'Check KYC application status for this agent account',
      args: [],
      flags: [],
      output: { kycStatus: 'string', kycId: 'string' },
    },
    agent: {
      description: 'Get agent account info',
      args: [],
      flags: [],
      output: 'object',
    },
    '3ds-poll': {
      description: 'Poll for a 3DS challenge on a card and auto-approve it. Call after submitting payment if merchant triggers 3D Secure.',
      args: [{ name: 'cardId', type: 'string', required: true }],
      flags: [
        { name: 'timeout', type: 'number', required: false, description: 'Poll timeout in ms (default 60000)' },
        { name: 'interval', type: 'number', required: false, description: 'Poll interval in ms (default 2000)' },
      ],
      output: { approved: 'boolean', requestId: 'string|undefined', requiresUserOtp: 'boolean|undefined', message: 'string|undefined' },
    },
    'wait-for-txn': {
      description: 'Poll until at least one transaction appears on the card. Use after checkout to confirm the charge landed before cancelling.',
      args: [{ name: 'cardId', type: 'string', required: true }],
      flags: [
        { name: 'timeout', type: 'number', required: false, description: 'Poll timeout in ms (default 30000)' },
        { name: 'interval', type: 'number', required: false, description: 'Poll interval in ms (default 3000)' },
      ],
      output: { settled: 'boolean', transactions: 'array' },
    },
    fund: {
      description: 'Get a funding redirect URL. Hand this URL to the user to open in a browser.',
      args: [{ name: 'amountUsd', type: 'number', required: true, description: 'Funding amount in USD' }],
      flags: [],
      output: { redirectUrl: 'string', quoteId: 'string', urlExpiresAt: 'string' },
    },
    transactions: {
      description: 'Get cross-card transaction history',
      args: [],
      flags: [],
      output: 'array of transaction objects',
    },
    'spend-stats': {
      description: 'Get spending statistics for this agent',
      args: [],
      flags: [
        { name: 'start', type: 'string', required: false, description: 'Start date (ISO string)' },
        { name: 'end', type: 'string', required: false, description: 'End date (ISO string)' },
      ],
      output: 'object',
    },
  },
  typical_flow: {
    onboarding: [
      '1. agent-pay auth-status user@example.com — check if already enrolled',
      '2. agent-pay request-token user@example.com — send OTP to email (skip if enrolled)',
      '3. agent-pay verify-otp user@example.com 123456 — get agt_ token',
      '4. export AGENT_PAY_TOKEN=agt_... — set token for subsequent commands',
      '5. agent-pay submit-application --firstName John --lastName Doe ... — submit KYC (skip if kycComplete)',
      '6. agent-pay kyc-status — poll until KYC approved',
      '7. agent-pay fund 100 — fund account, user opens URL in browser',
    ],
    purchase: [
      '1. agent-pay balance — check available funds',
      '2. agent-pay create-card --tag "order-123" --limit 50 — create card sized for purchase',
      '3. agent-pay get-card --tag "order-123" --reveal — get PAN/CVV/expiry to fill checkout form',
      '4. agent-pay 3ds-poll <cardId> — handle 3DS if merchant requires it',
      '5. agent-pay wait-for-txn <cardId> — confirm charge landed',
      '6. agent-pay cancel-card <cardId> — destroy card after use',
    ],
  },
  exit_codes: {
    0: 'Success — JSON result on stdout',
    1: 'Usage error (bad command, missing required flag)',
    2: 'API error (auth failure, server error)',
  },
};

// ---------------------------------------------------------------------------
// Pretty card formatter (ASCII art)
// ---------------------------------------------------------------------------

const formatCardPretty = (pan: string, cvv: string, expiry: string, masked: boolean, tag?: string): string => {
  const W = 54;
  const border = cyan;
  /** Pad raw text to W, then apply color — ANSI codes don't count toward visible width. */
  const ln = (raw: string, colored?: string): string =>
    `${border('║')}${(colored ?? raw).padEnd(W + ((colored ?? raw).length - raw.length))}${border('║')}`;
  const empty = `${border('║')}${' '.repeat(W)}${border('║')}`;
  const top = border(`╔${'═'.repeat(W)}╗`);
  const bot = border(`╚${'═'.repeat(W)}╝`);

  const last4 = pan.slice(-4);
  const numRaw = masked
    ? `   ****  ****  ****  ${last4}`
    : `   ${pan.slice(0, 4)}  ${pan.slice(4, 8)}  ${pan.slice(8, 12)}  ${pan.slice(12, 16)}`;
  const numColored = masked
    ? `   ${dim('****  ****  ****')}  ${bold(last4)}`
    : `   ${bold(`${pan.slice(0, 4)}  ${pan.slice(4, 8)}  ${pan.slice(8, 12)}  ${pan.slice(12, 16)}`)}`;

  const expRaw = masked
    ? `   VALID THRU  ${expiry}`
    : `   VALID THRU  ${expiry}     CVV  ${cvv}`;
  const expColored = masked
    ? `   ${dim('VALID THRU')}  ${bold(expiry)}`
    : `   ${dim('VALID THRU')}  ${bold(expiry)}     ${dim('CVV')}  ${bold(cvv)}`;

  const labelRaw = tag ? `   ${tag.toUpperCase().slice(0, 40)}` : '   CYPHER AGENT PAY';
  const labelColored = `   ${bold(tag ? tag.toUpperCase().slice(0, 40) : 'CYPHER AGENT PAY')}`;

  const logoRaw = [
    '     $$$$$  $     $ $$$$$$  $    $ $$$$$$$ $$$$$$',
    '    $        $   $  $     $ $    $ $       $     $',
    '    $          $    $$$$$$  $$$$$$ $$$$$$  $$$$$$',
    '    $          $    $       $    $ $       $    $',
    '     $$$$$     $    $       $    $ $$$$$$$ $     $',
  ];

  return [
    top,
    empty,
    ...logoRaw.map(r => ln(r, cyan(r))),
    empty,
    empty,
    ln(numRaw, numColored),
    empty,
    ln(expRaw, expColored),
    empty,
    ln(labelRaw, labelColored),
    empty,
    bot,
  ].join('\n');
};

// ---------------------------------------------------------------------------
// Tag → cardId resolver
// ---------------------------------------------------------------------------

const resolveCardId = async (client: ReturnType<typeof createClient>): Promise<string> => {
  const tag = flag('tag');
  const cardIdArg = positional(0);
  if (tag) {
    const cards = await client.listCardsByTag(tag);
    const card = cards[0] as Record<string, unknown> | undefined;
    const id = card?.cardId ?? card?.id;
    if (!id || typeof id !== 'string') return die(`No card found with tag "${tag}"`);
    return id;
  }
  if (cardIdArg) return cardIdArg;
  return die(`Provide a card ID or --tag <tag>`);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const COMMANDS = new Set(Object.keys(SCHEMA.commands));

const main = async (): Promise<never> => {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    const { createRequire } = await import('node:module');
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return process.exit(0);
  }

  if (command === '--schema') {
    return out(SCHEMA);
  }

  if (!COMMANDS.has(command)) {
    return die(`Unknown command: ${command}\nRun "agent-pay help" for usage.`);
  }

  // Auth commands use unauthenticated endpoints internally (publicPost) but
  // createClient still validates token format. Pass a syntactically valid
  // placeholder — it is never sent over the wire for these commands.
  const noAuthCommands = new Set(['auth-status', 'request-token', 'verify-otp']);
  const needsAuth = !noAuthCommands.has(command);
  const token = process.env.AGENT_PAY_TOKEN ?? loadStoredToken();
  const client = needsAuth
    ? createClient({ token, baseUrl: process.env.AGENT_PAY_BASE_URL })
    : createClient({ token: 'agt_cli_noauth', baseUrl: process.env.AGENT_PAY_BASE_URL });

  switch (command) {
    case 'auth-status': {
      const email = positional(0);
      if (!email) return die('Usage: agent-pay auth-status <email>');
      const status = await client.getAuthStatus(email);
      return out(status);
    }

    case 'request-token': {
      const email = positional(0);
      if (!email) return die('Usage: agent-pay request-token <email>');
      await client.requestToken(email);
      return out({ email, message: 'OTP sent — check your email' });
    }

    case 'verify-otp': {
      const email = positional(0);
      const otp = positional(1);
      if (!email || !otp) return die('Usage: agent-pay verify-otp <email> <otp>');
      const result = await client.verifyOtp(email, Number(otp));
      storeToken(result.token);
      return out({ agentId: result.agentId, message: 'Authenticated. Token stored securely.' });
    }

    case 'submit-application': {
      const firstName = flag('firstName');
      const lastName = flag('lastName');
      const email = flag('email');
      const phone = flag('phone');
      const dob = flag('dob');
      const line1 = flag('line1');
      const city = flag('city');
      const state = flag('state');
      const country = flag('country');
      const postalCode = flag('postalCode');
      if (!firstName || !lastName || !email || !phone || !dob || !line1 || !city || !state || !country || !postalCode) {
        return die('submit-application requires: --firstName --lastName --email --phone --dob --line1 --city --state --country --postalCode');
      }
      const result = await client.submitApplication({
        firstName,
        lastName,
        email,
        phone,
        dateOfBirth: dob,
        line1,
        line2: flag('line2'),
        city,
        state,
        country,
        postalCode,
        middleName: flag('middleName'),
      });
      return out(result);
    }

    case 'balance': {
      const cents = await client.getBalanceCents();
      process.stdout.write(bold(green(`$${(cents / 100).toFixed(2)}`)) + '\n');
      return process.exit(0);
    }

    case 'create-card': {
      const tag = flag('tag');
      if (!tag) return die('--tag is required for create-card');
      const sp = spinner('Creating card...');
      const result = await client.createCardAndResolve({
        tag,
        purpose: flag('purpose'),
        maxPerTransactionAmount: numFlag('limit'),
        dailyLimitUsd: numFlag('daily-limit'),
        monthlyLimitUsd: numFlag('monthly-limit'),
      });
      sp.stop();
      const revealed = await client.revealCard(result.cardId);
      const full = args.includes('--reveal');
      const pretty = args.includes('--pretty');
      if (pretty) {
        process.stdout.write(formatCardPretty(revealed.pan, revealed.cvv, revealed.expiry, !full, tag) + '\n');
        return process.exit(0);
      }
      if (full) {
        process.stdout.write(`${label('Tag:    ', tag)}\n${label('PAN:    ', revealed.pan)}\n${label('CVV:    ', revealed.cvv)}\n${label('Expiry: ', revealed.expiry)}\n`);
      } else {
        process.stdout.write(`${label('Tag:    ', tag)}\n${label('Card:   ', dim('**** **** ****') + ' ' + bold(revealed.pan.slice(-4)))}\n${label('Expiry: ', revealed.expiry)}\n`);
      }
      return process.exit(0);
    }

    case 'freeze': {
      const cardId = await resolveCardId(client);
      await client.freezeCard(cardId);
      return print(yellow('Card frozen.'));
    }

    case 'unfreeze': {
      const cardId = await resolveCardId(client);
      await client.setCardStatus(cardId, 'active');
      return print(green('Card unfrozen.'));
    }

    case 'cancel-card': {
      const cardId = await resolveCardId(client);
      await client.cancelCard(cardId, flag('reason'));
      return print(red('Card cancelled.'));
    }

    case 'list-cards': {
      const cards = await client.listAllCards({ includeCancelled: args.includes('--all') });
      if (json) return out(cards);
      if (!cards.length) return print(dim('No cards.'));
      const rows = cards.map((c) => formatCardRow(c as Record<string, unknown>));
      return printLines([dim('  TAG                      CARD          STATUS'), ...rows]);
    }

    case 'get-card': {
      const cardId = await resolveCardId(client);
      const card = await client.getCard(cardId);
      if (json) return out(card);
      const pretty = args.includes('--pretty');
      const full = args.includes('--reveal');
      if (pretty || full) {
        const revealed = await client.revealCard(cardId);
        if (pretty) {
          process.stdout.write(formatCardPretty(revealed.pan, revealed.cvv, revealed.expiry, !full, card.cardTag) + '\n');
        }
        if (full && !pretty) {
          process.stdout.write(`${label('Tag:    ', card.cardTag ?? '—')}\n${label('PAN:    ', revealed.pan)}\n${label('CVV:    ', revealed.cvv)}\n${label('Expiry: ', revealed.expiry)}\n`);
        }
        process.stdout.write(`${label('Status: ', statusColor(card.status ?? '—'))}\n`);
        if (card.dailyLimit != null) process.stdout.write(`${label('Daily:  ', green(`$${card.dailyLimit}`))}\n`);
        if (card.monthlyLimit != null) process.stdout.write(`${label('Monthly:', green(`$${card.monthlyLimit}`))}\n`);
        return process.exit(0);
      }
      return printLines([
        label('Tag:    ', card.cardTag ?? '—'),
        label('Card:   ', `${dim('****')} ${card.last4 ?? '????'}`),
        label('Status: ', statusColor(card.status ?? '—')),
        ...(card.dailyLimit != null ? [label('Daily:  ', green(`$${card.dailyLimit}`))] : []),
        ...(card.monthlyLimit != null ? [label('Monthly:', green(`$${card.monthlyLimit}`))] : []),
        label('Created:', card.createdAt ?? '—'),
      ]);
    }

    case 'kyc-status': {
      const status = await client.getKycStatus();
      return out(status);
    }

    case 'agent': {
      const info = await client.getAgent();
      return out(info);
    }

    case '3ds-poll': {
      const cardId = positional(0);
      if (!cardId) return die('Usage: agent-pay 3ds-poll <cardId>');
      const sp = spinner('Waiting for 3DS challenge...');
      const result = await client.pollAndApprove3ds(cardId, {
        timeoutMs: numFlag('timeout'),
        intervalMs: numFlag('interval'),
      });
      sp.stop();
      return out(result);
    }

    case 'wait-for-txn': {
      const cardId = positional(0);
      if (!cardId) return die('Usage: agent-pay wait-for-txn <cardId>');
      const sp = spinner('Waiting for transaction...');
      const result = await client.waitForTransaction(cardId, {
        timeoutMs: numFlag('timeout'),
        intervalMs: numFlag('interval'),
      });
      sp.stop();
      return out(result);
    }

    case 'fund': {
      const amount = positional(0);
      if (!amount) return die('Usage: agent-pay fund <amountUsd>');
      const result = await client.getFundingUrl(Number(amount));
      if (json) return out(result);
      return print(`Open this link to add funds:\n${result.transakUrl}`);
    }

    case 'transactions': {
      const result = await client.getAllTransactions();
      return out(result);
    }

    case 'spend-stats': {
      const result = await client.getSpendStats({
        startDate: flag('start'),
        endDate: flag('end'),
      });
      return out(result);
    }

    default:
      return die(`Unknown command: ${command}\nRun "agent-pay help" for usage.`);
  }
};

main().catch((err: unknown) => {
  if (err instanceof AgentPayAuthError) {
    die(err.message, 2);
  }
  if (err instanceof AgentPayApiError) {
    die(`${err.status} ${err.path}: ${err.body}`, 2);
  }
  die(err instanceof Error ? err.message : String(err), 2);
});
