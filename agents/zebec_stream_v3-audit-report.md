# zebec_stream_v3.aleo — First-Pass Security Audit Report

**Network:** Aleo mainnet | **Language:** Leo 4.4.1 | **Program ID:** `zebec_stream_v3.aleo`
**Upgrade key:** `@admin(address="aleo1ta644kz3qqlwz5tg8pkee8qdwt4wlttuz4zjuhke2e3ph8x8ty9szywrvx")` (mainnet)
**Commit reviewed:** `e87fdf70d4b4d590733defcdb4abca5ea0a92fa6` | **Date:** 2026-09-18
**Inputs:** [src/main.leo](../src/main.leo) (1,602 lines) · [zebec_stream_v3-spec.md](zebec_stream_v3-spec.md) · [zebec_stream_v3-review-prompt.md](zebec_stream_v3-review-prompt.md)

> This is a **first-pass** review, not the audit of record for partner funds. A recommendation on
> whether a human external audit is warranted is in the final section.

---

## 0. Background reading (done before the review, per the prompt)

The two Trail of Bits Aleo reports and the Immunefi Aleo bounty were read before any class work:

- **Trail of Bits, "Aleo snarkVM Security Review" (2022)** — 29 findings,◊ dominated by **Data Validation (21)**
  and **Cryptography (7)**. Recurring classes: panics/aborts on malformed or edge-case inputs, integer
  overflow and division panics, missing hash domain separation, and a signature that verified against
  different messages. These are *protocol-layer* (snarkVM) bugs, not Leo application bugs, so no finding
  carries over directly — but they calibrate attention toward **finalize-side input completeness** and
  **arithmetic edge cases** rather than EVM-shaped intuitions (reentrancy, arbitrary external call).
- **Trail of Bits, "Aleo snarkVM, snarkOS, BullsharkBFT Security Review" (2023)** — reinforces the same
  classes and adds three directly relevant precedents: **TOB-ALEO-2** (off-by-one in *finalize input count*
  validation), **TOB-ALEO-21** (`is_linked` returns almost always `false` due to a mistyped comparison — the
  canonical **inverted/incorrect-boolean** blind spot), and **TOB-ALEO-18** (**unpinned GitHub CI actions** —
  supply chain). Plus overflow findings (#14 finalize cost, #26 block reward truncation/overflow, #27
  saturated add/sub inconsistencies).
- **Immunefi Aleo bug bounty** (`immunefi.com/bug-bounty/aleo/`) — **currently returns HTTP 404**; content was
  taken from public mirrors and Aleo's own Bugcrowd/HackerOne program descriptions. The Aleo core bounty scopes
  **snarkOS + snarkVM** (protocol) and **excludes third-party contracts** and live mainnet/testnet testing.

**Mapping onto this codebase (2–3 sentences, as required):** The ToB reports were protocol-layer audits, so
their *specific* findings do not apply to a Leo application; what transfers is the *shape* of the bugs a careful
team kept finding — incomplete finalize-side validation (class 9), integer overflow in cost/vesting math
(class 3), and incorrect-boolean helpers that only ever get happy-path tested (TOB-ALEO-21 → class 9's
inverted-boolean check). The Immunefi exclusion of third-party contracts **differs from this program's scope**:
the whitelisted `token_program` *is* a third party that Immunefi's Aleo-core bounty would exclude, but it is this
program's **primary trust boundary** and is therefore **in scope** here (see class 2 and finding 5.2). The
ToB-ALEO-18 supply-chain precedent is applied in Phase 4.

### Severity framework (stated explicitly, calibrated to the ecosystem)

Because the Immunefi page 404'd, severity is mapped from Aleo's public bounty descriptions (severity-based,
CVSS/VRT-anchored) onto this program's asset model:

| Severity | This program's equivalent |
| --- | --- |
| **Critical** | Direct theft of locked stream funds; permanent freezing of all TVL; bypass of the token whitelist enabling an arbitrary `token_program`; the upgrade key draining pooled custody. |
| **High** | Theft of a single stream's funds; permanent freeze of a victim's funds; unauthorized withdrawal; broken tenant isolation enabling cross-config fund movement. |
| **Medium** | Temporary DoS of a function; griefing that costs the victim fees; fee over/under-charge; config-level sabotage bounded to one tenant. |
| **Low** | Edge-case correctness with bounded impact; recoverable fund-lock; off-by-one with small bound. |
| **Informational** | Design notes, spec drift, defense-in-depth. |

---

## 1. Static tooling (run alongside manual review)

- `leo build` — **clean, 0 warnings.** Program size **54.55 KB / 2000 KB** (well under the limit). Raw log: `/tmp/leo_build_v3.log`.
- **Leo-specific static analyzer / symbolic finalize tester:** **none available in this environment.** The Leo
  toolchain ships `leo build` (compiler warnings) and `leo test` (real-VM `@test` execution) only; there is no
  symbolic/property tester for `final` blocks. Stated explicitly per the prompt rather than skipped.
- **Slither:** not applicable (EVM-only); not referenced as coverage.
- **Supply chain (Phase 4):** the repo has **no `.github` / CI configuration at all**, so there are no unpinned
  action versions to flag — but note ToB-ALEO-18 treated unpinned CI as **Medium** for Aleo's own infra, and the
  *absence* of any CI means no automated build/test gate exists either. See finding SC-1 for the more serious
  credential-hygiene issue in this repo.

---

## 2. Findings by vulnerability class

Each class states "Checked — no finding" or lists findings. Findings cite the invariant (INV-#) they break or
note a new invariant the spec missed.

### Class 1 — Access control (INV-3, INV-9)

**Checked.** Per-transition ownership/authorization is correctly enforced in `final {}` (the on-chain-binding
context) or via record consumption (which *is* consensus-binding for record-owned authorization). Specifically:

- Record-ticket paths (private): `assert(caller == ticket_record.owner)` in the transition body **is binding** —
  the input record is consumed and its `owner` is protocol-verified, so the body-side assert cannot be forged.
- Public paths re-check mapping-sourced authorization (`stream.sender`, `stream.receiver`, `config.admin`) in
  `final {}` against fresh on-chain reads, gated by `assert_stream_eq` / `assert_config_fields`.
- `update_config` / `set_token_whitelisted` read the **current** on-chain `stream_configs.get(...)` and assert
  `config.admin == caller` in finalize (lines 1382–1383, 1410–1411) — **not** a caller-supplied struct. PASS.
- Equality helpers are **complete** (see class 9): `assert_config_fields` 5/5, `assert_stream_eq` 11/11 (incl.
  `topup_count`), `assert_stream_anchor_eq` 12/12 (incl. `created_timestamp`). No stale-state bypass via an
  unchecked field. PASS.

**Findings:**

#### 1-A — `withdraw_stream_auto_private` has no independent on-chain stream↔config tenant binding — **High (structural)**

- **Location:** `withdraw_stream_auto_private`, [src/main.leo:737-815](../src/main.leo).
- **Class / INV:** Access control · **INV-9** (tenant isolation).
- **Description:** The public auto-withdraw path binds the tenant via an on-chain-validated `Stream`:
  `assert(stream.config == config.config_name)` (line 1235), where `stream` is proven equal to `streams.get(id)`
  by `assert_stream_eq`. The **private** path has no `streams` entry, and `StreamAnchor` carries **no `config`
  field**, so tenant binding rests entirely on (a) the `WithdrawerStreamTicket`'s self-asserted
  `ticket_record.config == config.config_name` (line 750) and (b) global `stream_id` uniqueness. There is **no
  independent on-chain backstop** tying the stream's *anchor* to the config the way the public path ties the
  *stream* to it. Exploitability is currently gated by `stream_id` uniqueness (a ticket's `stream_id` is fixed at
  mint), so this is a structural/depth weakness rather than a live cross-tenant drain — hence High-structural,
  not Critical. If any future change ever lets a `WithdrawerStreamTicket`'s `stream_id` be re-pointed, or a
  second config reuses an id, the missing anchor↔config binding is the gap that would be exploited.
- **Exploit scenario (adversarial config withdrawer):** config A's withdrawer holds a valid
  `WithdrawerStreamTicket` for stream S (config A). They cannot today move config B funds because S's anchor is
  unique and pays only S's fixed receiver. The finding is that INV-9 for the private path is enforced by *one*
  mechanism (id uniqueness) where the public path uses *two* (id + on-chain config match) — a single point of
  failure the spec's own INV-9 wording ("can never move funds belonging to a stream created under config B")
  assumes is structural in both.
- **Proposed fix:** add `config: field` to `StreamAnchor` (set at creation), and assert
  `onchain_stream_anchor.config == config.config_name` in `withdraw_stream_auto_private`'s finalize. This makes
  private tenant isolation structurally identical to public. (Adding a field to `StreamAnchor` requires updating
  `assert_stream_anchor_eq` and the SDK's anchor plaintext mirror — coordinate like any struct change.)

#### 1-B — `initialize_config` config-name squatting — **Low**

- **Location:** `initialize_config`, [src/main.leo:1347-1370](../src/main.leo); uniqueness assert at 1358.
- **Class / INV:** Front-running (also class 7) · no INV broken (permissionless by design).
- **Description:** `config_name` is a caller-chosen `field`, first-come-first-served. The comment (line 220) says
  it is a BHP256 hash of an off-chain name, but hashing is **public and deterministic**, so it provides no
  secrecy: anyone who learns a tenant's intended name recomputes the field and front-runs / pre-squats it. The
  squatter becomes that config's permanent `admin` (`update_config` cannot change `admin`; there is no
  transfer-admin function). Impact is **reputational/namespace only** — configs hold no funds, and integrators
  follow the operator's published `config_name`, so the squatted shell governs only streams someone chooses to
  create under it.
- **Proposed fix:** derive the name off-chain as `BHP256(deployer_address || offchain_name)` so a squatter
  cannot precompute a victim-meaningful name (client-side change, preserves permissionlessness); and/or document
  that integrators must pin the exact on-chain `config_name` field after observing the confirmed
  `initialize_config` transaction.

#### 1-C — Auto-withdrawal ALEO fee charged to the tx signer (relayed-tx context) — **Low**

- **Location:** `create_stream_public`, [src/main.leo:849-850](../src/main.leo) (`credits.aleo::transfer_public_as_signer`).
- **Class / INV:** CPI / access control · no INV strictly broken.
- **Description:** the auto-withdrawal ALEO fee is paid by `transfer_public_as_signer`, i.e. the **transaction
  signer**, whereas the token fee/deposit are pulled from the **caller** (`std::ctx::caller()`) via
  `transfer_from_public`. In a fee-sponsored / relayed transaction where signer ≠ caller, the ALEO fee is charged
  to the relayer, not the employer. Whether this is exploitable depends on the relay model: a relayer that does
  not account for this could be drained of the per-stream ALEO fee; an employer could likewise over-attribute the
  fee. The private path pays this fee from the caller's private credit record (consistent principal). The
  asymmetry is a footgun worth documenting/fixing for relayed flows.
- **Proposed fix:** for principal consistency, charge the ALEO auto-withdrawal fee to the **caller** in the public
  path too (e.g. pull via the caller's public credits with `transfer_public_as_caller` semantics, or document that
  relayed create flows must price the signer-paid ALEO fee into the relay agreement).

### Class 2 — CPI / cross-program invocation (INV-8) — *highest priority*

**The dynamic-dispatch type-confusion question is RESOLVED, not "cannot determine."** This was the spec's
load-bearing assumption (§2) and the prompt's single highest-priority CPI question. Resolution, with sources:

- Leo interfaces doc: *"A `dyn record` value passed at runtime is **not** revalidated against any interface — its
  actual on-chain layout could carry any fields."*
- ARC-0009 (Dynamic Dispatch): *"A record is only consumed (nullified) when it is input to a function that expects
  its static definition. Functions that accept `record.dynamic` or external records do **NOT** consume the record
  or verify ownership"* and *"the presence of a dynamic record does not imply the existence of a corresponding
  minted, unspent record."*
- ARC-0009's **translation circuit** (dyn→static at the call boundary) verifies: owner, nonce, version match;
  `merkle(static.data) == dynamic._root`; and recomputes the static record's id (serial number for an input,
  commitment for an output) against the **callee's** record type. It does **not** bind the dyn record's *origin
  program* to the callee — so dispatch is **structural (duck-typed), not nominal**.

**Consequence for this program:** when `create_stream_private` passes a caller-supplied `token_input_record: dyn
record` into `IARC22@(token_program)::split/transfer_private*`, the record is *not* checked to have been minted by
`token_program`. **However**, the call still targets the *actual whitelisted* `token_program` (the `identifier` is
whitelist-checked in finalize **before** `.run()`, and `call.dynamic` verifies target program/function existence
at execution). Inside the real token program, `split`/`transfer_private*` take the record as their **own** static
`Token` type, which triggers the dyn→static translation — and that translation recomputes the record's existence
as a genuine unspent record **of that token program**. A forged or foreign-program record fails the callee's
existence check. **Net: the whitelist + the callee-side translation together bind the spend to the whitelisted
program; the structural-typing gap is not a whitelist bypass for the spend path.** It *is*, however, a hard
dependency on the correctness of each whitelisted token program's translation/existence enforcement — which is
exactly the escalation point for the human-audit recommendation (final section).

**Other class-2 checks:**

- **Whitelist-then-run ordering (INV-8):** in both create paths and every payout path, the whitelist assert (or the
  snapshot-equality asserts that fix the stream's whitelisted `token_program`) **strictly precedes** every
  `.run()`. `create_stream_private`: whitelist assert (429–434) before `.run()` (457–458). `create_stream_public`:
  whitelist assert (881–887) before `.run()` (947–949). Payout paths fix `token_program` from the verified
  ticket/stream and run asserts before `.run()`. No early-return or branch skips the ordering. **PASS.**
- **No read-back / ordering dependency:** an external token program's `Final` cannot read `zebec_stream_v3.aleo`'s
  mappings (separate program context), and this program writes its own mappings (anchor/stream/registry) **before**
  the external `.run()` calls (CEI). ARC-0009's "update state before dynamic calls" guidance is followed. **PASS.**
- **`transfer_public_as_signer` vs `transfer_public_as_caller`:** covered as finding **1-C**.

**Class-2 status:** No Critical finding. One documented-and-resolved assumption (structural dispatch) whose safety
is delegated to the whitelisted token programs' translation correctness — escalated to the human-audit
recommendation.

### Class 3 — Integer & rounding (INV-6)

Full per-call-site subtraction-guard table, cast-reachability, topup-cap-chain, and finalize-add overflow proofs
were produced. Leo arithmetic is checked (overflow/underflow/div-by-zero **abort**, not wrap).

#### C3-01 — `compute_withdrawable_amount` u128 multiply overflow freezes all stream functions mid-life — **Medium**

- **Location:** [src/main.leo:1475](../src/main.leo) (`elapsed_duration as u128 * full_stream_amount / duration as u128`).
- **Class / INV:** Integer & rounding · **INV-6** (rounding is safe; the *overflow* is the breach).
- **Description:** the multiply runs only in the `elapsed < duration` branch, so `max_product < duration * amount`.
  `duration` is effectively unbounded (create only enforces `duration > 0` and `duration as u128 <= I64_MAX`), and
  `amount` is an unbounded u128. Overflow onset (smallest `elapsed` with `elapsed * amount > u128::MAX`):

  | `full_amount` | overflow onset (elapsed) | in days |
  | --- | --- | --- |
  | 1.0e32 | 3,402,824 s | 39.4 |
  | 5.89e32 (589T 18-dec token) | 577,729 s | **6.7** |
  | 1.0e34 | 34,029 s | 0.39 |
  | 1.0e36 | 341 s | < 6 min |

  Max amount that never overflows within a 1-year stream = `u128::MAX // 31_535_999 ≈ 1.079e31` base units
  (≈ 10.79 trillion 18-decimal tokens). Any token with base-unit supply above that overflows mid-stream. Because
  **every** lifecycle entry (withdraw ×4, cancel ×2, topup ×2) routes through this function, the abort **bricks
  every function of the stream** until `elapsed >= duration`, at which point the early-return at line 1472 bypasses
  the multiply and cancel/withdraw work again. Recovery is guaranteed only at stream end.
- **Exploit / trigger:** a legitimate 18-decimal token with supply ≳ 10.79T (common for large-cap tokens) streamed
  over months; at ~6.7 days (589T supply) any withdraw/cancel/topup aborts. Funds are locked until stream end.
- **Failing test:** `c3_01_vesting_overflow` — **FAILS** against unpatched code with
  `halted (Integer overflow on multiplication of two constants)`. See [tests/test_audit_findings.leo](../tests/test_audit_findings.leo).
- **Proposed fix (overflow-free, exact):**
  ```leo
  let d: u128 = duration as u128;
  let e: u128 = elapsed_duration as u128;
  let total_withdrawable_amount: u128 =
      full_stream_amount / d * e + (full_stream_amount % d) * e / d;
  ```
  Each partial product is `≤ full_stream_amount`, so no u128 overflow is possible, and the result equals
  `floor(elapsed * full / duration)` exactly (truncating division still rounds down, preserving INV-6).
  Alternatively cap `full_amount <= u128::MAX / duration` at create.
- **Spec ambiguity:** none — INV-6 assumes the math is computable; the overflow is a liveness breach, not a
  rounding breach.

#### C3-02 — `compute_auto_withdrawal_fee` u64 multiply overflow → create-time DoS — **Low**

- **Location:** [src/main.leo:1589-1590](../src/main.leo) (`(duration * base_fee) / safe_withdraw_frequency`, then `platform_fee + transaction_fee`).
- **Class / INV:** Integer & rounding · fee math (no INV strictly broken).
- **Description:** `duration * base_fee` is u64-checked. Max safe `base_fee` before abort = `floor(u64::MAX /
  duration)`; for a 1-year duration (31,536,000 s) that is **584,942,417,355 µc (~584,942 ALEO)**. `base_fee` is
  admin-set with no upper bound via `initialize_config`/`update_config`. Because `duration` is also unbounded, a
  very long stream lowers the threshold further (at `duration ≈ 9.2e18`, even `base_fee = 2` overflows). Impact is
  **abort at create → DoS on stream creation, never fund loss**, and only for auto-withdrawable streams of that
  config. `platform_fee + transaction_fee` overflow requires the same extreme inputs.
- **Failing test:** `c3_02_autofee_overflow` — **FAILS** with `halted (Integer overflow on multiplication ...)`.
- **Proposed fix (overflow-free):** `base_fee * (duration / safe_withdraw_frequency) + base_fee * (duration %
  safe_withdraw_frequency) / safe_withdraw_frequency`, or assert `base_fee <= u64::MAX / duration` with a clear
  error, and bound `base_fee`/`platform_fee` at `initialize_config`/`update_config`.
- **Spec ambiguity:** severity is judgment-dependent on what counts as a "plausible" fee; ~585k ALEO per
  auto-withdraw tx is far outside any sane schedule, so this is config-sabotage / extreme-edge → Low.

#### C3-03 / C3-04 — Informational

- **C3-03:** truncation dust at `elapsed = duration - 1` locks up to `duration - 1` base units until stream end —
  consistent with INV-6's round-down; noted for completeness.
- **C3-04:** `assert(total_withdrawable_amount >= withdrawn_amount)` (line 1476) is unreachable-but-load-bearing;
  it invariantly holds because `withdrawn_amount` only ever increases by `capped ≤ total - withdrawn`. If it could
  fire it would brick the stream — but no reachable path produces it.

**Explicitly PASS in class 3:** division-by-zero (`assert(duration > 0)`; `safe_frequency` guard at 340–342/841–843
plus `is_withdraw_frequency_valid` at 1585 — note `DEFAULT_WITHDRAW_FREQUENCY = 86400` **is** in
`WITHDRAW_FREQUENCIES`, so the fallback passes the validity assert); round-down direction (INV-6); monotonicity;
all `i64 as u64` casts (unreachable-negative on every guarded path); the topup cap chain even at `extra =
u128::MAX`; all four finalize u128 adds; and the `paused_interval` cumulative-subtraction invariant.

### Class 4 — Signature replay (INV-2, INV-7)

#### 4.3 — Global `token_fee_nonces` enables permanent, targeted cross-config DoS of stream creation — **Medium**

- **Location:** mapping at [src/main.leo:231](../src/main.leo); consumption at 417–421 (private) and 871–875 (public).
- **Class / INV:** Signature replay · **INV-2** (intent) and **INV-9** (one tenant's traffic can sabotage another).
- **Description:** the nonce mapping is keyed only by `nonce`, not `(config, nonce)`. Beyond the *accidental*
  collision the spec §7 flags, the **front-running** angle is materially worse and feasible: an attacker observes a
  victim's pending `create_stream_*` carrying nonce `N`; because the attacker can admin their **own** config (and
  thus sign their own `StreamTokenFee` for free, with `nonce = N`, for a 1-unit 1-second stream to a second
  address), they land first and consume `token_fee_nonces[N] = true`. The victim's tx then aborts at `assert(!used)`,
  and the victim's *specific signed fee* is permanently bricked (replay anchor burned). Repeatable as a griefing
  loop at the cost of one cheap self-signed stream per round. Funds are never stolen — pure liveness/griefing,
  per-signed-fee permanent, per-stream temporary (recoverable with a fresh signature).
- **Proposed fix:** scope the nonce key by config: `BHP256::hash_to_field(NonceKey { config: config.config_name,
  nonce: token_fee.nonce })`. Cross-config replay of a single signature is already impossible (the hash + binding
  fix `token_fee.config`), so scoping the nonce loses no protection and removes the cross-tenant vector.

**Checked — no finding:** `BHP256::hash_to_field(token_fee)` covers **all six** `StreamTokenFee` fields in
declaration order; each scalar type has a fixed-width encoding so no byte-boundary reinterpretation / collision is
possible (4.1 PASS). `assert_token_fee_binding` + the signature hash together bind every field (`stream_fee_amount`
is bound via the hash; sufficient — 4.2 PASS). The create-path `expiry` check uses the **real** on-chain
`std::ctx::block_timestamp()` read inside the finalize block (lines 406, 859) — not a caller-supplied time (4.4
PASS). Residual integration note: the off-chain admin backend must serialize `StreamTokenFee` in the **identical
member order** as the Leo struct (SDK `streamTokenFeeToPlaintext`), or signatures verify against a different
logical struct — a build-time concern covered by `sdk-tests/unit/hashing.test.ts` vectors.

### Class 5 — Upgrade & admin keys (INV-11)

#### 5.1 — Single-EOA `@admin` upgrade key has retroactive, unlimited blast radius over 100% of TVL — **Critical**

- **Location:** `constructor()`, [src/main.leo:1428-1434](../src/main.leo) (mainnet `@admin` at 1432; testnet commented at 1431).
- **Class / INV:** Upgrade & admin keys · **INV-11** (the finding is the *absence of safeguards* around a mechanism
  that works as Leo intends).
- **Confirmed mechanics (the documentation INV-11 asks for):**
  1. **State preservation across editions.** Mappings live under the program ID; an `@admin` deployment publishes a
     new *edition* of the code for the same ID. All existing mappings (`stream_configs`, `stream_anchors`,
     `streams`, `whitelisted_token_programs`, `token_fee_nonces`, registries) and all unspent ticket records are
     preserved and readable/writable by the new edition.
  2. **Custody preservation.** Every deposit — via `transfer_private_to_public(self_address, …)` or
     `transfer_from_public(caller, self_address, …)` — is held as the **program's own public balance** in each
     whitelisted token program, keyed to the program *address*, which does not change across editions. The new
     edition inherits the entire pooled balance immediately.
  3. **Retroactivity.** The upgrade applies to funds already locked in existing streams. Every payout path executes
     the *new* code; users cannot exit "under the old rules" once a new edition is published.
  4. **Blast radius = 100% of TVL across ALL tenants.** A malicious edition can add a transition calling the
     caller-based `IARC22::transfer_public(attacker, program_balance)` — the exact pattern payouts already use
     (lines 1025, 1190), debiting `self.caller` = the program with **no allowance** — and drain every whitelisted
     token's pooled balance in one call per token. Tenant isolation gives **zero** containment against the upgrade key.
- **Current mitigations: none.** Single EOA; **no timelock, no multisig, no announcement window.** `constructor()`
  is empty. The `@admin` address is **immutable after first deploy** — it can never be rotated or renounced, so a
  suspected key compromise has **no on-chain remediation** (the only option is abandoning the program ID, which
  cannot move locked funds).
- **Exploit scenario:** attacker obtains the single admin key (note: this repo's `.env` already contains live
  private keys — see SC-1 — demonstrating operational key-hygiene is a weak point); deploys edition N+1 with a
  `sweep(token_program, amount)` transition; calls it once per whitelisted token to drain all deposits of all
  tenants, including funds backing not-yet-started streams.
- **Proposed fix (priority order):** (1) point `@admin` at an **M-of-N multisig program's** address, not an EOA —
  the single highest-value change in the program; (2) route upgrade authority through a **timelock/governance
  program** that only authorizes deployment after a delay with a public announcement; (3) defense-in-depth —
  per-stream/per-tenant custody so a single logic bug (or malicious edition) cannot drain all tenants in one call;
  (4) short-term — move the key to HSM/KMS with dual control and rotate operational secrets given SC-1. Because the
  admin is immutable post-deploy, this **must be correct at (re)deployment time**.

#### 5.2 — Malicious whitelisted `token_program` can permanently lock a config's per-token deposits — **Medium**

- **Location:** `set_token_whitelisted` (1397–1413); damage via create and all payout paths.
- **Class / INV:** Upgrade & admin keys / CPI · trust-table risk (spec §2 lists it); quantified here.
- **Description:** a compromised/rogue config admin can whitelist an attacker-controlled token program implementing
  `IARC22`. That token's `transfer_public`/`transfer_public_to_private` finalize can `assert(false)` when
  `self.caller == zebec_stream_v3.aleo`, aborting **every** `withdraw_stream_*`/`cancel_stream_*` for streams
  denominated in that token at `.run()`. Because payout paths never re-check the whitelist (the token is bound at
  creation) and there is no admin de-whitelist rescue for live streams, **all program-custodied balances of that
  token, for every stream under that config, are permanently locked** — a one-way door. Bounded to that config and
  that token only: other configs and other tokens are unaffected; deposits of *honest* tokens are unaffected
  (allowances are per-token-program). The attacker cannot profit on-chain — pure griefing/ransom leverage.
- **Proposed fix:** treat `set_token_whitelisted` as value-critical — require dual approval (config admin + a
  program-level guardian) or a timelock mapping with a public activation window; document that whitelisting is
  irrevocable trust and never whitelist a token whose own program is single-key upgradeable.

**Checked — bounded:** config-admin compromise **cannot** reach another config's funds (whitelist keys are
config-scoped; tickets carry `config`; fee signatures bind `token_fee.config`) and **cannot** reach the `@admin`
upgrade key. Confirmed.

### Class 6 — Oracle / time inputs (INV-5)

**Checked.** All **eight** entry points accepting caller-supplied `now: i64` run **both**
`assert_within_tolerance(real_now, now)` **and** `assert(now <= real_now)` in `final {}` **before** any
`f_*.run()`:

| Function | tolerance | `now <= real_now` | `.run()` | ordered? |
| --- | --- | --- | --- | --- |
| `cancel_stream_private` | 558 | 561 | 575–576 | yes |
| `cancel_stream_public` | 1037 | 1038 | 1056–1057 | yes |
| `topup_stream_private` | 647 | 649 | 662 | yes |
| `topup_stream_public` | 1118 | 1120 | 1145 | yes |
| `withdraw_stream_private` | 715 | 717 | 731 | yes |
| `withdraw_stream_public` | 1197 | 1198 | 1217 | yes |
| `withdraw_stream_auto_private` | 791 | 793 | 813 | yes |
| `withdraw_stream_auto_public` | 1273 | 1274 | 1297 | yes |

The payout *amount* is body-computed from the caller's `now`, but `compute_withdrawable_amount` is **monotonic
non-decreasing** in `now`, and `now <= real_now` guarantees the finalized payout never exceeds the real-time value.
**No over-accrual path exists.** There is no path where a now-derived payout `.run()`s before both checks pass
(finalize executes atomically; a failed assert rolls back the whole tx).

#### 6.2 — Stale-`now` cancel lets the sender shave up to `rate × 120 s` from the receiver's vested payout — **Low**

- **Location:** `cancel_stream_private` (500–577), `cancel_stream_public` (984–1059).
- **Class / INV:** Oracle/time · none strictly (INV-5 satisfied by design); this is the *economic consequence* of the
  accepted tolerance, surfaced for calibration as the prompt requires.
- **Quantified bound:** max extractable value = `(full_amount / duration) × 120` token units — two minutes' vesting.
  Example: a 1,000,000-unit stream over 30 days → max skim ≈ 46.3 units ≈ **0.0046%** of stream value. One-shot per
  stream (cancel is terminal). For withdraw/topup the stale-`now` choice only hurts the caller (receiver withdraws
  less; sender overpays debt) — self-limiting. Pause/resume uses the real block timestamp (lines 475, 959), never
  caller `now`. Topup staleness merely defers the sender's own obligation.
- **Proposed fix (optional):** recompute the cancel split in finalize against `real_now` (finalize supports pure
  arithmetic; the anchor snapshot is already verified), or tighten `NOW_TOLERANCE` for cancel specifically. Given
  the bound, documenting it may be sufficient.

### Class 7 — Front-running

- **7.1 — `create_stream_public` approve/transferFrom cannot be consumed by third parties — Checked, PASS.** Both
  pulls use `owner = caller` (hard-bound to `std::ctx::caller()`); the spender is fixed to this program; and this
  program exposes no "spend arbitrary owner's allowance" entry (`transfer_from_public` only ever pulls from the
  caller). An attacker calling `create_stream_public` pulls from **their own** allowance, not the employer's. The
  "approve exactly `deposit + fee` immediately before create" pattern is a sufficient mitigation. No third-party
  drain exists.
- **7.2 — `initialize_config` name squatting:** see finding **1-B**.

### Class 8 — Denial of service

#### 8.1 — Receiver-registry griefing via append-only `incoming_stream_refs` — **Low**

- **Location:** registry append, [src/main.leo:930-945](../src/main.leo); `assert(caller != receiver)` at 836.
- **Class / INV:** DoS · none strictly (spec §7 known risk).
- **Description:** anyone can target any account as `receiver` with unbounded tiny public streams; entries are never
  removed (cancel only flips the anchor flag; refs are filtered client-side). **Cost asymmetry:** the *attacker*
  pays the mapping-write fees **plus a real token deposit** (recoverable via immediate cancel) **plus a valid
  admin-signed `StreamTokenFee`** — the signature requirement is a major practical throttle (the tenant backend is
  the gatekeeper, or the attacker uses their own config, which is trivially filterable). Victim impact is **off-chain
  indexer/UX bloat only** — on-chain finalize cost per operation is constant (index-addressed writes; no list
  traversal). No funds affected; private streams don't touch registries.
- **Proposed fix:** backend fee-signing policy should rate-limit/deny dust or unsolicited receivers; optionally a
  per-config `min_stream_amount` floor; indexer-side filtering (already anticipated at 929–931).

#### 8.2 — Cancel-requires-full-funding locks the sender's exit on under-funded buffer streams — **Low**

- **Location:** `assert(total_withdrawable_amount <= deposited_amount)` at [src/main.leo:536](../src/main.leo) (private) and 1018 (public).
- **Class / INV:** DoS · none of INV-1..11 (INV-1 is preserved *by* this assert); it is a liveness/fund-lock for the
  sender's capital. Spec §7 asks to confirm this is intended — the code enforces it **strictly**, harsher than the
  spec sentence suggests.
- **Description:** on a `can_topup` buffer stream with `deposited < vested`, cancel reverts. **End-of-stream does
  not help** — after `duration`, `total_withdrawable = full_amount`, so an under-full deposit still can't cancel
  (and cancel is additionally gated by `elapsed < duration` at 521/1004). The **only** recovery is `topup_stream_*`
  (debt-first math), which requires the sender to deposit up to the vested amount before being allowed to cancel —
  and in the worst case (`deposited <= vested`) the sender recovers **nothing** of their deposit ever, while the
  receiver can still withdraw against the funded remainder. If the sender's keys are lost, the deposit and the
  stream entry are permanent dust in the pooled balance. Funds are never *cryptographically* unrecoverable, but they
  are *economically* locked behind additional payment.
- **Proposed fix:** document loudly (employer UX): "cancel on a buffer stream requires topping up to the vested
  amount first; your unvested deposit remainder is only recoverable via cancel." Optional design change: a
  `cancel_stream_underfunded_*` that settles *within* available funds (receiver gets `min(vested_unwithdrawn,
  deposited − withdrawn)`, sender gets the remainder — `0` when under-funded), or a permissionless `settle_expired`
  callable after `end_time` to clean up abandoned streams.

#### 8.3 — No unbounded finalize iteration — Checked, PASS

The only loop is `is_withdraw_frequency_valid` over a fixed 11-element constant array. Registry appends are
constant-cost index-addressed writes. All finalize blocks do a fixed number of mapping ops and `.run()`s. No
recursion, no attacker-supplied array inputs (`sender_merkle_proofs` is a fixed `[MerkleProof; 2]` consumed by the
token program). Finalize cost is **O(1) per transition** w.r.t. system growth.

### Class 9 — Validation-gap & data-integrity (ToB-mapped)

- **Finalize input completeness:** `assert_config_fields` (5/5 fields), `assert_stream_eq` (11/11, incl.
  `topup_count`), `assert_stream_anchor_eq` (12/12, incl. `created_timestamp`) — **every struct field is checked.**
  No stale-state bypass via an omitted field. **PASS** (the primary class-9 target came back clean).
- **Inverted-boolean blind spot (TOB-ALEO-21):** `is_withdraw_frequency_valid`, `assert_within_tolerance`,
  `verify_schnorr` — both true and false paths are exercisable; the loop's `found` short-circuit and the
  `0u8..WITHDRAW_FREQUENCIES_LEN` bound are consistent with the array constant. **PASS.**
- **Bound-check:** `is_withdraw_frequency_valid` loop bound == `WITHDRAW_FREQUENCIES_LEN == 11 == ` array length.
  The companion tests pin "one past the last valid value" (`a9_tolerance_121s_stale`, `@should_fail`). **PASS.**
- **Malformed/edge inputs:** `duration = 0` is rejected by `assert(duration > 0)` at the top of
  `compute_withdrawable_amount` (1461) and by `assert_create_params`; `field = 0` stream_id is unusable as a real
  stream (registry reads return `0field` for empty slots — the ambiguity is informational); a non-deployed
  `token_program` identifier makes `call.dynamic` revert at execution (target-existence check). **PASS.**

#### 9-A — `assert_within_tolerance` overflows i64 on extreme `now` instead of cleanly rejecting — **Low**

- **Location:** [src/main.leo:1548-1550](../src/main.leo) (`(real_now - now).abs() <= NOW_TOLERANCE`).
- **Class / INV:** Validation · robustness (ToB data-validation class).
- **Description:** with `now = i64::MIN`, `real_now - now` overflows i64 (checked) and **aborts via an arithmetic
  overflow halt** rather than a controlled tolerance-reject. For realistic timestamps this is unreachable, so the
  security impact is nil — but it is exactly the malformed-input-panic class ToB flagged repeatedly, and it makes
  the failure mode an uncontrolled halt. The `@should_fail` test `a9_tolerance_extreme_now` passes *for the wrong
  reason* (overflow, not a clean assert).
- **Proposed fix:** compute the difference on a widened/unsigned domain or compare via explicit bounds, e.g.
  `assert(now <= real_now); assert(real_now - now <= NOW_TOLERANCE);` after the `now <= real_now` guard has already
  excluded the underflow case — this keeps a clean, intentional assert for all inputs and removes the overflow path.

#### 9-F-ii — `0field` stream_id / empty-slot sentinel ambiguity — **Informational**

Registry view reads return `0field` for empty slots, which is indistinguishable from a stream whose id is literally
`0field`. Not exploitable (a `0field` stream can be created but its anchor/registry reads are consistent);
informational only.

---

## 3. INV-10 dual-path parity — Checked, PASS

The inline finalize checklists of `create_stream_private` ([src/main.leo:404-459](../src/main.leo)) and
`create_stream_public` ([src/main.leo:858-950](../src/main.leo)) are **semantically identical** in every shared
step, in the same order:

1. `start_now || start_time >= now` against real block time.
2. `stream_configs.contains` + `assert_config_fields`.
3. `token_fee_nonces` `get_or_use` → `assert(!used)` → `set(true)` (replay guard).
4. `assert_token_fee_binding` + `BHP256::hash_to_field(token_fee)` + Schnorr verify against `config.admin`.
5. `whitelisted_token_programs` scoped to `config.config_name + token_program`.
6. `!stream_anchors.contains(stream_id)` freshness.
7. Construct + write `StreamAnchor` — `is_public` is a literal (`false` / `true`), not a passed flag.
8. `.run()` the transfer futures **last** (CEI).

The only differences are those the modes inherently require: the public path additionally asserts
`!streams.contains`, writes the `Stream` mapping, appends sender/receiver registry entries, and runs the
public-only `credits.aleo::transfer_public_as_signer` auto-fee leg; the private path runs its private-path fee +
deposit futures. **No drift.** Because a fix to one path is the most likely place to reintroduce drift, any future
edit to either checklist must re-run this parity check.

---

## 4. Findings register

| ID | Class | Severity | Status | Location (main.leo) | Linked test |
| --- | --- | --- | --- | --- | --- |
| 5.1 | Upgrade/Admin | **Critical** | Open | 1428–1434 (`@admin` EOA) | n/a (architectural) |
| SC-1 | Supply chain | **Critical** (opsec) | Open | `.env` — `@admin` mainnet key in plaintext on disk | n/a |
| 1-A | Access control | **High** | Open | 737–815 (`withdraw_stream_auto_private`) | n/a (needs anchor `config` field) |
| C3-01 | Integer/Rounding | **Medium** | Open | 1475 (u128 mul overflow) | `c3_01_vesting_overflow` (**fails**) |
| 4.3 | Signature replay | **Medium** | Open | 231, 417–421, 871–875 (global nonce) | n/a (needs integration) |
| 5.2 | Upgrade/Admin | **Medium** | Open | 1397–1413 (malicious whitelist) | n/a (architectural) |
| C3-02 | Integer/Rounding | **Low** | Open | 1589–1590 (u64 mul overflow) | `c3_02_autofee_overflow` (**fails**) |
| 6.2 | Oracle/Time | **Low** | Open | 500–577, 984–1059 (stale-now cancel skim) | n/a (design trade-off) |
| 8.1 | DoS | **Low** | Open | 930–945 (registry griefing) | n/a (off-chain impact) |
| 8.2 | DoS | **Low** | Open | 536, 1018 (underfunded-cancel lock) | n/a (design) |
| 9-A | Validation | **Low** | Open | 1548–1550 (tolerance i64 overflow) | `a9_tolerance_*` |
| 1-B | Front-running | **Low** | Open | 1347–1370 (config-name squat) | n/a |
| 1-C | CPI/Access | **Low** | Open | 849–850 (signer-paid ALEO fee) | n/a |
| 9-F-ii | Validation | **Info** | Open | 1331–1339 (`0field` sentinel) | n/a |
| C3-03/04 | Integer/Rounding | **Info** | Open | 1473–1480 (truncation dust; load-bearing assert) | n/a |

**Test-coverage note (ToB theme):** the program's `@admin(address="aleo1ta6...")` mainnet constructor makes the
deployment transaction **rejected by the local `leo test` VM** (which runs testnet consensus) — verified directly.
As shipped, the mainnet program **cannot be exercised by `leo test`** without temporarily switching the constructor
to the testnet admin or `@noupgrade`. This means the on-chain test suite the project would rely on to catch
regressions cannot run against the exact deployed artifact. Recommend a test-only constructor profile so the real
program logic is testable (this is itself a small but real process finding).

---

## 5. Supply-chain / credentials (Phase 4)

#### SC-1 — The mainnet `@admin` upgrade private key is sitting in the repo's local `.env` — **Critical (operational)**

- **Location:** `.env` (loaded by `leo build`; contents echoed to the build log during this audit).
- **Description — verified, not hypothetical:** the `.env` contains `PRIVATE_KEY`, `ADMIN_PRIVATE_KEY`,
  `SENDER_PRIVATE_KEY`, `RECEIVER_PRIVATE_KEY`, and `PROVABLE_API_KEY` / `PROVABLE_CONSUMER_ID`. I derived the
  address from `ADMIN_PRIVATE_KEY` with `leo account import` and it is **exactly the mainnet `@admin` upgrade
  address** `aleo1ta644kz3qqlwz5tg8pkee8qdwt4wlttuz4zjuhke2e3ph8x8ty9szywrvx` from
  [src/main.leo:1432](../src/main.leo). In other words, **the single key that can drain 100% of TVL (finding 5.1)
  is present in plaintext on this development machine**, and it was printed in full to the build output during this
  audit. `.env` **is** correctly gitignored (`.gitignore` lines 69–71) and is **not** git-tracked, so the exposure
  is local-disk / log / backup / sync-service leakage rather than a committed secret — but the key is live, in
  plaintext, and already copied into at least one build log. There is no CI, so nothing gates against an accidental
  future commit.
- **Exploit scenario:** any process, backup, cloud-sync client, or log aggregator that reads this `.env` (or the
  build log that echoed it) obtains the upgrade key; from there the finding-5.1 sweep applies with no further
  barrier.
- **Proposed fix:** treat this `@admin` key as **exposed**. Because the `@admin` address is immutable post-deploy
  and cannot be rotated on-chain, the only true remediation for a mainnet deployment is to **redeploy under a new
  program ID whose `@admin` is a multisig/timelock address** (finding 5.1 fix #1/#2), and migrate — simply deleting
  the local file does not revoke copies already made. Immediately: move all keys to a secrets manager/HSM, delete
  the `.env` and any build logs that echoed it (`/tmp/leo_build_v3.log` among them), scrub shell history, and add a
  pre-commit secret-scan gate. Confirm whether the other three keys control mainnet value and rotate accordingly.

---

## 6. Re-run after fixes

Two findings have failing tests confirmed against unpatched code (`c3_01_vesting_overflow`,
`c3_02_autofee_overflow`). After applying the proposed overflow-free fixes to **both** `src/main.leo` and the
verbatim copies in [tests/test_audit_findings.leo](../tests/test_audit_findings.leo), re-run `leo test` (in an
environment where the constructor permits local deployment — see the test-coverage note) and confirm:

- `c3_01_vesting_overflow` and `c3_01_vesting_overflow_edge` pass (vesting no longer aborts mid-stream);
- `c3_02_autofee_overflow` passes (fee no longer aborts at large `base_fee`);
- the boundary/inverted-boolean tests (`a9_tolerance_valid_now` passes, `a9_tolerance_extreme_now` and
  `a9_tolerance_121s_stale` remain `@should_fail` for the *right* reason after the 9-A fix);
- **INV-10 parity re-verified** — the create-path fixes (C3-02 touches `compute_auto_withdrawal_fee`, called by both
  create paths) must not drift the two checklists.

(The fixes themselves are **not applied in this first pass** — the prompt's deliverable is the review, the failing
tests, and the recommendation. Applying them is the follow-on remediation task.)

---

## 7. Final section — human audit recommendation

**Recommendation: YES — commission a human external audit before mainnet use with partner funds.** This is grounded
in what was actually found, not a default "always audit":

- **(a) Class-2 dynamic-dispatch type confusion — resolved, but it delegates safety to third parties.** Dispatch is
  confirmed **structural, not nominal**: the whitelist gates the *token program identifier*, and the spend is bound
  to the whitelisted program only via the **callee-side dyn→static translation/existence check** inside each token
  program. That is exactly the component this audit scoped *out* ("correctness of each whitelisted token program's
  own implementation is reviewed separately"). Because the whitelist is the program's primary trust boundary and its
  effectiveness depends on un-audited external code, the specific whitelisted token programs must be audited by a
  human before partner funds rely on the boundary. This alone justifies the recommendation.
- **(b) Class-5 upgrade-key blast radius — Critical and structural.** A single immutable EOA can retroactively drain
  100% of TVL across all tenants with no timelock/multisig, and the repo's `.env` already demonstrates weak key
  hygiene (SC-1). This is a **Critical** that no automated pass can fully de-risk (it is an operational/governance
  property), and it is precisely the kind of finding a human audit + deployment review must sign off on
  (multisig/timelock, key custody, upgrade runbook).
- **(c) Class-9 / ToB-style validation gaps — mostly clean, but the two arithmetic aborts (C3-01, C3-02) and the
  i64 tolerance overflow (9-A) are exactly the data-validation classes ToB kept finding.** These are the failure
  modes least likely to be caught by a fast automated pass, and their presence (one reachable on realistic token
  supplies) is a strong signal that a slower human pass over the arithmetic and the finalize logic is warranted.

The combination — a Critical structural key risk, a trust boundary whose strength lives in un-audited third-party
code, and a set of reachable arithmetic aborts — clears the bar for a human external audit. This first pass should
be treated as input to that audit, not a substitute for it.

---

## References

- Trail of Bits, "Aleo snarkVM Security Review" (2022): https://github.com/trailofbits/publications/blob/master/reviews/2022-09-aleosystems-snarkvm-securityreview.pdf
- Trail of Bits, "Aleo snarkVM, snarkOS, BullsharkBFT Security Review" (2023): https://github.com/trailofbits/publications/blob/master/reviews/2023-10-aleo-securityreview.pdf
- Aleo Immunefi bug bounty (404 at review time; severity/scope via public mirrors + Aleo Bugcrowd/HackerOne): https://immunefi.com/bug-bounty/aleo/
- ARC-0009 (Dynamic Dispatch): https://github.com/ProvableHQ/ARCs/tree/master/arc-0009
- Leo Interfaces / dynamic records: https://docs.leo-lang.org/language/programs_in_practice/interfaces
