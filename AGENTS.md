# Agents helper

<!-- BEGIN: Aleo Docs -->
## 1. Aleo chain essentials

Stack: **snarkVM** (zkVM — compiles programs, generates/verifies zkSNARKs), **snarkOS** (node/network software), **Leo** (Rust-like language compiling to Aleo Instructions).

Key formats (Bech32): `APrivateKey1...` signs and derives all other keys; `AViewKey1...` decrypts owned records; `aleo1...` is the public address; `sign1...` is a Schnorr signature. Record decryption: `record_view_key = (nonce * view_key).x`. A **GraphKey** lets a wallet scan for owned records without exposing the view key.

| Property | Records (private) | Mappings (public) |
| --- | --- | --- |
| Visibility | Encrypted, owner-readable | Public |
| Mutation | Consumed and recreated (UTXO) | Updated in place, in `final` blocks only |
| Use for | Balances, entitlements, tickets | Counters, registries, configs |

Records carry `owner: address` plus protocol fields `_nonce: group`, `_version: u8`. Salaries/recipients belong in records; coordination data (whitelists, configs, stream status) in mappings.

Leo (v4.x): entry points are `fn`; on-chain state updates happen in `final` blocks awaiting a returned future. Identity operands: `self.caller` (immediate caller), `self.signer` (top-level tx signer). Context: `block.height`, `block.timestamp`, `self.address`, `self.edition`, `self.program_owner`.

`credits.aleo` — native token, 1 ALEO = 1,000,000 microcredits. Functions: `transfer_public`, `transfer_private`, `transfer_public_to_private`, `transfer_private_to_public`, `join`, `split`, `fee_public`, `fee_private`.

Docs links (Cloudflare bot check — bypass as needed):

- `https://docs.aleo.org/learn/what-is-aleo/background`
- `https://docs.aleo.org/learn/what-is-aleo/how-aleo-works`
- `https://docs.aleo.org/learn/core-concepts/public-and-private-state`
- `https://docs.aleo.org/learn/core-concepts/accounts-and-keys`
- `https://docs.aleo.org/learn/core-concepts/programs`
- `https://docs.aleo.org/learn/core-concepts/transactions`
- `https://docs.aleo.org/learn/core-concepts/credits-and-transfers`
- `https://docs.aleo.org/learn/network/architecture`
- `https://docs.aleo.org/learn/network/consensus`
- `https://docs.aleo.org/learn/network/tokenomics`
- `https://docs.aleo.org/learn/network/nodes/validators`
- `https://docs.aleo.org/learn/network/nodes/provers`
- `https://docs.aleo.org/learn/network/nodes/clients`
- `https://docs.aleo.org/learn/advanced/cryptography/zksnarks`
- `https://docs.aleo.org/learn/advanced/cryptography/the-aleo-curves`
- `https://docs.aleo.org/learn/advanced/key-derivation`
- `https://docs.aleo.org/learn/advanced/transitions`
- `https://docs.aleo.org/learn/advanced/record-scanning`
- `https://docs.aleo.org/learn/advanced/delegated-proving`
- `https://docs.aleo.org/learn/reference/specifications`
- `https://docs.aleo.org/learn/reference/security-audits`
- `https://docs.aleo.org/build/aleo-instructions/reference/programs`
- `https://docs.aleo.org/build/aleo-instructions/reference/types`,
- `https://docs.aleo.org/build/aleo-instructions/reference/standard-operations`,
- `https://docs.aleo.org/build/aleo-instructions/reference/cryptographic-operations`,
- `https://docs.aleo.org/build/aleo-instructions/reference/finalize-operations`
<!-- BEGIN: Fungible Token Standards -->
- `https://vote.aleo.org/p/arc-0020`
- `https://vote.aleo.org/p/arc-0022`
<!-- END: Fungible Token Standards -->
- snarkVM repository: `https://github.com/ProvableHQ/snarkVM`
- snarkOS repository: `https://github.com/ProvableHQ/snarkOS`
- Aleo ARCs: `https://github.com/ProvableHQ/ARCs`
- Provable SDK: `https://github.com/ProvableHQ/sdk`
- Marlin zkSNARK: `https://github.com/ProvableHQ/marlin`
- Varuna reference implementation: `https://github.com/ProvableHQ/varuna-sage-impl`
- Aleo HD key derivation: `https://github.com/ProvableHQ/aleo-hd-key`
- Trail of Bits, "Aleo snarkVM Security Review," 2022: `https://github.com/trailofbits/publications/blob/master/reviews/2022-09-aleosystems-snarkvm-securityreview.pdf`
- Trail of Bits, "Aleo snarkVM, snarkOS, BullsharkBFT Security Review," 2023: `https://github.com/trailofbits/publications/blob/master/reviews/2023-10-aleo-securityreview.pdf`
- Aleo Immunefi bug bounty: `https://immunefi.com/bug-bounty/aleo/`

<!-- END: Aleo Docs -->

<!-- BEGIN leo-docs -->
## 2. Leo docs resources

Read contents from these links (Cloudflare bot check possible — bypass as needed).

- `https://docs.leo-lang.org/getting_started/installation`
- `https://docs.leo-lang.org/getting_started/hello`
- `https://docs.leo-lang.org/language/overview`
- `https://docs.leo-lang.org/language/layout`
- `https://docs.leo-lang.org/language/structure`
- `https://docs.leo-lang.org/language/data_types`
- `https://docs.leo-lang.org/language/programs_in_practice/private_state`
- `https://docs.leo-lang.org/language/programs_in_practice/public_state`
- `https://docs.leo-lang.org/language/programs_in_practice/functions`
- `https://docs.leo-lang.org/language/programs_in_practice/interfaces`
- `https://docs.leo-lang.org/language/programs_in_practice/intrinsics`
- `https://docs.leo-lang.org/language/programs_in_practice/control_flow`
- `https://docs.leo-lang.org/language/programs_in_practice/limitations`
- `https://docs.leo-lang.org/language/operators`
- `https://docs.leo-lang.org/language/operators/standard_operators`
- `https://docs.leo-lang.org/language/operators/cryptographic_operators`
- `https://docs.leo-lang.org/language/libraries`
- `https://docs.leo-lang.org/language/standard_library`
- `https://docs.leo-lang.org/language/style`
- `https://docs.leo-lang.org/language/cheatsheet`
- `https://docs.leo-lang.org/cli/cli_overview`
- `https://docs.leo-lang.org/guides/overview`
- `https://docs.leo-lang.org/guides/finalization`
- `https://docs.leo-lang.org/guides/dependencies`
- `https://docs.leo-lang.org/guides/workspaces`
- `https://docs.leo-lang.org/guides/deploy`
- `https://docs.leo-lang.org/guides/execute`
- `https://docs.leo-lang.org/guides/sign`
- `https://docs.leo-lang.org/guides/upgradability`
- `https://docs.leo-lang.org/guides/abi`
- `https://docs.leo-lang.org/guides/binary-distribution`
- `https://docs.leo-lang.org/leo_by_example/auction`
- `https://docs.leo-lang.org/leo_by_example/basic_bank`
- `https://docs.leo-lang.org/leo_by_example/vote`
- `https://docs.leo-lang.org/leo_by_example/token`
- `https://docs.leo-lang.org/leo_by_example/tictactoe`
- `https://docs.leo-lang.org/leo_by_example/battleship`
- `https://docs.leo-lang.org/resources/curated`
- `https://github.com/ProvableHQ/workshop`
- `https://provable.com/blog`
- `https://github.com/ProvableHQ/leo-examples/tree/main`

<!-- END leo-docs -->

<!-- BEGIN: Zebec Stream Docs -->
## 3. Stream requirements

Linear vesting: `vested(t) = amount * (t - start) / (end - start)`, capped at the total. Employees withdraw accrued funds any time; cancel returns the unvested remainder to the employer.

- Employer (aleo account) streams to employee (aleo account). Debt-based funding: full upfront or installments; the stream runs from the start time either way.
- `start_now` overrides a passed start time with the execution timestamp; otherwise the start time must not already have passed.
- Pausable and cancelable by the sender when flagged so at creation. Use `block.timestamp` (not block height) for schedules.

Minimum stream fields: sender, receiver, stream_token, full_amount, deposited_amount, start_time, last_withdrawn_timestamp, withdrawn_amount, duration, paused_timestamp, paused_interval, canceled_timestamp, cancelable, autowithdraw_frequency, auto_withdrawable, can_topup, pausable, covered_until, topup_count.

Required features: create; withdraw; cancel (split vested → employee, unvested → employer); pause/resume (freeze accrual, extend end by paused duration); top-up; permission toggles; cliff; auto-withdraw by an authorized withdrawer; platform fee (percent of USD stream value, transferred to the fee vault at creation).

Funding models: **full escrow** (entire value deposited at creation — trust-minimal, capital-intensive); **buffer/top-up** (initial buffer + periodic top-ups — needs debt tracking); **payer pool** (shared sender balance — capital-efficient, counterparty risk on recipients).

## 4. Design (implemented: hybrid records + mappings)

- Private records hold sensitive state: employer treasury, employee entitlement/payment, and the three ticket records (`ticket_type`: 0 = sender, 1 = receiver, 2 = withdrawer).
- Public mappings hold coordination state: stream meta (existence, status, anchor with `sender`/`paused_at`/`banked_paused_secs` for the private-stream lifecycle), whitelisted tokens, nonces, config.
- Per stream, the employer chooses public or private mode; private mode keeps salary, recipient, and schedule in records with only existence/status public.

Accrual at timestamp `t` (checked arithmetic; overflow/underflow fails the proof):

```
elapsed = min(t, end_time) - start_time - paused_durations
accrued = rate * elapsed
withdrawable = accrued - withdrawn
```

- Pause records a pause timestamp; resume banks the paused duration and extends the end time so the employee still receives the full amount.
- Cancel is terminal: vested → employee, unvested → employer, stream marked cancelled, **sender ticket burned** (not re-emitted by `cancel_stream_private`; receiver and withdrawer tickets become inert via the `!canceled` checks in all lifecycle entry functions).
- Access control via `self.caller` / `self.signer`; `signature::verify(sig, addr, msg)` or `ECDSA::verify_keccak256` for meta-transactions.
- Records are UTXO-like: every spend must return change outputs or value is destroyed.
- Buffer mode: `initialBufferDuration` sets the proportional initial deposit; `coveredUntil` tracks the funded horizon; withdrawals beyond the funded buffer fail until a top-up.

Advanced capabilities to leverage where needed: delegated proving, GraphKey record scanning, private↔public conversions on the token program, `view fn` previews, token-program interfaces for dynamic dispatch, selective-disclosure compliance proofs, record consolidation (`join`-style).

Costs: storage (tx bytes), finalize (mapping ops), proof synthesis (per tx). Minimize finalize ops for high-frequency actions.

## 5. Security considerations

- Leo arithmetic is checked by default; avoid `_wrapped` operators unless wrap-around is intended.
- Assert authorization (`self.caller` / `self.signer` / signature) before any state mutation.
- Records are replay-resistant by nonce/nullifier; signed public operations need a `nonces` mapping validated and incremented atomically in the same finalize block.
- Default everything private; never leak salary, recipient, or schedule into public state for private streams; beware timing/address correlation.
- Public operations can be front-run: prefer private records and block-height deadlines.
- Upgrade modes: `@noupgrade`, `@admin(address=...)`, `@checksum(mapping=..., key=...)`, `@custom`. Constructor logic is immutable after first deployment — audit it with special care.
- snarkVM limits: 512 KB compiled program, 31 mappings, 31 entry functions, 310 structs/records each, 16 inputs/outputs per entry point, 768 KB transaction, 100,000,000 max on-chain microcredits per tx.
- Leo test framework: `@test` / `@should_fail` run against the real VM including finalize. Cover every entry function, boundary values, unauthorized access, double spend, and expected failures.
- Public audits: Trail of Bits snarkVM/snarkOS reviews (2022, 2023); Aleo Immunefi bug bounty.

<!-- END: Zebec Stream Docs -->
<!-- BEGIN: Browser app -->
## 6. Browser app (`app/`)

`app/` is a React + Vite browser app that replaces the private-key CLI flows
(`scripts/`) with wallet-based execution via the Shield wallet and the
`@provablehq/aleo-wallet-adaptor-*` packages. See `app/README.md` for details.

- Commands: `cd app && yarn install`, `yarn dev`, `yarn build` (`tsc && vite
  build`), `yarn preview`.
- Architecture: `app/src/stream/WalletStreamService.ts` is the wallet-backed
  counterpart of `sdk/client.ts`'s `StreamService` — transactions go through
  the wallet's `executeTransaction` / `executeDeployment` (never
  ProgramManager), mapping reads through `AleoNetworkClient`. It imports the
  SDK's pure modules (`sdk/plaintext.ts`, `sdk/hashing.ts`, `sdk/math.ts`,
  `sdk/signing.ts`, `sdk/types.ts`) by relative path.
- **`StreamService` is wallet-only and shared by app and scripts.** Its
  constructor is `new StreamClient(wallet, { host?, programId?, network? })`
  where `wallet` implements the `AleoWallet` interface in `sdk/types.ts`
  (`address`, `decrypt`, `requestRecords`, `executeTransaction`). In the
  browser that's the Shield adaptor's `useWallet()` context; in Node it's
  built from a private key via `createAleoWallet(privateKey, network)`
  (`sdk/wallet.ts` — records via the RecordScanner service, execution via the
  delegated proving service with retry/backoff; needs `PROVER_API_KEY` /
  `PROVER_CONSUMER_ID`). The service API is human-facing: amounts are decimal
  strings in whole token units (converted via `toMicroUnits` /
  `fromMicroUnits` in `sdk/utils.ts`), while `Raw*` types in `sdk/types.ts`
  mirror the on-chain structs (bigint micro-units) used by
  `sdk/plaintext.ts`. `ExecuteOptions.priorityFee` is in **microcredits**
  (default 100_000).
- Records-via-wallet pattern: `requestRecords(program, false)` → keep
  `spent === false` → `wallet.decrypt(recordCiphertext)` → single-line
  plaintext → pick highest `microcredits:`/`amount:` record covering the
  needed amount; stream tickets are identified by their `ticket_type` member
  (0 = sender, 1 = receiver, 2 = withdrawer; ported `matchesTicket` logic).
- The only private key in the app is the admin attestation key input on the
  Employer page, used solely for `signStreamTokenFee` (never persisted).
- **Current status (needs update):** the app predates the per-config stream
  registry (`StreamRefKey`/`StreamCountKey` with a `config` member) and the
  token-denominated `stream_fee_amount` (u128, paid in the streaming token;
  no `credits.aleo::split` burn) program changes. It still calls
  `streamRefKey(account, index)` and sizes records with the legacy
  `SPLIT_FEE` model — update `WalletStreamService.ts` before relying on it.
<!-- END: Browser app -->

<!-- BEGIN: Program architecture notes -->
## 7. Program architecture notes (current as of Leo 4.4.1 refactor)

### Finalize logic for `create_stream_private` / `create_stream_public`

There is **no shared `finalize_create_stream` helper**. `create_stream_private`'s and
`create_stream_public`'s own `final {}` blocks each inline the full checklist
below independently; the two are kept manually in sync rather than sharing
code. (A prior refactor apparently introduced a shared helper and this
section originally documented it; it was since inlined back into both
entries without this doc catching up — treat the checklist below as the
current source of truth over any other in-repo description.)

Both finals do the following, in order:

1. Assert `start_now || start_time >= now` against the real on-chain block
   timestamp (`std::ctx::block_timestamp()`).
2. Fetch and verify the `stream_configs` entry against the caller-supplied
   `Config` (`assert_config_fields`).
3. Check the `token_fee_nonces` entry is unused, then consume it
   (`token_fee_nonces.set(nonce, true)`) — replay prevention.
4. Run `assert_token_fee_binding` (expiry / config / token-program binding)
   and verify the Schnorr signature (`std::sig::verify_schnorr` against
   `config.admin`, over `BHP256::hash_to_field(token_fee)`).
5. Check the token whitelist (`whitelisted_token_programs`, scoped to
   `config.config_name` + `token_program`).
6. Assert the stream id is fresh (`!stream_anchors.contains(stream_id)`),
   then construct and write the `StreamAnchor` — `is_public` is a literal
   (`false` in `create_stream_private`, `true` in `create_stream_public`),
   not a passed flag.
7. `create_stream_public` additionally: asserts `!streams.contains(stream_id)`,
   writes the `Stream` mapping entry, and appends the sender's/receiver's
   per-config registry entries (`outgoing_stream_counts`/`outgoing_stream_refs`,
   `incoming_stream_counts`/`incoming_stream_refs`).
8. Runs the `Final` futures built earlier in the transition body (CEI order:
   checks/effects above, `.run()` interactions last). `create_stream_private`
   runs the fee-transfer and deposit-transfer futures (both private-path
   IARC22 calls); `create_stream_public` additionally runs an
   auto-withdrawal-fee-transfer future (`credits.aleo::transfer_public_as_signer`
   — public credits, so it has no private-path equivalent) alongside its own
   fee/deposit-transfer futures (`IARC22::transfer_from_public`).

**New `create_*` variants must replicate this checklist inline** in their own
`final {}` block (e.g. a native-credits path in a future phase) — there is
currently nothing to call. If a third variant is added, extracting a real
shared `final fn` at that point (rather than a third copy) is worth
revisiting.

### `assert_create_params` helper

Both create transitions call the top-level `fn assert_create_params(params)`
before any sub-calls. This helper enforces:

- `duration > 0` and `amount > 0` in the proof context (early exit before
  proving expensive sub-calls).
- `duration as u128 <= I64_MAX` — bounds `buffer_secs ≤ duration`, preventing
  i64 overflow in `covered_until = start_time + buffer_secs`.
- Buffer and auto-withdraw frequency validity.

### Signed fee struct: `StreamTokenFee`

The admin signs a `StreamTokenFee { config, stream_token, stream_fee_amount:
u128, stream_amount: u128, expiry: i64, nonce: field }` struct. `stream_amount`
is the full stream amount (`params.amount`); both create finals assert
`token_fee.stream_amount == params.amount` inside `assert_token_fee_binding`
(the binding targets the full amount, not `deposit_amount`/buffer, so a
top-up/buffer stream can't underpay its fee on a larger full amount). The
on-chain program verifies the Schnorr signature against
`BHP256::hash_to_field(token_fee)` inside each create entry's own `final {}`
block (see §7's finalize checklist above — there is no shared helper). The SDK
mirrors this via `streamTokenFeeToPlaintext` (member order must match the Leo
struct declaration exactly) and `signStreamTokenFee` / `streamTokenFeeMessage`.
**Do not add, remove, or reorder fields without updating the SDK and
regenerating test vectors.** Changing the preimage invalidates all previously
signed fees — coordinate admin re-signing on deploy.

### Fee collection (stream fee is token-denominated)

The `stream_fee_amount` is denominated in the **streaming token** (u128), not
in ALEO microcredits:

- `create_stream_private` splits the fee off the token input record
  (`IARC22::split`) and pays it to the config's `fee_vault` via
  `IARC22::transfer_private`; the remainder of the record funds the deposit
  (`transfer_private_to_public` to the program). The token record must
  therefore cover `stream_fee_amount + deposit_amount`. The credit record
  only covers the auto-withdrawal fee, paid with a direct
  `credits.aleo::transfer_private` to the config's `withdrawer` — there is no
  `credits.aleo::split` and no split burn anymore.
- `create_stream_public` pulls the fee with
  `IARC22::transfer_from_public(caller → fee_vault)`, so the employer's
  `approve_public` allowance must cover `deposit_amount + stream_fee_amount`.

### Per-config public stream registry

Public streams are indexed per sender/receiver **per config**:
`outgoing_stream_counts` / `incoming_stream_counts` are keyed by
`BHP256(StreamCountKey { account, config })`, and
`outgoing_stream_refs` / `incoming_stream_refs` by
`BHP256(StreamRefKey { account, config, index })`. Off-chain readers must
reproduce these keys exactly — the SDK does so via `streamCountKey` /
`streamRefKey` in `sdk/hashing.ts` (member order is consensus-critical,
covered by `sdk-tests/unit/hashing.test.ts` vectors).

### Token payout pattern (caller-based, no allowance)

Payouts (withdraw/cancel, public and private) spend the program's **own**
public token balance. They must use the **caller-based** IARC22 functions —
`transfer_public(recipient, amount)` and
`transfer_public_to_private(recipient, amount)` — which debit `self.caller`
(this program's address) inside the token program and require **no
allowance**.

**Never** use `transfer_from_public` / `transfer_from_public_to_private` with
`owner = self_address` for payouts: the token program computes the allowance
key as `BHP256(TokenAllowance{ account: owner, spender: self.caller })` and
hard-`get`s it; a self-allowance is never approved, so finalize aborts with
"…field not found in mapping allowances" at the token transition.

`transfer_from_public(signer → …)` is correct exactly in
`create_stream_public`, where the employer has pre-approved the program via
`approve_public`: once for the **fee pull** (signer → `fee_vault`) and once
for the **deposit pull** (signer → `self_address`).

Private-path payouts must **re-emit** the returned `(ComplianceRecord, Token)`
records as transition outputs (same pattern as `create_stream_private`
forwarding the compliance/change records of its fee and deposit transfers) so
the payout reaches the receiver/sender and the investigator. The same rule
applies to `topup_stream_private`, which re-emits the sender's token
**change** record and the compliance record — dropping the change would
destroy sender value whenever the input record exceeds the top-up amount.

### Div-by-zero guard (`DEFAULT_WITHDRAW_FREQUENCY`)

Leo ternaries are flattened — both branches always execute. When
`auto_withdrawable == false`, the caller may pass `withdraw_frequency = 0`.
Both `create_stream_private` and `create_stream_public` guard against division
by zero in `compute_auto_withdrawal_fee` by replacing a zero frequency with
`DEFAULT_WITHDRAW_FREQUENCY` before the call. The guarded value is only used
to compute a fee that will be multiplied by 0 (since `auto_withdrawable` is
false), so the result is always 0 in that case.
<!-- END: Program architecture notes -->
