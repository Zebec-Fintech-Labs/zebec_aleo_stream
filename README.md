# Zebec Stream

A privacy-preserving token-streaming (vesting) protocol for the Aleo blockchain, plus the TypeScript SDK and CLI scripts used to build, deploy, and drive it.

The on-chain program — `test_zebec_stream_v4.aleo`, written in [Leo](https://docs.leo-lang.org) — lets a **sender** stream any [ARC-22](https://vote.aleo.org/p/arc-0022) (`IARC22`) fungible token to a **receiver** on a linear vesting schedule, with pause/resume, cancellation, top-ups, and delegated auto-withdrawal. Every stream can run in **public** mode (state readable on-chain) or **private** mode (state encrypted in records, only existence/status public) — the same schedule math, the same entry points, chosen per stream at creation time.

## Table of contents

- [Key features](#key-features)
- [Architecture & design decisions](#architecture--design-decisions)
- [Project layout](#project-layout)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration (environment variables)](#configuration-environment-variables)
- [Usage](#usage)
- [On-chain program API](#on-chain-program-api)
- [TypeScript SDK API](#typescript-sdk-api)
- [Development](#development)
- [Testing](#testing)
- [Security considerations](#security-considerations)
- [Limitations & known issues](#limitations--known-issues)
- [Known inconsistencies / naming](#known-inconsistencies--naming)
- [Further reading](#further-reading)
- [License](#license)

## Key features

- **Linear vesting streams** — `vested(t) = full_amount * (t - start) / duration`, capped at the total; receivers can withdraw accrued funds at any time.
- **Public or private mode, chosen per stream** — private mode keeps sender, receiver, amount, and schedule inside encrypted records; only a stream's existence and coarse status (paused/canceled/deposited/withdrawn) are ever public. Public mode stores everything in mappings for on-chain queryability and indexing.
- **Pause / resume** — sender can freeze accrual; resuming extends the effective end time by the paused duration so the receiver still gets the full amount.
- **Cancel** — splits the deposit: vested funds go to the receiver, unvested funds return to the sender. Terminal — cannot be reversed.
- **Top-up (buffer funding)** — a stream can start with a partial deposit (`initial_buffer_amount`) and be topped up later; payouts are capped at the funded amount so nothing can be withdrawn ahead of funding.
- **Delegated auto-withdrawal** — an optional third party (the config's `withdrawer`) can trigger withdrawals on the receiver's behalf on a fixed schedule, for a small fee, without ever holding the receiver's or sender's tickets/records.
- **Multi-tenant configuration** — the same deployed program supports many independent `StreamConfig`s (fee vault, withdrawer, fee rates), each with its own admin and whitelist of streamable tokens.
- **Admin-signed, token-denominated fees** — the config admin signs a `StreamTokenFee` (Schnorr signature) authorizing a specific fee for a specific create transaction; the signed struct is bound to the config, token, stream's full amount, `expiry`, and `nonce`; replay is prevented by an on-chain nonce mapping.
- **On-chain public-stream registry** — per-address, per-config append-only lists (`outgoing_stream_refs` / `incoming_stream_refs`) let anyone list a sender's or receiver's public streams without an off-chain indexer. Private streams are discoverable only by the wallet holding the ticket records (by design — no address correlation leaks).
- **Wallet-agnostic TypeScript SDK** — `StreamService` talks to any wallet implementing a minimal `AleoWallet` interface, so the exact same code runs against a browser wallet adaptor (e.g. Shield) or a Node wallet built from a raw private key (`createAleoWallet`, using delegated proving + a record scanner).

## Architecture & design decisions

### Hybrid state model: records + mappings

Aleo gives you two kinds of state, and this program deliberately uses both:

| | Records (private) | Mappings (public) |
| --- | --- | --- |
| Visibility | Encrypted, owner-readable only | Public, anyone can read |
| Mutation | Consumed and re-emitted (UTXO-style) | Updated in place, only inside `final` blocks |
| Used here for | Sender/receiver/withdrawer tickets — the sensitive parties, amount, and permissions of a *private* stream | Stream existence/status (`stream_anchors`), full public-stream detail (`streams`), configs, token whitelist, replay nonces, and the per-address stream registries |

Every stream — public or private — writes a `StreamAnchor` to the public `stream_anchors` mapping. This anchor **never** contains sender, receiver, or token program; it only exposes `paused`, `canceled`, `deposited_amount`, `withdrawn_amount`, timing, and an `is_public` flag. That's enough for anyone to render a status badge or compute live vesting math, without leaking who is streaming to whom in private mode.

Public streams additionally write a `Stream` struct (sender, receiver, amount, token, permission flags) to the `streams` mapping and append themselves to the sender's/receiver's per-config registries (`outgoing_stream_counts`/`refs`, `incoming_stream_counts`/`refs`) so they can be listed without a chain-walking indexer. Private streams never touch these — discovery works only by scanning the wallet's unspent ticket records (see [`docs/fetching-streams.md`](docs/fetching-streams.md)).

### Three ticket records per private stream

`create_stream_private` mints three records, distinguished by `ticket_type`:

| Record | `ticket_type` | Owner | Authorizes |
| --- | --- | --- | --- |
| `SenderStreamTicket` | `0` | sender | pause/resume, top-up, cancel |
| `ReceiverStreamTicket` | `1` | receiver | withdraw |
| `WithdrawerStreamTicket` | `2` | config's `withdrawer` | auto-withdraw on the receiver's behalf |

Owning the record *is* the authorization — there's no separate access-control list. Records are re-emitted (with a fresh nonce) on every consuming call except `cancel_stream_private`, which **burns** the sender ticket outright; the receiver/withdrawer tickets are left un-spendable via an `!canceled` check in every lifecycle entry point rather than being tracked down and destroyed.

### Funding models

- **Full escrow** — the entire `amount` is deposited at creation. Trust-minimal (the whole stream is funded up front) but capital-intensive for the sender.
- **Buffer / top-up** (`can_topup: true`) — only `initial_buffer_amount` is deposited at creation; the sender tops up over time. `topup_stream_*` computes the accrued **debt** (vested-but-undeposited amount) and funds that first, then applies any extra pre-payment, capped so the total deposit can never exceed the stream's `full_amount`. Withdrawals are always capped at `deposited_amount - withdrawn_amount`, so a receiver can never be paid ahead of funding — an under-funded buffer stream just leaves the excess locked (surfaced in a UI, not a reverted transaction).

### Fee model

The stream fee (`stream_fee_amount`) is denominated in the **streaming token itself** (a `u128`), not in ALEO microcredits. The config admin signs a `StreamTokenFee { config, stream_token, stream_fee_amount, stream_amount, expiry, nonce }` struct off-chain (see `sdk/signing.ts`); the on-chain `finalize_create_stream` verifies the Schnorr signature against the config's `admin` address, checks `now < expiry`, binds the struct to this exact `config`/`stream_token`, asserts `stream_amount == params.amount` (so a signed fee can't be reused for a larger stream), and consumes `nonce` from the `token_fee_nonces` mapping to block replay. `sdk/math.ts`'s `computeStreamFee` mirrors an off-chain, USD-value-tiered fee schedule an admin backend can use to size that signed fee (25 bps under $3,000, 18 bps under $10,000, 10 bps above).

Separately, the **auto-withdrawal fee** (paid to the config's `withdrawer` in ALEO microcredits) is computed on-chain from `duration`, `withdraw_frequency`, and the config's `base_fee`/`platform_fee` (`compute_auto_withdrawal_fee`), and mirrored off-chain by `computeAutoWithdrawalFee` for pre-flight coverage checks.

### Payout pattern: caller-based transfers, no allowances

Every payout (withdraw, cancel, auto-withdraw — public and private) is funded from the **program's own public token balance**, spent via the token program's caller-based functions (`transfer_public`, `transfer_public_to_private`). These debit `self.caller` inside the token program (i.e. this stream program's own address) and need **no allowance**. The program never uses `transfer_from_public`/`transfer_from_public_to_private` with itself as the owner for payouts — that computes an allowance key keyed on `(owner: self, spender: self)`, which is never approved, and finalize would hard-abort. `transfer_from_public` is only used the other way around, pulling funds *from* the caller (deposits and fees in `create_stream_public`/`topup_stream_public`, which require the sender to `approve_public` the program first).

### Anchor-snapshot pattern for private-path finalize

Private lifecycle transitions (`cancel_stream_private`, `topup_stream_private`, `withdraw_stream_private`, `withdraw_stream_auto_private`) take a **caller-supplied `StreamAnchor` snapshot** as a plain input (not read from the mapping, since transition bodies can't read mappings) and re-fetch + compare it field-by-field on-chain (`assert_stream_anchor_eq`) inside `final`. The public-path equivalents do the same for both `Stream` and `StreamAnchor` (`assert_stream_eq`). This means: **always fetch a fresh anchor immediately before building a transaction** — a stale snapshot fails the proof only after you've already paid for synthesis. The SDK's client methods do this fetch for you on every call.

### Multi-tenant configuration

Any number of independent `StreamConfig`s can coexist in one deployment, each identified by a `field` key (`configName`, conventionally `BHP256(utf8(name))` via `sdk/hashing.ts`'s `configNameToField`). Each config has its own `admin` (signs fees, manages the config and its token whitelist), `fee_vault`, `withdrawer`, and fee rates. Ticket records and public `Stream`/registry entries all carry the `config` they were created under, so a withdrawer or admin from one config can never act on a stream that belongs to another (`assert(ticket_record.config == config.config_name)`, `assert(stream.config == config.config_name)`).

### Timestamp handling

Every lifecycle entry that needs "now" takes it as a **caller-supplied `i64` input**, checked on-chain against the real block timestamp with a ±2 minute tolerance (`NOW_TOLERANCE`, `assert_within_tolerance`) and additionally rejected if it's in the future (`assert(now <= real_now)`) — this stops a caller from inflating accrual by backdating or fast-forwarding "now". Schedules use `block.timestamp`, not block height.

## Project layout

```
.
├── src/main.leo              # The Leo program (single file, ~1.5k lines)
├── program.json               # Leo program manifest (name, deps, version)
├── build/                     # `leo build` output (compiled .aleo, ABI) — generated, gitignored except what's checked in
├── sdk/                       # TypeScript SDK used for testing purpose
│   ├── index.ts                #   Public barrel export
│   ├── client.ts                #  `StreamService` — the main wallet-backed client
│   ├── wallet.ts                #  `createAleoWallet` — Node wallet via private key + delegated proving
│   ├── types.ts                 # Raw (on-chain) and human-facing TypeScript types
│   ├── plaintext.ts              # Leo struct <-> plaintext string (de)serializers
│   ├── hashing.ts                 # BHP256 mapping-key / message hashing helpers
│   ├── math.ts                    # Off-chain mirrors of the Leo vesting/fee math
│   ├── signing.ts                  # Admin `StreamTokenFee` Schnorr signing/verification
│   ├── records.ts                   # Chain-scanning helpers for locating unspent records
│   ├── utils.ts                      # Micro-unit <-> decimal-string conversions, token decimals lookup
│   └── config.ts                      # Network constants (program id, endpoints, stablecoin configs)
├── sdk-tests/                 # Unit tests for the SDK's pure logic (no network)
├── tests/                      # Live testnet integration tests (skipped unless funded keys are set)
├── scripts/                    # Runnable CLI entry points (see Usage)
│   ├── deploy.ts                # Deploy the compiled program
│   ├── upgrade.ts                # Upgrade an already-deployed program
│   ├── admin.ts                   # Initialize/update a config, whitelist tokens
│   └── stream.ts                   # End-to-end create -> pause -> resume -> withdraw -> cancel demo
├── docs/fetching-streams.md   # Production guide to discovering/reading stream state on-chain
├── AGENTS.md                   # Aleo/Leo reference notes + program design notes for AI coding agents
└── .env.example                # All environment variables consumed by scripts/ and sdk/wallet.ts
```

## Prerequisites

- **[Leo](https://docs.leo-lang.org/getting_started/installation) `4.4.1`** (pinned in `program.json`) and a matching `snarkVM`/`snarkOS` toolchain, to build/test the on-chain program.
- **Node.js** (ESM-only package — `"type": "module"`; a current LTS is recommended) and **Yarn** or **npm**.
- An Aleo **testnet** account (or several — see below) with:
  - A funded private key for deployment/upgrades (`PRIVATE_KEY`).
  - Separate keys for the roles exercised by the scripts/tests: config admin, stream sender, stream receiver.
- For Node-side transaction execution (`createAleoWallet`, used by every script and the integration tests): API credentials for **Provable's delegated proving service (DPS)** and **record scanner** (`PROVABLE_API_KEY` / `PROVABLE_CONSUMER_ID`) — register for free via `POST https://api.provable.com/consumers`. Not needed if you point `PROVER_URI` at a self-hosted prover.

## Installation

```bash
git clone <this-repo>
cd <repo-name>
yarn install        # or: npm install
cp .env.example .env
# fill in .env — see Configuration below
```

## Configuration (environment variables)

All variables below are read by `scripts/*.ts` and `sdk/wallet.ts`'s `createAleoWallet` (via `dotenv`). See `.env.example` for the canonical, up-to-date list.

| Variable | Required for | Purpose |
| --- | --- | --- |
| `NETWORK` | — | Target network label (`testnet`); informational in the current scripts. |
| `PRIVATE_KEY` | `run:deploy`, `run:upgrade` | Deployer key that pays for deployment/upgrade transactions. |
| `ADMIN_PRIVATE_KEY` | `run:admin`, `run:stream` | Config admin: initializes/updates the `StreamConfig`, whitelists tokens, signs every `StreamTokenFee`. |
| `SENDER_PRIVATE_KEY` | `run:stream` | The stream sender (employer). Needs unspent token records/public balance covering the deposit + fee, plus credits for the auto-withdraw fee when enabled. |
| `RECEIVER_PRIVATE_KEY` | `run:stream` | The stream receiver (employee). Must differ from the sender — the program asserts `receiver != caller`. |
| `ENDPOINT` | all | Aleo API host (explorer / node RPC). |
| `PROVER_URI` | Node execution | Delegated proving service base URI. Omit to prove locally (needs enough RAM/CPU for key synthesis). |
| `RECORD_SCANNER_URI` | Node execution | Confidential record-scanner service base URI. |
| `PROVABLE_API_KEY` / `PROVER_API_KEY` | Node execution (DPS) | API key for the delegated proving/scanner services. Not needed for a self-hosted prover. |
| `PROVABLE_CONSUMER_ID` / `PROVER_CONSUMER_ID` | Node execution (DPS) | Consumer id paired with the API key. |
| `PUBLIC_STREAM` | `run:stream` | Set to `1` to exercise the **public**-mode path in `scripts/stream.ts`; unset/anything else runs the **private**-mode path. |
| `NETWORK_RETRIES` | Node execution | Retry count for program-source/network fetches in `createAleoWallet` (default `3`). |
| `PROVING_RETRIES` | Node execution | Retry count for the proving-request submit loop (default `8`, falls back to `NETWORK_RETRIES`). |
| `ONCHAIN_SETTLE_MS` | `tests/stream.test.ts` | Post-confirmation settle delay before reading mapping state in integration tests (default `60000`). |

## Usage

### Build the Leo program

```bash
yarn build      # leo clean && leo build
```

Compiles `src/main.leo` per `program.json` into `build/test_zebec_stream_v4/` (ABI, compiled `.aleo`, interfaces).

### Deploy / upgrade

```bash
yarn run:deploy    # scripts/deploy.ts — deploys build/test_zebec_stream_v4/test_zebec_stream_v4.aleo
yarn run:upgrade   # scripts/upgrade.ts — upgrades an already-deployed program (constructor has @admin(...))
```

Both read `PRIVATE_KEY` and build a local `ProgramManager` deployment/upgrade transaction directly (no wallet abstraction — these are one-off operator actions, not part of the `StreamClient` surface). Note the constructor is guarded by `@admin(address="aleo12czxn5...")` — only that address can perform upgrades.

### Admin: set up a config and whitelist a token

```bash
yarn run:admin     # scripts/admin.ts
```

Initializes a `StreamConfig` (`Stream_Config_001` by default), updates its fee rates, and whitelists `test_usdcx_stablecoin` / `test_usad_stablecoin`. **Run this once before `run:stream`** — creating a stream against an uninitialized config or an un-whitelisted token is rejected on-chain.

### End-to-end stream lifecycle demo

```bash
yarn run:stream    # scripts/stream.ts — create -> pause -> resume -> withdraw -> cancel
PUBLIC_STREAM=1 yarn run:stream   # same, but public-mode
```

Requires the admin config from the previous step, plus `SENDER_PRIVATE_KEY` holding unspent `test_usdcx_stablecoin` token records (private mode) or public balance + `approve_public` (public mode) covering the deposit and fee, and a `credits.aleo` record/balance for fees.

### Using the SDK directly

```ts
import {
  StreamClient,
  createAleoWallet,
  computeStreamFee,
  signStreamTokenFee,
  configNameToField,
  nowSeconds,
  type CreateStreamParams,
} from "./sdk/index.js";

// Node: build a wallet from a private key (delegated proving + record scanning).
// In a browser, pass a Shield/Leo wallet adaptor's `useWallet()` context instead —
// it satisfies the same `AleoWallet` interface.
const wallet = await createAleoWallet(process.env.SENDER_PRIVATE_KEY!);
const client = new StreamClient(wallet);

const config = await client.getStreamConfig(configNameToField("Stream_Config_001"));

const params: CreateStreamParams = {
  receiver: "aleo1...",
  streamId: /* random field, see scripts/stream.ts's randomField() */ 123n,
  amount: "100",           // whole token units
  startTime: 0,
  duration: 30 * 24 * 60 * 60, // 30 days, seconds
  isCancelable: true,
  isPausable: true,
  autoWithdrawable: false,
  withdrawFrequency: 0,
  startNow: true,
  canTopup: false,
  initialBufferAmount: "0",
};

// The fee is signed off-chain by the config admin (a backend service in production).
const { streamFee } = computeStreamFee(100_000_000n, 1_000_000n); // 100 tokens @ $1.00
const rawFee = {
  config: config.configName,
  streamToken: "test_usdcx_stablecoin",
  streamFeeAmount: streamFee,
  streamAmount: 100_000_000n, // must equal params.amount (100 tokens)
  expiry: nowSeconds() + 3600n,
  nonce: 456n, // random, single-use
};
const signature = signStreamTokenFee(process.env.ADMIN_PRIVATE_KEY!, rawFee);

const txId = await client.createStreamPrivate(
  params,
  "test_usdcx_stablecoin",
  6, // token decimals
  config,
  { ...rawFee, streamFeeAmount: String(streamFee), streamAmount: "100" },
  signature,
);
```

See `scripts/stream.ts` and `tests/stream.test.ts` for complete, runnable examples of every lifecycle method (public and private).

## On-chain program API

Program id: **`test_zebec_stream_v4.aleo`** (Leo `4.4.1`, depends only on `credits.aleo`).

### Mappings

| Mapping | Key → Value | Written by |
| --- | --- | --- |
| `stream_configs` | `field` (config name) → `StreamConfig` | `initialize_config`, `update_config` |
| `whitelisted_token_programs` | `BHP256(WhitelistKey)` → `bool` | `set_token_whitelisted` |
| `stream_anchors` | `stream_id: field` → `StreamAnchor` | every create/lifecycle function |
| `streams` | `stream_id: field` → `Stream` | `create_stream_public`, `topup_stream_public` (public streams only) |
| `token_fee_nonces` | `nonce: field` → `bool` | every create function (replay guard) |
| `outgoing_stream_counts` / `incoming_stream_counts` | `BHP256(StreamCountKey)` → `u64` | `create_stream_public` |
| `outgoing_stream_refs` / `incoming_stream_refs` | `BHP256(StreamRefKey)` → `stream_id: field` | `create_stream_public` |

### Records

| Record | `ticket_type` | Owner | Fields |
| --- | --- | --- | --- |
| `SenderStreamTicket` | `0` | sender | `config`, `stream_id`, `receiver`, `token_program`, `full_amount`, `is_cancelable`, `is_pausable`, `can_topup`, `topup_count` |
| `ReceiverStreamTicket` | `1` | receiver | `config`, `sender`, `token_program`, `full_amount`, `auto_withdrawable`, `stream_id` |
| `WithdrawerStreamTicket` | `2` | config withdrawer | `config`, `full_amount`, `stream_id`, `sender`, `receiver`, `token_program`, `auto_withdrawable` |

### Transitions (entry points)

| Function | Mode | Caller | Effect |
| --- | --- | --- | --- |
| `create_stream_private` | private | anyone (becomes sender) | Mints the three tickets; pulls the token fee + deposit from private token/credit records; writes a private-mode `StreamAnchor`. |
| `create_stream_public` | public | anyone (becomes sender) | Pulls the token fee + deposit via `transfer_from_public` (requires prior `approve_public`); writes `StreamAnchor` + `Stream` + registry entries. |
| `pause_resume_stream_private` / `pause_resume_stream_public` | both | sender ticket owner / `stream.sender` | Toggles pause; on resume, banks the paused duration into `paused_interval`. |
| `cancel_stream_private` | private | sender ticket owner | Splits the deposit vested→receiver, unvested→sender; burns the sender ticket; marks the anchor canceled. |
| `cancel_stream_public` | public | `stream.sender` | Same split, paid via caller-based `transfer_public`. |
| `topup_stream_private` / `topup_stream_public` | both | sender (ticket owner / `stream.sender`) | Computes accrued debt + accepted extra, capped at `full_amount`; increases `deposited_amount`. |
| `withdraw_stream_private` | private | receiver ticket owner | Pays out the currently-withdrawable amount, capped at the funded remainder. |
| `withdraw_stream_public` | public | `stream.receiver` | Same, via `transfer_public`. |
| `withdraw_stream_auto_private` / `withdraw_stream_auto_public` | both | the config's `withdrawer`, holding a matching withdrawer ticket (private) or matching `stream.config` (public) | Same payout logic as a self-withdraw, triggered by the delegated withdrawer instead of the receiver. |
| `initialize_config` | — | anyone (becomes the config's admin) | One-time creation of a `StreamConfig` under a fresh `config_name`. |
| `update_config` | — | config admin | Updates `fee_vault` / `withdrawer` / `base_fee` / `platform_fee`. |
| `set_token_whitelisted` | — | config admin | Allow/deny a token program for that config. |

### View functions (off-chain-callable, no transaction)

| Function | Returns |
| --- | --- |
| `get_stream(stream_id)` | `Stream` (public streams only; asserts existence) |
| `get_stream_anchor(stream_id)` | `StreamAnchor` (asserts existence) |
| `get_stream_config(config_name)` | `StreamConfig` (asserts existence) |
| `is_token_whitelisted(config_name, token_program)` | `bool` |
| `get_outgoing_stream_count(account, config)` / `get_incoming_stream_count(account, config)` | `u64` |
| `get_outgoing_stream_ref(account, config, index)` / `get_incoming_stream_ref(account, config, index)` | `field` (stream id, or `0field` if unset) |

Full field-level struct definitions (`StreamConfig`, `Stream`, `StreamAnchor`, `CreateStreamParams`, `StreamTokenFee`, `Config`, `WhitelistKey`, `StreamCountKey`, `StreamRefKey`) are in `src/main.leo` (lines 74–214) and mirrored 1:1 in `sdk/types.ts`'s `Raw*` interfaces.

## TypeScript SDK API

The SDK (`sdk/`, barrel-exported from `sdk/index.ts`) is **wallet-only**: it never touches a private key directly (except inside `sdk/wallet.ts`'s Node-only `createAleoWallet`, and `sdk/signing.ts`'s admin-side fee signing). All amounts crossing the public API are human-facing (decimal strings/numbers in whole token units); the SDK converts to/from on-chain micro-units internally via `toMicroUnits`/`fromMicroUnits`.

### `StreamClient` (aliases `StreamService` from `sdk/client.ts`)

Constructed as `new StreamClient(wallet, options?)` where `wallet` satisfies the `AleoWallet` interface (`address`, `decrypt`, `requestRecords`, `executeTransaction`) and `options` is `{ host?, programId?, network? }`.

| Category | Methods |
| --- | --- |
| Lifecycle (private) | `createStreamPrivate`, `pauseResumeStreamPrivate`, `cancelStreamPrivate`, `topupStreamPrivate`, `withdrawStreamPrivate`, `withdrawStreamAutoPrivate` |
| Lifecycle (public) | `createStreamPublic`, `pauseResumeStreamPublic`, `cancelStreamPublic`, `topupStreamPublic`, `withdrawStreamPublic`, `withdrawStreamAutoPublic` |
| Token helpers (IARC22) | `approveTokenPublic`, `transferTokenPublic`, `transferTokenPrivateToPublic` |
| Admin | `initializeConfig`, `updateConfig`, `setTokenWhitelisted` |
| Compliance | `getComplianceProofs` (Sealance freeze-list Merkle exclusion proof for `usad`/`usdcx`) |
| Reads (mappings) | `getStream`, `getStreamAnchor`, `getStreamConfig`, `isTokenWhitelisted`, `getWithdrawableAmounts`, `programAddress` |
| Reads (registries) | `getOutgoingStreamCount`, `getIncomingStreamCount`, `getOutgoingStreamRef`, `getIncomingStreamRef`, `listOutgoingStreamIds`, `listIncomingStreamIds`, `listPublicStreams` |
| Records (via wallet) | `decryptProgramRecords`, `findTicket`, `listPrivateStreams`, `findCredits`, `findToken`, `findTokenRecords` |
| Balances | `getPublicBalance`, `getPublicTokenBalance`, `getPrivateBalance`, `getPrivateTokenBalance` |

Every lifecycle method returns the submitted `transactionId` (a `Promise<string>`); callers are responsible for confirmation (`networkClient.waitForTransactionConfirmation`), as shown in every script/test.

### Other modules

| Module | Purpose |
| --- | --- |
| `sdk/wallet.ts` — `createAleoWallet(privateKey, options?)` | Builds a Node `AleoWallet`: records via Provable's confidential record scanner, execution via the delegated proving service (retried with backoff, including sticky-401 JWT recovery). |
| `sdk/math.ts` | `computeStreamFee`, `computeAutoWithdrawalFee`, `computeTopupAmount`, `computeWithdrawableAmount`, `isWithdrawFrequencyValid`, `nowSeconds` — pure bigint mirrors of the Leo program's math, for off-chain previews. |
| `sdk/signing.ts` | `signStreamTokenFee`, `verifyStreamTokenFeeSignature` — admin-side `StreamTokenFee` Schnorr signing. |
| `sdk/hashing.ts` | `hashPlaintextToField`, `configNameToField`, `whitelistKey`, `tokenAllowanceKey`, `streamCountKey`, `streamRefKey`, `streamTokenFeeMessage` — reproduce every on-chain `BHP256::hash_to_field` mapping key. |
| `sdk/plaintext.ts` | Struct ⇄ Leo-plaintext-string (de)serializers and parsers (`*ToPlaintext`, `parse*`), plus `classifyTicket`/`matchesTicketRecord` for identifying decrypted ticket records structurally. |
| `sdk/records.ts` | `findCreditsRecord`, `findTokenRecord`, `findTicketRecord` — rate-limited, backwards chain-scanning record lookups (with a `.nonce-cache/` to skip already-seen records across runs). |
| `sdk/utils.ts` | `toMicroUnits`, `fromMicroUnits`, `getDecimalsByTokenProgram`. |
| `sdk/config.ts` | `DEFAULT_ALEO_ENDPOINT`, `CREDITS_PROGRAM_ID`, `ZEBEC_STREAM_PROGRAM_ID`, `STABLE_COINS_CONFIGS` (Sealance freeze-list APIs for `usad`/`usdcx`). |

Struct member order matters everywhere a struct is hashed or signed (`BHP256::hash_to_field`, Schnorr messages) — `sdk/plaintext.ts` emitters must match the Leo declaration order exactly, and any reordering requires regenerating the parity vectors in `sdk-tests/hashing.test.ts`.

## Development

```bash
yarn build          # leo clean && leo build   — compile the Leo program
yarn clean           # leo clean
yarn sdk:build        # compile sdk/**/*.ts -> dist/ (tsc, per tsconfig.json)
yarn sdk:clean         # rimraf dist
yarn sdk:test           # mocha over sdk-tests/**/*.test.ts (pure logic, no network)
yarn test                # mocha over tests/**/*.test.ts (testnet integration; skipped without funded keys)
yarn run:admin             # scripts/admin.ts
yarn run:deploy              # scripts/deploy.ts
yarn run:stream                # scripts/stream.ts
yarn run:upgrade                 # scripts/upgrade.ts
```

`tsconfig.json` builds only `sdk/` (strict mode, ESM/`bundler` resolution) into `dist/`. `tests/**/*.test.ts` (the live integration suite) instead runs directly via `tsx` per `.mocharc.json`.

There is no linter or CI configuration checked into the repository at the time of writing — `sdk:build`'s `tsc` (strict, `noUnusedLocals`/`noUnusedParameters`) is the closest thing to a static check.

## Testing

Two independent suites:

- **`yarn sdk:test`** (`sdk-tests/`) — unit tests for pure SDK logic: micro-unit conversion, plaintext (de)serialization round-trips, BHP256 hashing parity vectors (critical — these guard the mapping-key and signed-message derivations against silent struct-field reordering), fee/vesting math, Schnorr signing, and record-matching helpers. No network access, always runs.
- **`yarn test`** (`tests/`) — live testnet integration tests (`admin.test.ts`, `stream.test.ts`) exercising the full program against a real deployment: config lifecycle, every create/pause/resume/withdraw/topup/cancel/auto-withdraw path in both public and private mode, and a long list of edge cases derived directly from `src/main.leo`'s asserts (replay, tampered snapshots, authorization, timestamp tolerance, buffer underfunding, post-end behavior). **Skipped automatically** unless `ADMIN_PRIVATE_KEY`, `SENDER_PRIVATE_KEY`, and `RECEIVER_PRIVATE_KEY` are all set to funded testnet keys (see `.env`). Each test waits for on-chain confirmation and then an extra settle delay (`ONCHAIN_SETTLE_MS`, default 60s) before reading mapping state back, since explorer indexing lags confirmation.

Timeouts are generous (`.mocharc.json` sets a 6,000,000ms/100-minute global default; the integration suite additionally sets a 6,000,000ms per-`describe` timeout) because every write is a real proved, broadcast, and confirmed testnet transaction.

## Security considerations

- **Checked arithmetic by default.** Leo arithmetic halts on overflow/underflow unless you opt into `_wrapped` operators (none are used here) — this is relied upon rather than re-implemented.
- **Authorization is asserted before every mutation** — either "caller owns this ticket record" (private paths) or "caller equals the on-chain `sender`/`receiver`/config `withdrawer`" (public paths). Never trust a caller-supplied config/stream/anchor snapshot without the on-chain equality assert (`assert_config_fields`, `assert_stream_eq`, `assert_stream_anchor_eq`) that every entry point performs inside `final`.
- **Replay protection**: records are nonce/nullifier-protected by the ledger itself; the admin-signed `StreamTokenFee` additionally uses an explicit `token_fee_nonces` mapping, checked and consumed atomically in the same `final` block as the signature verification.
- **Private-by-default**: private-mode streams never write sender, receiver, amount, or token program to any mapping — only status. Building any indexer or backend on top of this program must respect that boundary (see `docs/fetching-streams.md §4.3`).
- **Front-running**: public-mode operations are visible in the mempool before confirmation; prefer private mode when counterparty/timing correlation is a concern, and don't rely on block-height deadlines against a public path without considering this.
- **Upgradability**: the constructor is `@admin(address="aleo12czxn500cyj9a7lweuft6r4rrckthfck5k8440qh7atgrnt5kupqsfh038")` — only that address can deploy upgrades (`scripts/upgrade.ts`). Constructor logic is immutable after first deployment; there is currently no on-chain multisig or timelock on upgrades — the admin key is a single point of trust for the whole deployment.
- **snarkVM limits** apply to any change to `src/main.leo`: 512 KB compiled program, 31 mappings, 31 entry functions, 310 structs/records each, 16 inputs/outputs per entry point, 768 KB transaction, 100,000,000 max on-chain microcredits per transaction.
- Independent audits of the underlying stack: Trail of Bits' 2022 snarkVM review and 2023 snarkVM/snarkOS/BullsharkBFT review (linked in `AGENTS.md`); this program itself has not been separately audited as of this writing.

## Limitations & known issues

- **Single admin per config, no multisig/timelock.** `StreamConfig.admin` is one address; compromising that key lets an attacker sign arbitrary `StreamTokenFee`s (bounded by `expiry`) and change fee/vault/withdrawer settings. Likewise the program's own upgrade key (the constructor's `@admin`) is a single address.
- **No on-chain mapping enumeration.** Aleo mappings only support point lookups (`get`/`get_or_use`), never iteration. Public streams are listable via the per-address registries (§ Architecture); **private streams have no on-chain listing at all** — the only way to discover them is to scan the wallet's own unspent ticket records (`listPrivateStreams`), which by construction cannot list streams belonging to someone else.
- **Append-only registries.** `outgoing_stream_refs`/`incoming_stream_refs` never remove canceled or fully-withdrawn streams; every consumer (SDK and any future indexer) must filter client-side using the anchor's `canceled`/`withdrawnAmount` fields.
- **Buffer-mode underfunding is silent until withdrawal.** A stream can accrue faster than its sender tops it up; the excess simply stays locked (capped by `deposited_amount`) rather than reverting — a UI must surface "funded vs. accrued" separately, or a receiver may be confused why a withdrawal is smaller than expected.
- **Off-chain price oracle trust.** `computeStreamFee`'s USD tiering takes `tokenPriceUsd` as a plain argument — nothing on-chain validates that price; it only affects the *admin-chosen* fee that the admin's own signature then attests to, so the trust boundary is the config admin, not the protocol.
- **Compliance/freeze-list coverage is stablecoin-specific.** `getComplianceProofs`/`STABLE_COINS_CONFIGS` currently only cover `usad`/`usdcx`; any other IARC22 token that requires Sealance-style exclusion proofs in its `transfer_private`/`transfer_private_to_public` will need its freeze-list API added to `sdk/config.ts` before the private-mode paths can be used with it.
- **Record scanning is rate-limited and can be slow.** `sdk/records.ts`'s chain-walking scan (used by the lower-level `findCreditsRecord`/`findTokenRecord`/`findTicketRecord` helpers) paces requests and backs off on 429/5xx to stay under the public explorer's rate limits; on an account with a long history this can take a while. `StreamService`'s own record lookups (`findCredits`/`findToken`/`findTicket`) instead rely on the wallet's `requestRecords` (the Provable record-scanner service in Node, or the browser wallet's own index), which is generally faster.
- **No browser app in this repository.** An earlier browser UI (`app/`, referenced by `docs/fetching-streams.md` and `AGENTS.md`) was removed once the `scripts/` + test suite were judged sufficient for exercising the program (see git history); those two documents' code paths under `app/src/stream/...` no longer exist in this tree — treat them as illustrative of the intended integration pattern (`StreamService` usage from a wallet-connected frontend), not as runnable references. `sdk/client.ts` and `scripts/stream.ts` are the current source of truth.
- **`package.json`'s `test` script only runs `tests/`,** not `sdk-tests/` — run `yarn sdk:test` separately for the unit suite.

## Further reading

- [`docs/fetching-streams.md`](docs/fetching-streams.md) — the production guide to discovering and reading public/private stream state on-chain (mapping layout, registry key derivation, ticket-record scanning, live-state reconstruction formulas).
- [`AGENTS.md`](AGENTS.md) — condensed Aleo/Leo/snarkVM reference material plus this program's design and security notes, written for AI coding agents working in this repo (also a useful dense summary for a human maintainer).
- [Aleo docs](https://docs.aleo.org) / [Leo docs](https://docs.leo-lang.org) — upstream language and network documentation (see the link list in `AGENTS.md §1–2`).
- [ARC-22 (IARC22 token standard)](https://vote.aleo.org/p/arc-0022) — the fungible-token interface every streamed token must implement.

## License

MIT — see `package.json`/`program.json` (`"license": "MIT"`).
