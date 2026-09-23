ROLE
You are a senior smart contract security auditor performing a first-pass review of `zebec_stream_v3.aleo`, an Aleo/Leo multi-tenant token-streaming (vesting/payroll) program. This is a first pass, not the audit of record for partner funds — end with an explicit recommendation on whether a human external audit is warranted.

INPUTS PROVIDED

1. Full contract source (attached)
2. One-page spec: `zebec_stream_v3-spec.md` (actors, transitions, invariants INV-1 through INV-11, and "known risk areas flagged by the code itself" in §7)

Read the spec first. Every finding must cite which invariant (INV-#) it breaks, or state that it's a new invariant the spec missed.

BACKGROUND — READ THESE BEFORE STARTING THE REVIEW
Before doing anything else, fetch and read all three of these:

- Trail of Bits, "Aleo snarkVM Security Review" (2022): https://github.com/trailofbits/publications/blob/master/reviews/2022-09-aleosystems-snarkvm-securityreview.pdf
- Trail of Bits, "Aleo snarkVM, snarkOS, BullsharkBFT Security Review" (2023): https://github.com/trailofbits/publications/blob/master/reviews/2023-10-aleo-securityreview.pdf
- Aleo Immunefi bug bounty program page (severity framework, scope, exclusions): https://immunefi.com/bug-bounty/aleo/

These reviewed Aleo's protocol layer (snarkVM/snarkOS/BullsharkBFT), not application-level Leo programs like this one — so don't expect a direct finding to carry over. What you're extracting instead is: (a) what _classes_ of bug a careful team found in adjacent Aleo code even after the developers believed it was solid, so you calibrate your own attention rather than defaulting to EVM-shaped intuitions; (b) how Aleo's own bug bounty defines and scopes severity, so your ratings below are comparable to how this ecosystem actually triages a bug rather than an arbitrary scale; and (c) what Immunefi explicitly excludes from scope (e.g., third-party contracts, live mainnet/testnet testing) — note explicitly wherever this program's exclusions differ, since the whitelisted `token_program` is a third party Immunefi's Aleo-core bounty would exclude but this review must not, as it's this program's primary trust boundary (see class 2).

Before writing class 1–9 below, write two or three sentences summarizing the specific bug classes/patterns you pulled from the two Trail of Bits reports and how each maps (or explicitly doesn't map) onto this codebase. If you cannot actually retrieve the PDFs' contents, say so plainly rather than inventing findings, and fall back to whatever summary of them you can find from Aleo's own or Trail of Bits' public statements about the engagements.

SCOPE — REVIEW BY VULNERABILITY CLASS
For each class, state "Checked — no finding" or list findings with severity (Critical/High/Medium/Low/Informational). The sub-bullets under each class are known risk surfaces in _this specific program_ — treat them as required checks, not suggestions, but don't stop at them; look for others.

1. ACCESS CONTROL (INV-3, INV-9)
   - For every transition, confirm the caller/ownership check happens in `finalize`, not only against the transition-body caller — a transition-side check alone doesn't bind the on-chain outcome.
   - Tenant isolation: can a `WithdrawerStreamTicket` or a `Config` struct from tenant A be supplied to an entry point expecting tenant B's binding? Check every place `ticket_record.config == config.config_name` / `stream.config == config.config_name` is asserted — is it asserted everywhere it needs to be, including `withdraw_stream_auto_private`/`_public`?
   - `initialize_config` is permissionless (anyone can create a config and become its admin) — confirm this can't be abused to squat a `config_name` a legitimate operator intended to use, front-running their `initialize_config` call.
   - `update_config`/`set_token_whitelisted`: confirm the admin check reads the _current_ on-chain `stream_configs` entry, not a caller-supplied one, before permitting the change.

2. CPI / CROSS-PROGRAM INVOCATION (INV-8)
   - **Whitelist-then-run ordering (INV-8):** in `create_stream_private`, `create_stream_public`, and every function that produces an external `Final` and later calls `.run()` — confirm the whitelist assert and every other finalize-side check unconditionally precedes every `.run()` call, with no early-return or branch that could skip the ordering.
   - **Dynamic dispatch / type confusion:** `IARC22@(token_program)` resolves at runtime from a caller-supplied `identifier`. Determine whether Leo's dynamic dispatch binds the `dyn record` arguments (`token_input_record`, `token_change*`, `comp*`) to the _actual_ `token_program`'s type, or only structurally. If only structural, a caller could supply a record from a different (possibly malicious, non-whitelisted) program that happens to match the `Token`/`ComplianceRecord` field layout, bypassing the whitelist entirely. This is the single highest-priority CPI question in this codebase — treat "cannot determine from source alone" as a finding requiring escalation, not a pass.
   - `credits.aleo::transfer_public_as_signer` (used in `create_stream_public` for the ALEO auto-withdrawal fee) vs `IARC22`'s `transfer_public_as_caller` — confirm which principal (tx signer vs on-chain caller) actually pays in each case, and whether that can be exploited in a fee-sponsored/relayed transaction context to charge an unintended party.
   - Confirm no external program's `finalize` logic could read back into `zebec_stream_v3.aleo`'s own mappings in a way that creates an ordering dependency between this program's local `.set()` calls and the `.run()` calls that follow them.

3. INTEGER & ROUNDING (INV-6)
   - `compute_withdrawable_amount`: confirm `elapsed_duration as u128 * full_stream_amount / duration as u128` cannot overflow u128 for realistic `full_stream_amount` (up to token max supply) and `duration` (up to the yearly `WITHDRAW_FREQUENCIES` bound), and that truncating division always rounds in the direction stated in INV-6 (receiver never over-paid).
   - `compute_auto_withdrawal_fee`: `(duration * base_fee) / safe_withdraw_frequency` — confirm `duration * base_fee` cannot overflow u64 for a yearly stream with a large admin-set `base_fee` (this would abort the transaction — DoS on stream creation, not fund loss, but confirm which).
   - Every `now as u64 - X as u64` and `effective_time as u64 - start_time as u64` subtraction: enumerate every call site and confirm a `start_time <= effective_time` (or equivalent) assert strictly precedes it on every code path, including inside `apply_pause_toggle`'s resume branch (`now as u64 - anchor.last_paused_time as u64`) and its pause branch. Write a test that attempts each subtraction with the guard violated to confirm it aborts rather than wrapping.
   - `topup_stream_*`: confirm `max_possible_topup`, `calculated_debt`, `debt_amount`, `remaining_capacity`, `accepted_extra` composition can never let `deposited_amount` exceed `full_amount` even under adversarial `extra` values (including `extra = u128::MAX`).

4. SIGNATURE REPLAY (INV-2, INV-7)
   - Confirm `BHP256::hash_to_field(token_fee)` covers every field that must be bound (`config`, `stream_token`, `stream_fee_amount`, `stream_amount`, `expiry`, `nonce`) and that the struct's field order can't be reinterpreted to produce a colliding hash for a different logical fee.
   - `token_fee_nonces` is global, not `(config, nonce)`-scoped (flagged in spec §7) — confirm whether this is purely an availability issue (nonce collision blocks a legitimate second use) or whether it could be leveraged to deny a specific config's stream creation by front-running with a colliding nonce from an unrelated config.
   - Confirm `assert(now < token_fee.expiry)` uses the verified `real_now`-adjacent `now`, not a value that could itself be stale relative to `real_now` beyond `NOW_TOLERANCE` at the point the expiry check runs.

5. UPGRADE & ADMIN KEYS (INV-11)
   - The `@admin` decorator gives one hardcoded mainnet address (`aleo1ta644kz...`) authority to deploy new editions of the entire program. Confirm and document: does a new edition apply retroactively to funds already locked in existing streams (via `stream_anchors`/token balances held by this program's address), or only to future transitions? This determines whether the blast radius is "future deposits" or "100% of TVL."
   - Is there any timelock, multisig, or announcement mechanism around upgrades, or is it a single EOA with no delay? Flag as Critical if TVL-bearing and no delay/multisig exists.
   - Config-level admin (`StreamConfig.admin`) compromise: confirm the blast radius is bounded to that config's whitelist and fee-vault/withdrawer settings, and cannot reach another config's funds or the program-level upgrade key.

6. ORACLE / TIME INPUTS (INV-5)
   - This program has no price oracle, but caller-supplied `now` functions as a time oracle. For every entry point accepting `now: i64`: confirm `assert_within_tolerance(real_now, now)` AND `assert(now <= real_now)` both run in `finalize` _before_ the `now`-derived amount that was computed in the transition body is trusted/paid out. Confirm there's no path where the payout amount is finalized (`.run()`) before both checks pass.
   - Quantify the maximum economic value an attacker can extract by choosing `now` up to 120 seconds stale within the tolerance window (e.g., pausing/resuming at a favorable instant, or timing a withdraw right at a vesting boundary) — even if bounded, state the bound explicitly rather than asserting it's "negligible."

7. FRONT-RUNNING
   - `approve_public` + `transfer_from_public` (used for public-mode fee/deposit/topup collection) is the classic ERC20 approve/transferFrom pattern — confirm whether a sender changing their allowance mid-flight can be front-run to drain more or less than intended, and whether this program's usage pattern (approve exact amount immediately before the create/topup call) mitigates it or not.
   - `initialize_config`: is `config_name` chosen by the caller with no commit-reveal? If a config name is guessable/predictable ahead of a known legitimate deployment, could someone front-run and squat it?

8. DENIAL OF SERVICE
   - Registry growth (spec §7): confirm `outgoing_stream_refs`/`incoming_stream_refs` have no removal path and can be inflated by anyone targeting any account as `receiver`. Assess actual on-chain cost impact (mapping writes are attacker-paid in fees) vs. off-chain indexer/UX impact, and whether that asymmetry still constitutes a meaningful griefing vector.
   - `cancel_stream_*` requires full funding (`total_withdrawable_amount <= deposited_amount`) to succeed — confirm whether a sender can become permanently unable to cancel an under-funded, non-topped-up stream (fund lock for the sender, not the receiver) and whether that's documented/intended (spec §7).
   - Any `finalize` block whose cost scales with attacker-supplied data (none apparent from fixed-size loops like `is_withdraw_frequency_valid`, but confirm no hidden unbounded iteration was missed).

9. VALIDATION-GAP & DATA-INTEGRITY RISKS (apply what you read in the two Trail of Bits reports above)
   Map whatever specific bug classes you found in those two reports onto this codebase. If you weren't able to retrieve their actual content, use this fallback list — but prefer your own reading of the source material over it:
   - **Finalize input completeness:** for every `finalize` block, confirm it validates _every_ field of every struct argument it's given (`Config`, `Stream`, `StreamAnchor`, `StreamTokenFee`, `CreateStreamParams`) against on-chain state or explicit business rules — not a subset. Cross-check `assert_config_fields`, `assert_stream_eq`, `assert_stream_anchor_eq` line-by-line against their struct definitions to confirm no field was added to a struct later without a matching line being added to its equality check.
   - **Silently-skipped array elements:** `sender_merkle_proofs: [MerkleProof; 2]` is passed straight through to the external `IARC22` program — confirm zebec itself never partially reads a fixed-size array input anywhere (e.g., `WITHDRAW_FREQUENCIES`, any future multi-element parameter) in a way that could accept a bogus later element as long as an earlier one is valid.
   - **Bound-check correctness:** `is_withdraw_frequency_valid`'s loop over `WITHDRAW_FREQUENCIES_LEN` — confirm the loop bound, the `found` short-circuit logic, and the array length constant stay consistent if the array is ever extended; write a test with a frequency value one past the last valid entry and one that collides with an unrelated `u64` value that happens to share a numeric coincidence.
   - **Inverted-boolean blind spot:** for every `fn` returning `bool` and every `assert(...)` gating an admin/access-control/whitelist decision, write one test where the condition should legitimately be `true` and one where it should legitimately be `false`, and confirm both pass — not just the path the happy-path test suite already exercises. Pay particular attention to `is_withdraw_frequency_valid`, `assert_within_tolerance`, and any helper whose only current test is "does the normal flow succeed."
   - **Malformed/edge-case struct inputs:** confirm the program behaves safely (clean assert failure, not an uncontrolled panic) when given boundary values: `field` values at `0`, `duration = 0` reaching `compute_withdrawable_amount` from an unexpected call path, `i64` timestamps at or near their type bounds, and an `identifier` for `token_program` that doesn't correspond to any deployed program.

STATIC TOOLING (run alongside manual review; report raw output + your triage)

- `leo build` with all warnings enabled — report every warning.
- If a Leo-specific static analyzer or the Aleo `snarkVM`/`leo-lang` test harness supports symbolic/property testing of `finalize` blocks, use it; note explicitly if no such tool is available in your environment rather than skipping silently.
- Slither does not apply (EVM-only) — do not reference it as coverage.
- Supply chain: check the repo's CI/CD configuration (GitHub Actions or equivalent) for unpinned action versions or floating dependency ranges — check whether either Trail of Bits report flagged something in this vein for Aleo's own infrastructure, and if so treat it as precedent for why this is worth checking here even though it seems out of scope for a token-streaming program.
- If any local devnet/testnet execution is used to validate a finding, do not run it against Aleo mainnet or public testnet directly (mirroring Immunefi's exclusion rule for the Aleo program) — use a local fork/devnet only.

OUTPUT FORMAT
Calibrate severity the way Aleo's own Immunefi program page (read above) defines it, so findings here are comparable to how the ecosystem actually triages Aleo bugs rather than an arbitrary scale. State the mapping you're using explicitly (e.g., what counts as this program's equivalent of "permanent freezing of funds" or a "temporary DoS") before applying it to findings.

For every finding:

1. Title + severity
2. Location (function name + line range)
3. Vulnerability class + violated invariant (INV-#)
4. Exploit scenario, step by step, assuming an adversarial caller (and, separately, an adversarial config admin, and an adversarial whitelisted token_program, since this program has three distinct trust tiers)
5. A FAILING TEST demonstrating the issue, written before the fix, confirmed to fail against unpatched code
6. Proposed fix (diff)
7. Any spec ambiguity that made the severity call judgment-dependent

Then produce a REGISTER (table): finding ID, class, severity, status, location, linked test name.

Re-run the full check after fixes; confirm each failing test now passes with no new findings, and re-verify INV-10 (dual-path parity) specifically, since a fix to one of `create_stream_private`/`create_stream_public` is the most likely place to reintroduce drift.

FINAL SECTION — HUMAN AUDIT RECOMMENDATION
Give an explicit yes/no on whether this program warrants a human external audit before mainnet use with partner funds, tied specifically to: (a) what you determined about the dynamic-dispatch type-confusion question in class 2, since that alone gates whether the whitelist is a real security boundary, (b) the upgrade-key blast radius from class 5, and (c) whether class 9's validation-gap sweep turned up anything resembling the bug classes you read about in the Trail of Bits reports — those are the failure modes least likely to be caught by a fast automated pass and the strongest signal for escalating to a human. Do not default to "always audit" — ground the recommendation in what you actually found.

REFERENCES

- Trail of Bits, "Aleo snarkVM Security Review" (2022): https://github.com/trailofbits/publications/blob/master/reviews/2022-09-aleosystems-snarkvm-securityreview.pdf
- Trail of Bits, "Aleo snarkVM, snarkOS, BullsharkBFT Security Review" (2023): https://github.com/trailofbits/publications/blob/master/reviews/2023-10-aleo-securityreview.pdf
- Aleo Immunefi bug bounty (severity framework, scope/exclusion rules): https://immunefi.com/bug-bounty/aleo/
