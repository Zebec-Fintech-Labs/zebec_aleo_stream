# zebec_stream_v3.aleo — Behavior & Invariant Spec

**Network:** Aleo mainnet | **Language:** Leo | **Program ID:** `zebec_stream_v3.aleo`
**Upgrade key:** `@admin(address="aleo1ta644kz3qqlwz5tg8pkee8qdwt4wlttuz4zjuhke2e3ph8x8ty9szywrvx")` (mainnet)
**Version/commit reviewed:** [git sha] | **Date:** [date]

## 1. Purpose

A multi-tenant token-streaming (linear vesting/payroll) program. Any admin can create an isolated `StreamConfig` (tenant). Senders create streams — private (record-based) or public (mapping-based) — against any token whitelisted for that config, funded via a generic `IARC22` token interface reached by dynamic program dispatch (`IARC22@(token_program)`). Streams vest linearly over `duration`, can be paused, topped up (partial pre-funding with debt catch-up), canceled (pro-rata settlement), and withdrawn manually or by a designated auto-withdrawer for a per-transaction fee.

## 2. Actors & Trust Assumptions

| Actor                                                    | Capability                                                                                                                                   | Trust level                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program upgrade admin (`aleo1ta6...`)                    | Deploy new editions of the entire program                                                                                                    | **Fully trusted — total control.** A compromised key can rewrite all custody logic for every tenant's locked funds. Single EOA, not visibly a multisig. |
| Config admin (`StreamConfig.admin`)                      | Sign stream-creation fee approvals (Schnorr); update `fee_vault`/`withdrawer`/fees via `update_config`; whitelist token programs per config  | Trusted for that config only — but a malicious/compromised config admin can whitelist an attacker-controlled `token_program`                            |
| Config withdrawer (`StreamConfig.withdrawer`)            | Auto-withdraw on receiver's behalf via `WithdrawerStreamTicket` / withdrawer-role in `withdraw_stream_auto_*`; collects auto-withdrawal fees | Semi-trusted — cannot redirect funds outside the stream's fixed receiver                                                                                |
| Sender                                                   | Creates, cancels, pauses, tops up streams they own                                                                                           | Untrusted                                                                                                                                               |
| Receiver                                                 | Withdraws vested funds                                                                                                                       | Untrusted                                                                                                                                               |
| External `token_program` (dynamic, per-config whitelist) | Custodies actual token value via IARC22 `transfer_*`/`split`/`join`                                                                          | Trusted **only if whitelisted** — whitelisting is the sole gate; the program itself makes no further validation of the callee's behavior                |
| `credits.aleo`                                           | Native ALEO fee transfers for auto-withdrawal fees                                                                                           | Trusted (protocol-native)                                                                                                                               |

**Explicit assumption to verify:** the program assumes a `dyn record`/`identifier`-typed token*program call always resolves to the \_actual* whitelisted program's implementation, not a structurally-similar record from a different program. This binding is load-bearing for fund safety and should be independently confirmed against Leo's dynamic-dispatch semantics, not assumed.

## 3. State Model

- **Records:** `Token`/`ComplianceRecord` (external, IARC22), `SenderStreamTicket` (ticket_type 0), `ReceiverStreamTicket` (1), `WithdrawerStreamTicket` (2) — each carries `config` to bind it to one tenant.
- **Mappings:** `stream_configs` (tenant config), `whitelisted_token_programs` (per-config token allowlist, keyed by `BHP256(WhitelistKey)`), `stream_anchors` (per-stream vesting/pause/cancel state, shared by public+private streams), `streams` (public-stream metadata only), `token_fee_nonces` (global replay guard), `outgoing_stream_counts`/`incoming_stream_counts`/`outgoing_stream_refs`/`incoming_stream_refs` (public per-account registries).
- **Caller-supplied "snapshot" pattern:** several transitions take `Stream`/`StreamAnchor`/`Config` as plain arguments and finalize re-checks them field-by-field (`assert_stream_eq`, `assert_stream_anchor_eq`, `assert_config_fields`) against on-chain state. Any field omitted from these equality checks is a stale-state bypass — this is a primary audit target, not boilerplate.

## 4. Transitions — Intended Behavior

| Transition                                       | Caller restriction                                | Effect                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize_config`                              | anyone (caller becomes admin)                     | creates a new tenant, one-time per `config_name`                                                                                                                                                                                                   |
| `update_config`                                  | config admin                                      | changes fee_vault/withdrawer/fees                                                                                                                                                                                                                  |
| `set_token_whitelisted`                          | config admin                                      | allow/deny a `token_program` for that config                                                                                                                                                                                                       |
| `create_stream_private` / `create_stream_public` | any user (not receiver)                           | mints tickets or writes `Stream`+`stream_anchors`; pulls fee + deposit from caller via `IARC22@(token_program)`; validates admin-signed `StreamTokenFee` + nonce + whitelist + config match, **duplicated by hand across both functions** (see §7) |
| `pause_resume_stream_private` / `_public`        | sender (ticket owner / `stream.sender`)           | toggles pause, accumulates `paused_interval`                                                                                                                                                                                                       |
| `cancel_stream_private` / `_public`              | sender                                            | pro-rata settles: receiver gets vested-but-unwithdrawn, sender gets the rest of `deposited_amount`; **requires full funding** (`total_withdrawable_amount <= deposited_amount`) — an underfunded buffer stream cannot be canceled until topped up  |
| `topup_stream_private` / `_public`               | sender, `can_topup` streams only                  | pays vesting debt first, then caller's requested `extra`, capped so `deposited_amount` never exceeds `full_amount`                                                                                                                                 |
| `withdraw_stream_private` / `_public`            | receiver                                          | pays out vested-and-funded amount, capped at `deposited_amount - withdrawn_amount`                                                                                                                                                                 |
| `withdraw_stream_auto_private` / `_public`       | config's `withdrawer`, ticket/stream config-bound | same payout, on receiver's behalf                                                                                                                                                                                                                  |

_(Everything above is derived from the source; if the real spec differs on any of these, that divergence is itself a finding.)_

## 5. Invariants

- **INV-1 (Conservation per stream):** `withdrawn_amount ≤ deposited_amount ≤ full_amount` at all times; cancel pays out exactly `deposited_amount` split between sender and receiver, no more, no less.
- **INV-2 (No double-spend/replay):** a `stream_id` can only be claimed once across _both_ public and private paths (both check `stream_anchors.contains`); a `token_fee.nonce` can only be consumed once, globally.
- **INV-3 (Access control):** only the ticket/record owner, the on-chain `stream.sender`/`stream.receiver`, or the config's bound `admin`/`withdrawer` can act on a given stream or config — verified in `finalize`, not only in the transition body.
- **INV-4 (Snapshot consistency):** every field of a caller-supplied `Stream`/`StreamAnchor`/`Config` argument matches on-chain state before that argument is used to compute a payout or gate an action.
- **INV-5 (Timestamp integrity):** any caller-supplied `now` satisfies `now ≤ real_now` and `|real_now - now| ≤ 120s` (`NOW_TOLERANCE`) before it is used to fix a payout amount that was already computed off-chain against that same `now`.
- **INV-6 (Vesting monotonicity & rounding):** `compute_withdrawable_amount` is monotonic non-decreasing in elapsed time, never exceeds `full_amount`, and always rounds _down_ (truncating division) — the receiver never receives more than the exact linear-vested share.
- **INV-7 (Fee-signature binding):** an admin-signed `StreamTokenFee` is valid only for the exact `config`, `token_program`, and `stream_amount` it was signed for, and only before `expiry` — never replayable across configs, tokens, or stream sizes.
- **INV-8 (Whitelist gate ordering):** an external token program's `Final` (returned from `transfer_from_public`/`transfer_private`/`transfer_private_to_public`/`transfer_public_to_private`) is only `.run()` _after_ the whitelist check passes in the same `finalize` block — never before.
- **INV-9 (Tenant isolation):** a `WithdrawerStreamTicket` or `withdraw_stream_auto_*` call authorized under config A can never move funds belonging to a stream created under config B.
- **INV-10 (Dual-path parity):** the verification checklist in `create_stream_private`'s `finalize` and `create_stream_public`'s `finalize` are semantically identical wherever the same check applies to both (config match, nonce, signature, whitelist, stream-id freshness) — any divergence introduced by future edits is a finding, not a style issue.
- **INV-11 (Upgrade blast radius):** only the address in the `@admin` decorator can deploy a new edition; document what a malicious edition could do to funds already locked in existing streams (this determines whether users are trusting one key with all TVL, not just future deposits).

## 6. Explicit Non-Goals / Out of Scope

- The correctness of any individual `IARC22` token program's own implementation — that's reviewed separately; this spec assumes a _whitelisted_ token program behaves per the interface, but explicitly does **not** assume all whitelistable programs are honest (whitelisting itself is in scope).
- `credits.aleo` internals.
- Off-chain services: the backend that signs `StreamTokenFee` and generates nonces (its nonce-generation scheme is out of scope, but the on-chain consequence of nonce collisions across configs is in scope — see §7).

## 7. Known Risk Areas Flagged by the Code Itself (prioritize these)

- Author's own comment: private/public creation finalize checklists have **no shared helper** and must be "kept in sync manually" — this is a standing invitation for drift (INV-10).
- `token_fee_nonces` is a single global mapping keyed only by `nonce`, not `(config, nonce)` — if two configs' backends ever generate an overlapping nonce, the second legitimate fee becomes permanently unusable (availability bug, not a fund-safety bug, but worth a test).
- `outgoing_stream_refs`/`incoming_stream_refs` are append-only with no bound — any account can be spammed with unbounded tiny streams, inflating a victim's `incoming_stream_count` indefinitely (registry-growth DoS/griefing).
- Cancel requires full funding of the vested amount — confirm this "no exit while under debt" behavior is the _intended_ design and not an accidental fund-lock for senders who under-fund a buffer stream and later want out.
