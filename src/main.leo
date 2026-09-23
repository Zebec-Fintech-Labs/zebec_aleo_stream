import credits.aleo;

struct MerkleProof {
    siblings: [field; 16],
    leaf_index: u32,
}

interface IARC22 {
    record Token {
        owner: address,
        amount: u128,
        ..
    }

    record ComplianceRecord {
        owner: address,     // INVESTIGATOR_ADDRESS
        amount: u128,
        sender: address,    // ZERO_ADDRESS for mint paths
        recipient: address, // ZERO_ADDRESS for burn paths
        .. 
    }

    //=============================================================
    //               APPROVAL FUNCTIONS
    //=============================================================
    fn approve_public(public spender: address, public amount: u128) -> Final;
    fn unapprove_public(public spender: address, public amount: u128) -> Final;

    //=============================================================
    //               TRANSFER FUNCTIONS
    //=============================================================
    fn transfer_public(public recipient: address, public amount: u128) -> Final;
    fn transfer_private(
        private recipient: address,
        private amount: u128,
        private input_record: Token,
        private sender_merkle_proofs: [MerkleProof; 2u32],
    ) -> (ComplianceRecord, Token, Token, Final);
    fn transfer_private_to_public(
        public recipient: address,
        public amount: u128,
        private input_record: Token,
        private sender_merkle_proofs: [MerkleProof; 2u32],
    ) -> (ComplianceRecord, Token, Final);
    fn transfer_public_to_private(recipient: address, public amount: u128) -> (
        ComplianceRecord, Token, Final,
    );
    fn transfer_from_public(public owner: address, public recipient: address, public amount: u128) -> Final;
    fn transfer_from_public_to_private(
        public owner: address,
        private recipient: address,
        public amount: u128,
    ) -> (ComplianceRecord, Token, Final);
    fn transfer_public_as_caller(public recipient: address, public amount: u128) -> Final;

    //=============================================================
    //               JOIN/SPLIT FUNCTIONS
    //=============================================================
    fn join(input_1: Token, input_2: Token) -> Token;
    fn split(input: Token, amount: u128) -> (Token, Token);

    //=============================================================
    //                VIEW FUNCTIONS
    //=============================================================
    view fn balance_of(account: address) -> u128;
    view fn allowance(owner: address, spender: address) -> u128;
    view fn supply() -> u128;
    view fn max_supply() -> u128;
    view fn decimals() -> u8;
    view fn name() -> identifier;
    view fn symbol() -> identifier;
}

// Identifies one whitelisted token of one stream config. Hashed with BHP256
// to form the `whitelisted_tokens` mapping key.
struct WhitelistKey {
    config: field,
    token_program: identifier,
}

// Composite key for the token-fee nonce replay-guard mapping. Scoping by
// config prevents cross-config nonce front-running: an attacker who observes
// nonce N on config A cannot consume it on config B to DoS the victim.
struct NonceKey {
    config: field,
    nonce: field,
}

// One slot of a per-address stream registry. Hashed with BHP256 to form the
// `outgoing_stream_refs` / `incoming_stream_refs` mapping keys so streams can
// be listed per sender/receiver per config (public streams only).
struct StreamRefKey {
    account: address,
    config: field,
    index: u64,
}

// Composite key for per-config stream counts (hashed to field for mapping key).
struct StreamCountKey {
    account: address,
    config: field,
}

// Program configuration. Multiple configs live in this program's
// `stream_configs` mapping, each under a unique config name. Whitelisted
// tokens are stored per config in the `whitelisted_token_programs` mapping
// (keyed by `WhitelistKey`).
struct StreamConfig {
    // admin address
    admin: address,
    // fee vault address where fee for stream fees are stored
    fee_vault: address,
    // address reponsible for withdrawing the streams on behalf of receiver
    // when auto withdraw is enabled
    withdrawer: address,
    // fee for single auto withdraw transaction. 
    base_fee: u64,
    // fee for auto withdrawal platform service
    platform_fee: u64,
}

struct Stream {
    stream_id: field,
    // Config (tenant) the stream was created under.
    config: field,
    sender: address,
    receiver: address,
    full_amount: u128,
    token_program: identifier,
    is_cancelable: bool,
    is_pausable: bool,
    auto_withdrawable: bool,
    can_topup: bool,
    topup_count: u64,
}

struct StreamAnchor {
    stream_id: field,
    start_time: i64,
    duration: u64,
    paused: bool,
    canceled: bool,
    canceled_at: i64,
    deposited_amount: u128,
    last_paused_time: i64,
    paused_interval: u64,
    withdrawn_amount: u128,
    is_public: bool,
    created_timestamp: i64,
    // Config name this stream was created under. Used for tenant binding
    // in private-path lifecycle functions that cannot look up the `Stream`
    // mapping (which only exists for public streams).
    config: field,
}

struct CreateStreamParams {
    receiver: address,
    // Randomness for the stream id.
    stream_id: field,
    amount: u128,
    start_time: i64,
    duration: u64,
    is_cancelable: bool,
    is_pausable: bool,
    auto_withdrawable: bool,
    withdraw_frequency: u64,
    start_now: bool,
    can_topup: bool,
    // Token amount for the initial pre-paid buffer window.
    // When can_topup is true, the initial_buffer_amount is used as the
    // initial deposit; subsequent top-ups cover the remainder.
    initial_buffer_amount: u128,
}

struct StreamTokenFee {
    // Config this fee is signed for. Binds the admin's signature to one
    // stream config so it cannot be replayed against another config.
    config: field,
    // Stream token identifier.
    stream_token: identifier,
    // Admin-signed stream fee amount, denominated in the streaming token's
    // own units (a u128) — NOT ALEO microcredits. Collected via
    // `IARC22::split`/`transfer_private` (private) or
    // `IARC22::transfer_from_public` (public); see `create_stream_private`/
    // `create_stream_public`.
    stream_fee_amount: u128,
    // Full stream amount this fee is signed for (must equal the `amount`
    // field of `CreateStreamParams`). Binds the admin's signature to one
    // stream size so a signed fee cannot be reused for a larger stream.
    stream_amount: u128,
    // Expiry of this signed fee object.
    expiry: i64,
    // Unique nonce — consumed on-chain to prevent replay.
    nonce: field,
}

struct Config {
    config_name: field,
    admin: address,
    fee_vault: address,
    withdrawer: address,
    base_fee: u64,
    platform_fee: u64,
}

// Fallback withdraw frequency (1 day) used as a guarded divisor when
// auto-withdrawal is disabled, because Leo flattens ternary branches so the
// division inside compute_auto_withdrawal_fee is always evaluated.
const DEFAULT_WITHDRAW_FREQUENCY: u64 = 60u64 * 60u64 * 24u64; // daily

const WITHDRAW_FREQUENCIES_LEN: u8 = 11u8;

const WITHDRAW_FREQUENCIES: [u64; WITHDRAW_FREQUENCIES_LEN] = [
        60u64,                              // per minute
        60u64 * 2u64,                       // per 2 minutes
        60u64 * 60u64,                      // hourly
        60u64 * 60u64 * 12u64,              // per half day
        60u64 * 60u64 * 24u64,              // daily
        60u64 * 60u64 * 24u64 * 7u64,       // weekly
        60u64 * 60u64 * 24u64 * 14u64,      // bi-weekly
        60u64 * 60u64 * 24u64 * 30u64,      // monthly
        60u64 * 60u64 * 24u64 * 30u64 * 3u64,   // quarterly
        60u64 * 60u64 * 24u64 * 30u64 * 6u64,   // half-yearly
        60u64 * 60u64 * 24u64 * 365u64,     // yearly
    ];

// Allowed discrepancy between a caller-provided `now` input and the block
// timestamp, in seconds.
const NOW_TOLERANCE: i64 = 2i64 * 60i64; // 2 minutes

// Tighter tolerance used exclusively for cancel operations. Cancel is terminal
// and the sender benefits from a stale `now` (lower vested amount means a
// larger refund). Limiting to 10 s caps the maximum skim to
// (full_amount / duration) * 10 — negligible for all practical stream sizes.
const CANCEL_NOW_TOLERANCE: i64 = 10i64; // 10 seconds

program zebec_stream_v3.aleo {
    // Stream configurations, keyed by unique config name (a BHP256 hash of
    // the off-chain name).
    mapping stream_configs: field => StreamConfig;
    // Whitelisted streaming tokens per config, keyed by BHP256 hash of
    // `WhitelistKey` => allowed.
    mapping whitelisted_token_programs: field => bool;
    // Map of stream_id to stream anchor.
    mapping stream_anchors: field => StreamAnchor;
    // Map of stream_id to stream info (public streams only).
    mapping streams: field => Stream;
    // Map of token-fee nonce => used; prevents signed-fee replay.
    mapping token_fee_nonces: field => bool;
    // Number of public streams ever created by each sender (per config).
    mapping outgoing_stream_counts: field => u64;
    // Number of public streams ever received by each receiver (per config).
    mapping incoming_stream_counts: field => u64;
    // BHP256(StreamRefKey { account, index }) => stream_id (sender registry).
    mapping outgoing_stream_refs: field => field;
    // BHP256(StreamRefKey { account, index }) => stream_id (receiver registry).
    mapping incoming_stream_refs: field => field;

    // Sender stream ticket — authorizes pause/resume/topup/cancel operations.
    record SenderStreamTicket {
        owner: address,
        ticket_type: u8, // 0 = sender ticket
        // Config (tenant) the stream was created under.
        config: field,
        stream_id: field,
        receiver: address,
        token_program: identifier,
        full_amount: u128,
        is_cancelable: bool,
        is_pausable: bool,
        can_topup: bool,
        topup_count: u64,
    }

    // Receiver stream ticket — authorizes withdraw operations.
    record ReceiverStreamTicket {
        owner: address,
        ticket_type: u8, // 1 = receiver ticket
        // Config (tenant) the stream was created under.
        config: field,
        sender: address,
        token_program: identifier,
        full_amount: u128,
        auto_withdrawable: bool,
        stream_id: field,
    }

    // Withdrawer stream ticket — authorizes auto-withdraw on behalf of receiver.
    record WithdrawerStreamTicket {
        owner: address,
        ticket_type: u8, // 2 = withdrawer ticket
        // Config (tenant) the stream was created under. Binds the ticket so
        // only that config's withdrawer can auto-withdraw the stream.
        config: field,
        full_amount: u128,
        stream_id: field,
        sender: address,
        receiver: address,
        token_program: identifier,
        auto_withdrawable: bool,
    }
    
    // Create a private-mode stream: mints the three ticket records and funds
    // the fee/deposit from the caller's private token and credit records.
    // Its `final {}` block below duplicates `create_stream_public`'s
    // verification checklist (config match, signed-fee binding + replay
    // guard, token whitelist, stream-id freshness, anchor write) by hand —
    // there is no shared `finalize_create_stream` helper (see
    // `assert_token_fee_binding`'s comment). Keep the two in sync manually
    // when editing either one.
    fn create_stream_private(
        params: CreateStreamParams,
        token_program: identifier,
        config: Config,
        token_fee: StreamTokenFee,
        fee_signature: signature,
        credit_input_record: credits.aleo::credits,
        token_input_record: dyn record,
        sender_merkle_proofs: [MerkleProof; 2]
    ) -> (
        SenderStreamTicket, 
        ReceiverStreamTicket, 
        WithdrawerStreamTicket, 
        credits.aleo::credits, 
        credits.aleo::credits, 
        dyn record,
        dyn record,
        dyn record,
        dyn record,
        dyn record,
        Final
    ) {
        let caller: address = std::ctx::caller();
        let self_address: address = std::ctx::addr();

        let stream_id = params.stream_id;
        let receiver = params.receiver;
        let start_now = params.start_now;
        let start_time = params.start_time;
        let duration = params.duration;
        let amount = params.amount;
        let can_topup = params.can_topup;
        let is_cancelable = params.is_cancelable;
        let is_pausable = params.is_pausable;
        let initial_buffer_amount = params.initial_buffer_amount;
        let withdraw_frequency = params.withdraw_frequency;
        let auto_withdrawable = params.auto_withdrawable;

        assert_create_params(params);
        assert(caller != receiver);

        let deposit_amount: u128 = can_topup ? initial_buffer_amount : amount;

        // Guard the divisor: when auto-withdrawal is disabled the caller may
        // pass withdraw_frequency = 0; the ternary is flattened by the compiler
        // so compute_auto_withdrawal_fee is always evaluated — use the daily
        // default as a safe divisor to avoid a division-by-zero halt.
        let safe_frequency: u64 = withdraw_frequency > 0u64
            ? withdraw_frequency
            : DEFAULT_WITHDRAW_FREQUENCY;
        let auto_withdrawal_fee: u64 = auto_withdrawable
            ? compute_auto_withdrawal_fee(duration, safe_frequency, config.base_fee, config.platform_fee)
            : 0u64;

        // Credit record must cover the auto-withdrawal fee
        assert(credit_input_record.microcredits >= auto_withdrawal_fee);

        let (change1, change2): (credits.aleo::credits, credits.aleo::credits) =
            credits.aleo::transfer_private(credit_input_record, config.withdrawer, auto_withdrawal_fee);

        // These changes will be consumed by the transfers below, so no need to return them.
        let (token_change1, token_change2): (dyn record, dyn record) =
            IARC22@(token_program)::split(token_input_record, token_fee.stream_fee_amount);
        
        let (comp1, token_change3, token_change4, f_stream_fee_transfer): (dyn record, dyn record, dyn record, Final) =
            IARC22@(token_program)::transfer_private(
                config.fee_vault, token_fee.stream_fee_amount, token_change1, sender_merkle_proofs
            );

        let (comp2, token_change5, f_deposit_amount_transfer): (dyn record, dyn record, Final) =
            IARC22@(token_program)::transfer_private_to_public(
                self_address, deposit_amount, token_change2, sender_merkle_proofs
            );

        let sender_ticket = SenderStreamTicket {
            owner: caller,
            ticket_type: 0u8,
            config: config.config_name,
            stream_id: stream_id,
            receiver: receiver,
            token_program: token_program,
            full_amount: amount,
            is_cancelable: is_cancelable,
            is_pausable: is_pausable,
            can_topup: can_topup,
            topup_count: can_topup ? 1u64 : 0u64, // initial buffer counts as first top-up
        };

        let receiver_ticket = ReceiverStreamTicket {
            owner: receiver,
            ticket_type: 1u8,
            config: config.config_name,
            sender: caller,
            token_program: token_program,
            full_amount: amount,
            auto_withdrawable: auto_withdrawable,
            stream_id: stream_id,
        };

        let withdrawer_ticket = WithdrawerStreamTicket {
            owner: config.withdrawer,
            ticket_type: 2u8,
            config: config.config_name,
            full_amount: amount,
            stream_id: stream_id,
            sender: caller,
            receiver: receiver,
            token_program: token_program,
            auto_withdrawable: auto_withdrawable,
        };

        return (sender_ticket, receiver_ticket, withdrawer_ticket, change1, change2, 
        comp1, token_change3, token_change4, comp2, token_change5, final {
            let now: i64 = std::ctx::block_timestamp();

            // Checks: stream parameter validation.
            assert(start_now || start_time >= now);

            // Checks: config fields matches on chain config
            assert(stream_configs.contains(config.config_name));
            let chain_config: StreamConfig = stream_configs.get(config.config_name);
            assert_config_fields(chain_config, config);

            // Checks: backend-signed token fee.
            // Nonce is scoped to this config to prevent cross-config front-running:
            // an attacker observing nonce N on config A cannot consume it on config B.
            let scoped_nonce_key: field = BHP256::hash_to_field(
                NonceKey { config: config.config_name, nonce: token_fee.nonce }
            );
            let used = token_fee_nonces.get_or_use(scoped_nonce_key, false);
            assert(!used);
            // Consume the nonce so this signed fee cannot be replayed.
            token_fee_nonces.set(scoped_nonce_key, true);
            assert_token_fee_binding(token_fee, config, token_program, now, amount);
            // Message the admin signed: token id || fee amount || stream amount || expiry || nonce.
            let fee_message: field = BHP256::hash_to_field(token_fee);
            // Verified on-chain with a Schnorr signature against the config admin's key.
            let fee_valid: bool = std::sig::verify_schnorr(fee_signature, config.admin, fee_message);
            assert(fee_valid);

            // Checks: token whitelist (scoped to this config).
            let whitelist_key: field = BHP256::hash_to_field(
                WhitelistKey { config: config.config_name, token_program: token_program },
            );
            let allowed = whitelisted_token_programs.get_or_use(whitelist_key, false);
            assert(allowed);

            // Checks: stream id is fresh.
            assert(!stream_anchors.contains(stream_id));

            let final_start_time: i64 = start_now ? now : start_time;
            let stream_anchor = StreamAnchor {
                stream_id: stream_id,
                start_time: final_start_time,
                duration: duration,
                paused: false,
                canceled: false,
                canceled_at: 0i64,
                deposited_amount: deposit_amount,
                last_paused_time: 0i64,
                paused_interval: 0u64,
                withdrawn_amount: 0u128,
                is_public: false,
                created_timestamp: now,
                config: config.config_name,
            };

            stream_anchors.set(stream_id, stream_anchor);

            f_stream_fee_transfer.run();
            f_deposit_amount_transfer.run();
        });
    }

    fn pause_resume_stream_private(
        ticket_record: SenderStreamTicket,
    ) -> (SenderStreamTicket, Final) {
        let caller: address = std::ctx::caller();
        // Check caller is the sender stream ticket owner.
        assert(caller == ticket_record.owner);

        // Check if stream is pausable.
        assert(ticket_record.is_pausable);
        let stream_id = ticket_record.stream_id;

        let sender_ticket = SenderStreamTicket { ..ticket_record };
        return (sender_ticket, final {
            let now: i64 = std::ctx::block_timestamp();
            // Check: stream exists.
            assert(stream_anchors.contains(stream_id));
            let stream_anchor = stream_anchors.get(stream_id);
            // Check: stream is not canceled.
            assert(!stream_anchor.canceled);
            // Check: stream has started.
            assert(stream_anchor.start_time <= now);

            let updated_stream_anchor = apply_pause_toggle(stream_anchor, now);
            stream_anchors.set(stream_id, updated_stream_anchor);
        });
    }

    // Cancel a private stream. On cancel the sender ticket is not burned (but
    // returned) — however, the stream is terminal. The sender, receiver and 
    // withdrawer tickets become inert: all lifecycle entry functions assert 
    // !stream_anchor.canceled so they will reject any future use of those tickets.
    //
    // Payouts use the caller-based `transfer_public_to_private`: the program
    // spends its own public token balance (`self.caller` inside the token
    // program is this program's address), so no allowance is required. The
    // returned ComplianceRecord/Token records are re-emitted as outputs so
    // the refund/payout records actually reach the sender, receiver, and
    // investigator.
    fn cancel_stream_private(
        ticket_record: SenderStreamTicket,
        stream_anchor: StreamAnchor,
        now: i64,
    ) -> (SenderStreamTicket, dyn record, dyn record, dyn record, dyn record, Final) {
        let caller: address = std::ctx::caller();

        // Check: caller is the sender stream ticket owner.
        assert(caller == ticket_record.owner);
        assert(ticket_record.is_cancelable);
        assert(stream_anchor.stream_id == ticket_record.stream_id);
        assert(!stream_anchor.canceled);
        assert(!stream_anchor.is_public);
        
        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        let stream_started: bool = stream_anchor.start_time <= effective_time;
        let prev_paused_interval: u64 = stream_anchor.paused_interval;
        let elapsed_duration: u64 = 0u64;
        if stream_started {
            // Check: stream has not yet ended.
            elapsed_duration = (effective_time as u64 - stream_anchor.start_time as u64) - prev_paused_interval;
            assert(elapsed_duration < stream_anchor.duration);
        }

        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            ticket_record.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= ticket_record.full_amount);
        // Cancel is allowed as long as the receiver's currently-owed portion fits
        // within the vault's available balance (deposited minus already-withdrawn).
        // This unblocks buffer/top-up streams where `deposited < total_vested` but
        // `deposited - withdrawn >= currently_withdrawable` — the sender no longer
        // needs to top up before cancelling.
        let available_balance_private: u128 = stream_anchor.deposited_amount - stream_anchor.withdrawn_amount;
        assert(currently_withdrawable_amount <= available_balance_private);

        let sender_amount: u128 = available_balance_private - currently_withdrawable_amount;

        let (comp_a, token_a, f_sender_amount_transfer)
            = IARC22@(ticket_record.token_program)::transfer_public_to_private(
                ticket_record.owner, sender_amount
            );

        let (comp_b, token_b, f_receiver_amount_transfer)
            = IARC22@(ticket_record.token_program)::transfer_public_to_private(
                ticket_record.receiver, currently_withdrawable_amount
            );

        let stream_id = ticket_record.stream_id;
        // The sender ticket (ticket_record) is re-emmitted but cannot be use again for cancelling
        // as assert(!stream_anchor.canceled); prevents user from canceling again after first success.
        let sender_ticket = SenderStreamTicket { ..ticket_record };

        return (sender_ticket, comp_a, token_a, comp_b, token_b, final {
            let real_now = std::ctx::block_timestamp();
            // Cancel uses a tighter tolerance (CANCEL_NOW_TOLERANCE = 10 s) so the
            // sender cannot choose a stale `now` to minimize the receiver's payout.
            assert(now > 0i64);
            assert((real_now - now).abs() <= CANCEL_NOW_TOLERANCE);
            assert(now <= real_now);
            // Check: stream exists.
            assert(stream_anchors.contains(stream_id));
            let onchain_stream_anchor = stream_anchors.get(stream_id);
            // Check: on-chain anchor matches the caller-supplied snapshot.
            assert_stream_anchor_eq(stream_anchor, onchain_stream_anchor);

            let canceled_stream_anchor = StreamAnchor {
                ..onchain_stream_anchor
            };
            canceled_stream_anchor.canceled = true;
            canceled_stream_anchor.canceled_at = now;
            stream_anchors.set(stream_id, canceled_stream_anchor);

            f_sender_amount_transfer.run();
            f_receiver_amount_transfer.run();
        });
    }

    // Top up a private stream. Sender only: owning the SenderStreamTicket
    // record is the authorization. Debt is the vested amount not yet deposited;
    // extra is capped so the combined deposit cannot exceed the stream total.
    fn topup_stream_private(
        ticket_record: SenderStreamTicket,
        stream_anchor: StreamAnchor,
        extra: u128,
        now: i64,
        token_input_record: dyn record,
        sender_merkle_proofs: [MerkleProof; 2]
    ) -> (SenderStreamTicket, dyn record, dyn record, Final) {
        let caller: address = std::ctx::caller();
        let self_address: address = std::ctx::addr();

        // Check: caller is the sender stream ticket owner.
        assert(caller == ticket_record.owner);
        // Check: stream was created with top-up enabled.
        assert(ticket_record.can_topup);
        assert(stream_anchor.stream_id == ticket_record.stream_id);
        assert(!stream_anchor.canceled);
        assert(!stream_anchor.is_public);
        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: stream has started.
        assert(stream_anchor.start_time <= effective_time);

        let (vested_amount, _) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            ticket_record.full_amount,
            0u128
        );
        let max_possible_topup: u128 = stream_anchor.deposited_amount < ticket_record.full_amount
            ? ticket_record.full_amount - stream_anchor.deposited_amount
            : 0u128;
        let calculated_debt: u128 = vested_amount > stream_anchor.deposited_amount
            ? vested_amount - stream_anchor.deposited_amount
            : 0u128;
        let debt_amount: u128 = calculated_debt < max_possible_topup
            ? calculated_debt
            : max_possible_topup;

        // Extra is capped after debt, so the combined transfer can never
        // exceed the stream's total contractual funding.
        let remaining_capacity: u128 = max_possible_topup - debt_amount;
        let accepted_extra: u128 = extra < remaining_capacity ? extra : remaining_capacity;

        let topup_amount: u128 = debt_amount + accepted_extra;
        assert(topup_amount > 0u128);

        // Pull the top-up into the program's public balance (same pattern as
        // the create_stream_private deposit). The sender's token change record
        // and the compliance record are re-emitted as outputs — discarding
        // them would destroy the change value.
        let (comp, change, f_topup_transfer): (dyn record, dyn record, Final) =
            IARC22@(ticket_record.token_program)::transfer_private_to_public(
                self_address, topup_amount, token_input_record, sender_merkle_proofs
        );

        let stream_id = ticket_record.stream_id;
        let updated_ticket = SenderStreamTicket { ..ticket_record };
        updated_ticket.topup_count = ticket_record.topup_count + 1u64;

        return (updated_ticket, comp, change, final {
            let real_now = std::ctx::block_timestamp();
            // Check: caller-supplied `now` is within 2 minutes (NOW_TOLERANCE) of block time.
            assert_within_tolerance(real_now, now);
            // Reject a caller-supplied `now` in the future: debt inflation risk.
            assert(now <= real_now);
            // Check: stream exists.
            assert(stream_anchors.contains(stream_id));
            let onchain_stream_anchor = stream_anchors.get(stream_id);
            // Check: on-chain anchor matches the caller-supplied snapshot.
            assert_stream_anchor_eq(stream_anchor, onchain_stream_anchor);

            let updated_stream_anchor = StreamAnchor {
                ..onchain_stream_anchor
            };
            updated_stream_anchor.deposited_amount = onchain_stream_anchor.deposited_amount + topup_amount;
            stream_anchors.set(stream_id, updated_stream_anchor);

            f_topup_transfer.run();
        });
    }

    // Payout uses the caller-based `transfer_public_to_private` (the program
    // spends its own public balance; no allowance required) and re-emits the
    // returned ComplianceRecord/Token records as outputs.
    fn withdraw_stream_private(
        ticket_record: ReceiverStreamTicket,
        stream_anchor: StreamAnchor,
        now: i64,
    ) -> (ReceiverStreamTicket, dyn record, dyn record, Final) {
        let caller: address = std::ctx::caller();

        // Check: caller is the receiver stream ticket owner.
        assert(caller == ticket_record.owner);
        assert(stream_anchor.start_time <= now);
        assert(!stream_anchor.canceled);
        assert(!stream_anchor.is_public);

        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: stream has started.
        assert(stream_anchor.start_time <= effective_time);
        // Check: full amount is not yet withdrawn.
        assert(stream_anchor.withdrawn_amount < ticket_record.full_amount);
        assert(stream_anchor.deposited_amount > stream_anchor.withdrawn_amount);

        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            ticket_record.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= ticket_record.full_amount);
        let available_withdraw_amount: u128 = stream_anchor.deposited_amount - stream_anchor.withdrawn_amount;
        // Buffer mode: payout capped at the funded remainder; amounts accrued
        // beyond the deposit stay locked until the next top-up.
        let capped_withdrawable_amount: u128 = currently_withdrawable_amount <= available_withdraw_amount ? currently_withdrawable_amount : available_withdraw_amount;

        let (comp, token, f_receiver_amount_transfer)
            = IARC22@(ticket_record.token_program)::transfer_public_to_private(
                ticket_record.owner, capped_withdrawable_amount
            );

        let stream_id = ticket_record.stream_id;
        let receiver_ticket = ReceiverStreamTicket { ..ticket_record };

        return (receiver_ticket, comp, token, final {
            let real_now = std::ctx::block_timestamp();
            // Check: caller-supplied `now` is within 2 minutes (NOW_TOLERANCE) of block time.
            assert_within_tolerance(real_now, now);
            // Reject a caller-supplied `now` in the future: accrual inflation risk.
            assert(now <= real_now);
            // Check: stream exists.
            assert(stream_anchors.contains(stream_id));
            let onchain_stream_anchor = stream_anchors.get(stream_id);
            // Check: on-chain anchor matches the caller-supplied snapshot.
            assert_stream_anchor_eq(stream_anchor, onchain_stream_anchor);

            let withdrawn_amount: u128 = onchain_stream_anchor.withdrawn_amount + capped_withdrawable_amount;
            let updated_stream_anchor = StreamAnchor {
                ..onchain_stream_anchor
            };
            updated_stream_anchor.withdrawn_amount = withdrawn_amount;
            stream_anchors.set(stream_id, updated_stream_anchor);

            f_receiver_amount_transfer.run();
        });
    }

    // Payout uses the caller-based `transfer_public_to_private` (the program
    // spends its own public balance; no allowance required) and re-emits the
    // returned ComplianceRecord/Token records as outputs.
    fn withdraw_stream_auto_private(
        ticket_record: WithdrawerStreamTicket,
        config: Config,
        stream_anchor: StreamAnchor,
        now: i64
    ) -> (WithdrawerStreamTicket, dyn record, dyn record, Final) {
        let caller: address = std::ctx::caller();

        // Check: caller is the config withdrawer and owns the withdrawer ticket.
        assert(caller == config.withdrawer);
        assert(caller == ticket_record.owner);
        // Check: ticket belongs to this config (tenant binding).
        assert(ticket_record.config == config.config_name);
        // Check: stream was created with auto-withdrawal enabled.
        assert(ticket_record.auto_withdrawable);
        assert(stream_anchor.start_time <= now);
        assert(!stream_anchor.canceled);
        assert(!stream_anchor.is_public);

        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: stream has started.
        assert(stream_anchor.start_time <= effective_time);
        // Check: full amount is not yet withdrawn.
        assert(stream_anchor.withdrawn_amount < ticket_record.full_amount);
        assert(stream_anchor.deposited_amount > stream_anchor.withdrawn_amount);

        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            ticket_record.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= ticket_record.full_amount);
        let available_withdraw_amount: u128 = stream_anchor.deposited_amount - stream_anchor.withdrawn_amount;
        // Buffer mode: payout capped at the funded remainder.
        let capped_withdrawable_amount: u128 = currently_withdrawable_amount <= available_withdraw_amount ? currently_withdrawable_amount : available_withdraw_amount;
        // Check: there is something to pay out (skip dust/zero auto-withdrawals).
        assert(capped_withdrawable_amount > 0u128);

        let (comp, token, f_receiver_amount_transfer)
            = IARC22@(ticket_record.token_program)::transfer_public_to_private(
                ticket_record.receiver, capped_withdrawable_amount
            );

        let stream_id = ticket_record.stream_id;
        let withdrawer_ticket = WithdrawerStreamTicket { ..ticket_record };

        return (withdrawer_ticket, comp, token, final {
            let real_now = std::ctx::block_timestamp();
            // Check: caller-supplied `now` is within 2 minutes (NOW_TOLERANCE) of block time.
            assert_within_tolerance(real_now, now);
            // Reject a caller-supplied `now` in the future: accrual inflation risk.
            assert(now <= real_now);

            // Check: config exists and matches.
            assert(stream_configs.contains(config.config_name));
            let chain_config = stream_configs.get(config.config_name);
            assert_config_fields(chain_config, config);

            // Check: stream exists.
            assert(stream_anchors.contains(stream_id));
            let onchain_stream_anchor = stream_anchors.get(stream_id);
            // Check: on-chain anchor matches the caller-supplied snapshot.
            assert_stream_anchor_eq(stream_anchor, onchain_stream_anchor);
            // Check: stream belongs to this config (tenant binding for private streams).
            // Public streams have a separate `Stream` mapping with a `config` field;
            // private streams only have `StreamAnchor`, so this assertion is the sole
            // on-chain proof that this stream was created under the caller-supplied config.
            assert(onchain_stream_anchor.config == config.config_name);

            let withdrawn_amount: u128 = onchain_stream_anchor.withdrawn_amount + capped_withdrawable_amount;
            let updated_stream_anchor = StreamAnchor {
                ..onchain_stream_anchor
            };
            updated_stream_anchor.withdrawn_amount = withdrawn_amount;
            stream_anchors.set(stream_id, updated_stream_anchor);

            f_receiver_amount_transfer.run();
        });
    }

    // Create a public-mode stream: pulls the fee/deposit from the caller's
    // public token balance via `transfer_from_public` (requires a prior
    // `approve_public` covering `stream_fee_amount + deposit`). Its
    // `final {}` block below duplicates `create_stream_private`'s
    // verification checklist inline (see that function's comment for why),
    // plus additionally writes the public `Stream` mapping entry and appends
    // the sender's/receiver's per-config registry entries.
    fn create_stream_public(
        params: CreateStreamParams,
        token_program: identifier,
        config: Config,
        token_fee: StreamTokenFee,
        fee_signature: signature,
    ) -> Final {
        let caller: address = std::ctx::caller();
        let self_address: address = std::ctx::addr();

        assert_create_params(params);

        assert(caller != params.receiver);

        let deposit_amount: u128 = params.can_topup ? params.initial_buffer_amount : params.amount;

        // Guard the divisor (see create_stream_private for rationale).
        let safe_frequency: u64 = params.withdraw_frequency > 0u64
            ? params.withdraw_frequency
            : DEFAULT_WITHDRAW_FREQUENCY;
        let auto_withdrawal_fee: u64 = params.auto_withdrawable
            ? compute_auto_withdrawal_fee(params.duration, safe_frequency, config.base_fee, config.platform_fee)
            : 0u64;

        // ALEO auto-withdrawal fee is paid from the caller's (employer's) public
        // credits balance via `transfer_public`, which debits `self.caller` inside
        // credits.aleo (= this program). In non-relayed flows the employer funds
        // the program's credit balance; in relayed/sponsored flows the program's
        // balance absorbs the fee rather than unexpectedly charging the tx signer.
        let f_auto_withdrawal_fee_transfer: Final =
            credits.aleo::transfer_public(config.withdrawer, auto_withdrawal_fee);

        let f_stream_fee_transfer: Final =
            IARC22@(token_program)::transfer_from_public(caller, config.fee_vault, token_fee.stream_fee_amount);
        // Pull the token deposit into the program's public balance.
        let f_deposit_transfer: Final =
            IARC22@(token_program)::transfer_from_public(caller, self_address, deposit_amount);

        return final {
            let now: i64 = std::ctx::block_timestamp();

            // Checks: stream parameter validation.
            assert(params.start_now || params.start_time >= now);

            // Checks: config fields matches on chain config
            assert(stream_configs.contains(config.config_name));
            let chain_config: StreamConfig = stream_configs.get(config.config_name);
            assert_config_fields(chain_config, config);

            // Checks: backend-signed token fee.
            // Nonce is scoped to this config to prevent cross-config front-running:
            // an attacker observing nonce N on config A cannot consume it on config B.
            let scoped_nonce_key: field = BHP256::hash_to_field(
                NonceKey { config: config.config_name, nonce: token_fee.nonce }
            );
            let used = token_fee_nonces.get_or_use(scoped_nonce_key, false);
            assert(!used);
            // Consume the nonce so this signed fee cannot be replayed.
            token_fee_nonces.set(scoped_nonce_key, true);
            assert_token_fee_binding(token_fee, config, token_program, now, params.amount);
            // Message the admin signed: token id || fee amount || stream amount || expiry || nonce.
            let fee_message: field = BHP256::hash_to_field(token_fee);
            // Verified on-chain with a Schnorr signature against the config admin's key.
            let fee_valid: bool = std::sig::verify_schnorr(fee_signature, config.admin, fee_message);
            assert(fee_valid);

            // Checks: token whitelist (scoped to this config).
            let whitelist_key: field = BHP256::hash_to_field(
                WhitelistKey { config: config.config_name, token_program: token_program },
            );
            let allowed = whitelisted_token_programs.get_or_use(whitelist_key, false);
            assert(allowed);

            // Checks: stream id is fresh.
            assert(!stream_anchors.contains(params.stream_id));
            
            assert(!streams.contains(params.stream_id));

            let start_time: i64 = params.start_now ? now : params.start_time;
            let stream_anchor = StreamAnchor {
                stream_id: params.stream_id,
                start_time: start_time,
                duration: params.duration,
                paused: false,
                canceled: false,
                canceled_at: 0i64,
                deposited_amount: deposit_amount,
                last_paused_time: 0i64,
                paused_interval: 0u64,
                withdrawn_amount: 0u128,
                is_public: true,
                created_timestamp: now,
                config: config.config_name,
            };

            stream_anchors.set(params.stream_id, stream_anchor);

            // Public streams store metadata in a mapping for on-chain queryability.
            let stream = Stream {
                stream_id: params.stream_id,
                config: config.config_name,
                sender: caller,
                receiver: params.receiver,
                full_amount: params.amount,
                token_program: token_program,
                is_cancelable: params.is_cancelable,
                is_pausable: params.is_pausable,
                can_topup: params.can_topup,
                topup_count: params.can_topup ? 1u64 : 0u64, // initial buffer counts as first top-up
                auto_withdrawable: params.auto_withdrawable,
            };
            streams.set(params.stream_id, stream);

            // Append the stream to the sender's and receiver's public stream
            // registries (append-only; canceled streams are filtered
            // client-side via the anchor state).
            let out_count_key: field = BHP256::hash_to_field(StreamCountKey { account: caller, config: config.config_name });
            let out_idx: u64 = outgoing_stream_counts.get_or_use(out_count_key, 0u64);
            outgoing_stream_refs.set(
                BHP256::hash_to_field(StreamRefKey { account: caller, config: config.config_name, index: out_idx }),
                params.stream_id,
            );
            outgoing_stream_counts.set(out_count_key, out_idx + 1u64);

            let in_count_key: field = BHP256::hash_to_field(StreamCountKey { account: params.receiver, config: config.config_name });
            let in_idx: u64 = incoming_stream_counts.get_or_use(in_count_key, 0u64);
            incoming_stream_refs.set(
                BHP256::hash_to_field(StreamRefKey { account: params.receiver, config: config.config_name, index: in_idx }),
                params.stream_id,
            );
            incoming_stream_counts.set(in_count_key, in_idx + 1u64);

            f_stream_fee_transfer.run();
            f_auto_withdrawal_fee_transfer.run();
            f_deposit_transfer.run();
        };
    }

    fn pause_resume_stream_public(
        stream_id: field,
    ) -> Final {
        let caller: address = std::ctx::caller();
        
        return final {
            let now: i64 = std::ctx::block_timestamp();

            // Check: stream exists and caller is the sender.
            assert(streams.contains(stream_id));
            let stream = streams.get(stream_id);
            assert(caller == stream.sender);
            assert(stream.is_pausable);

            // Check: stream exists.
            assert(stream_anchors.contains(stream_id));

            let stream_anchor = stream_anchors.get(stream_id);
            // Check: stream is not canceled.
            assert(!stream_anchor.canceled);
            assert(stream_anchor.is_public);
            // Check: stream has started.
            assert(stream_anchor.start_time <= now);

            let updated_stream_anchor = apply_pause_toggle(stream_anchor, now);
            stream_anchors.set(stream_id, updated_stream_anchor);
        };
    }

    // Payouts use the caller-based `transfer_public` (the program spends its
    // own public balance; no allowance required).
    fn cancel_stream_public(
        stream: Stream,
        stream_anchor: StreamAnchor,
        now: i64,
    ) -> Final {
        let caller: address = std::ctx::caller();

        // Check: caller is the sender.
        assert(caller == stream.sender);
        assert(stream.is_cancelable);
        assert(stream_anchor.stream_id == stream.stream_id);
        assert(!stream_anchor.canceled);
        assert(stream_anchor.is_public);
        
        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        let stream_started: bool = stream_anchor.start_time <= effective_time;
        let prev_paused_interval: u64 = stream_anchor.paused_interval;
        let elapsed_duration: u64 = 0u64;
        if stream_started {
            // Check: stream has not ended.
            elapsed_duration = (effective_time as u64 - stream_anchor.start_time as u64) - prev_paused_interval;
            assert(elapsed_duration < stream_anchor.duration);
        }

        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            stream.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= stream.full_amount);
        // Cancel is allowed as long as the receiver's currently-owed portion fits
        // within the vault's available balance (deposited minus already-withdrawn).
        // This unblocks buffer/top-up streams where `deposited < total_vested` but
        // `deposited - withdrawn >= currently_withdrawable`.
        let available_balance_public: u128 = stream_anchor.deposited_amount - stream_anchor.withdrawn_amount;
        assert(currently_withdrawable_amount <= available_balance_public);

        let sender_amount: u128 = available_balance_public - currently_withdrawable_amount;

        let stream_token_program = stream.token_program;
        let f_sender_amount_transfer: Final
            = IARC22@(stream_token_program)::transfer_public(
                stream.sender, sender_amount
            );

        let f_receiver_amount_transfer: Final
            = IARC22@(stream_token_program)::transfer_public(
                stream.receiver, currently_withdrawable_amount
            );
        
        return final {
            let real_now = std::ctx::block_timestamp();
            // Cancel uses a tighter tolerance (CANCEL_NOW_TOLERANCE = 10 s) so the
            // sender cannot choose a stale `now` to minimize the receiver's payout.
            assert(now > 0i64);
            assert((real_now - now).abs() <= CANCEL_NOW_TOLERANCE);
            assert(now <= real_now);
            assert(stream_anchor.stream_id == stream.stream_id);
            // Check: stream exists and matches.
            assert(streams.contains(stream.stream_id));
            let onchain_stream = streams.get(stream.stream_id);
            assert_stream_eq(stream, onchain_stream);
            // Check: stream exists and anchor matches.
            assert(stream_anchors.contains(stream_anchor.stream_id));
            let onchain_stream_anchor = stream_anchors.get(stream_anchor.stream_id);
            assert_stream_anchor_eq(stream_anchor, onchain_stream_anchor);

            let canceled_stream_anchor = StreamAnchor {
                ..onchain_stream_anchor
            };
            canceled_stream_anchor.canceled = true;
            canceled_stream_anchor.canceled_at = now;
            stream_anchors.set(stream_anchor.stream_id, canceled_stream_anchor);

            f_sender_amount_transfer.run();
            f_receiver_amount_transfer.run();
        };
    }

    // Top up a public stream. Sender only (see `assert(caller == stream.sender)`
    // below): same debt-first, capped-extra math as `topup_stream_private`,
    // funded via `transfer_from_public` (requires a prior `approve_public`
    // covering at least `amount`).
    fn topup_stream_public(
        stream: Stream,
        stream_anchor: StreamAnchor,
        extra: u128,
        now: i64,
    ) -> Final {
        let caller: address = std::ctx::caller();
        let self_address: address = std::ctx::addr();

        // Check: caller is the stream sender.
        assert(caller == stream.sender);
        // Check: stream was created with top-up enabled.
        assert(stream.can_topup);
        assert(stream_anchor.stream_id == stream.stream_id);
        assert(!stream_anchor.canceled);
        assert(stream_anchor.is_public);
        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: stream has started.
        assert(stream_anchor.start_time <= effective_time);

        let (vested_amount, _) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            stream.full_amount,
            0u128
        );
        let max_possible_topup: u128 = stream_anchor.deposited_amount < stream.full_amount
            ? stream.full_amount - stream_anchor.deposited_amount
            : 0u128;
        let calculated_debt: u128 = vested_amount > stream_anchor.deposited_amount
            ? vested_amount - stream_anchor.deposited_amount
            : 0u128;
        let debt_amount: u128 = calculated_debt < max_possible_topup
            ? calculated_debt
            : max_possible_topup;

        // Extra is capped after debt, so the combined transfer can never
        // exceed the stream's total contractual funding.
        let remaining_capacity: u128 = max_possible_topup - debt_amount;
        let accepted_extra: u128 = extra < remaining_capacity ? extra : remaining_capacity;

        let topup_amount: u128 = debt_amount + accepted_extra;
        assert(topup_amount > 0u128);

        // Pull the top-up into the program's public balance
        let f_topup_transfer: Final =
            IARC22@(stream.token_program)::transfer_from_public(caller, self_address, topup_amount);

        return final {
            let real_now = std::ctx::block_timestamp();
            // Check: caller-supplied `now` is within 2 minutes (NOW_TOLERANCE) of block time.
            assert_within_tolerance(real_now, now);
            // Reject a caller-supplied `now` in the future: debt inflation risk.
            assert(now <= real_now);
            assert(stream_anchor.stream_id == stream.stream_id);
            // Check: stream exists and matches.
            let stream_id = stream.stream_id;
            assert(streams.contains(stream_id));
            let onchain_stream = streams.get(stream_id);
            assert_stream_eq(stream, onchain_stream);
            // Check: stream exists.
            assert(stream_anchors.contains(stream_id));
            let onchain_stream_anchor = stream_anchors.get(stream_id);
            // Check: on-chain anchor matches the caller-supplied snapshot.
            assert_stream_anchor_eq(stream_anchor, onchain_stream_anchor);

            let updated_stream = Stream {
                ..onchain_stream
            };
            updated_stream.topup_count = onchain_stream.topup_count + 1u64;
            streams.set(stream_id, updated_stream);

            let updated_stream_anchor = StreamAnchor {
                ..onchain_stream_anchor
            };
            updated_stream_anchor.deposited_amount = onchain_stream_anchor.deposited_amount + topup_amount;
            stream_anchors.set(stream.stream_id, updated_stream_anchor);

            f_topup_transfer.run();
        };
    }

    // Receiver self-withdraw. Payout uses the caller-based `transfer_public`
    // (the program spends its own public balance; no allowance required).
    // Authorization is the on-chain stream receiver — no Config input, so a
    // fabricated withdrawer cannot force this path.
    fn withdraw_stream_public(
        stream: Stream,
        stream_anchor: StreamAnchor,
        now: i64,
    ) -> Final {
        let caller: address = std::ctx::caller();

        // Check: caller is the stream receiver.
        assert(caller == stream.receiver);
        assert(stream.stream_id == stream_anchor.stream_id);
        // Check: Stream has started
        assert(stream_anchor.start_time <= now);
        assert(!stream_anchor.canceled);
        assert(stream_anchor.is_public);

        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: stream has started.
        assert(stream_anchor.start_time <= effective_time);
        // Check: full amount is not yet withdrawn.
        assert(stream_anchor.withdrawn_amount < stream.full_amount);
        assert(stream_anchor.deposited_amount > stream_anchor.withdrawn_amount);

        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            stream.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= stream.full_amount);
        let available_withdraw_amount: u128 = stream_anchor.deposited_amount - stream_anchor.withdrawn_amount;
        // Buffer mode: payout capped at the funded remainder.
        let capped_withdrawable_amount: u128 = currently_withdrawable_amount <= available_withdraw_amount ? currently_withdrawable_amount : available_withdraw_amount;

        let f_receiver_amount_transfer: Final
            = IARC22@(stream.token_program)::transfer_public(
                stream.receiver, capped_withdrawable_amount
            );
        
        return final {
            let real_now = std::ctx::block_timestamp();
            // Check: caller-supplied `now` is within 2 minutes (NOW_TOLERANCE) of block time.
            assert_within_tolerance(real_now, now);
            assert(now <= real_now);

            assert(stream.stream_id == stream_anchor.stream_id);
            // Check: stream exists and matches.
            assert(streams.contains(stream.stream_id));
            let onchain_stream = streams.get(stream.stream_id);
            assert_stream_eq(stream, onchain_stream);
            // Check: stream exists and anchor matches.
            assert(stream_anchors.contains(stream_anchor.stream_id));
            let onchain_stream_anchor = stream_anchors.get(stream_anchor.stream_id);
            assert_stream_anchor_eq(stream_anchor, onchain_stream_anchor);
        
            let withdrawn_amount: u128 = onchain_stream_anchor.withdrawn_amount + capped_withdrawable_amount;
            let updated_stream_anchor = StreamAnchor {
                ..onchain_stream_anchor
            };
            updated_stream_anchor.withdrawn_amount = withdrawn_amount;
            stream_anchors.set(stream_anchor.stream_id, updated_stream_anchor);

            f_receiver_amount_transfer.run();
        };
    }

    // Withdrawer-triggered payout for a public stream that opted into
    // auto-withdraw. Tenant-bound: the supplied config must be the stream's
    // stream config, and the caller must be that config's on-chain withdrawer.
    fn withdraw_stream_auto_public(
        stream: Stream,
        config: Config,
        stream_anchor: StreamAnchor,
        now: i64,
    ) -> Final {
        let caller: address = std::ctx::caller();

        // Check: caller is this stream's tenant withdrawer, and the stream
        // opted into auto-withdraw. Binding stream.config prevents a
        // foreign config (with the attacker as withdrawer) from authorizing.
        assert(caller == config.withdrawer);
        assert(stream.config == config.config_name);
        assert(stream.auto_withdrawable);
        assert(stream.stream_id == stream_anchor.stream_id);
        // Check: Stream has started
        assert(stream_anchor.start_time <= now);
        assert(!stream_anchor.canceled);
        assert(stream_anchor.is_public);

        let effective_time: i64 = stream_anchor.paused ? stream_anchor.last_paused_time : now;
        // Check: stream has started.
        assert(stream_anchor.start_time <= effective_time);
        // Check: full amount is not yet withdrawn.
        assert(stream_anchor.withdrawn_amount < stream.full_amount);
        assert(stream_anchor.deposited_amount > stream_anchor.withdrawn_amount);

        let (total_withdrawable_amount, currently_withdrawable_amount) = compute_withdrawable_amount(
            effective_time,
            stream_anchor.start_time,
            stream_anchor.duration,
            stream_anchor.paused_interval,
            stream.full_amount,
            stream_anchor.withdrawn_amount
        );

        assert(total_withdrawable_amount <= stream.full_amount);
        let available_withdraw_amount: u128 = stream_anchor.deposited_amount - stream_anchor.withdrawn_amount;
        // Buffer mode: payout capped at the funded remainder.
        let capped_withdrawable_amount: u128 = currently_withdrawable_amount <= available_withdraw_amount ? currently_withdrawable_amount : available_withdraw_amount;

        let f_receiver_amount_transfer: Final
            = IARC22@(stream.token_program)::transfer_public(
                stream.receiver, capped_withdrawable_amount
            );
        
        return final {
            let real_now = std::ctx::block_timestamp();
            // Check: caller-supplied `now` is within 2 minutes (NOW_TOLERANCE) of block time.
            assert_within_tolerance(real_now, now);
            assert(now <= real_now);

            assert(stream.stream_id == stream_anchor.stream_id);
            // Check: stream exists and matches.
            assert(streams.contains(stream.stream_id));
            let onchain_stream = streams.get(stream.stream_id);
            assert_stream_eq(stream, onchain_stream);
            // Check: config exists, matches, and is this stream's tenant.
            assert(stream_configs.contains(config.config_name));
            let chain_config: StreamConfig = stream_configs.get(config.config_name);
            assert_config_fields(chain_config, config);
            // Check: stream exists and anchor matches.
            assert(stream_anchors.contains(stream_anchor.stream_id));
            let onchain_stream_anchor = stream_anchors.get(stream_anchor.stream_id);
            assert_stream_anchor_eq(stream_anchor, onchain_stream_anchor);
        
            let withdrawn_amount: u128 = onchain_stream_anchor.withdrawn_amount + capped_withdrawable_amount;
            let updated_stream_anchor = StreamAnchor {
                ..onchain_stream_anchor
            };
            updated_stream_anchor.withdrawn_amount = withdrawn_amount;
            stream_anchors.set(stream_anchor.stream_id, updated_stream_anchor);

            f_receiver_amount_transfer.run();
        };
    }

    view fn get_stream(stream_id: field) -> Stream {
        assert(streams.contains(stream_id));
        return streams.get(stream_id);
    }

    view fn get_stream_anchor(stream_id: field) -> StreamAnchor {
        assert(stream_anchors.contains(stream_id));
        return stream_anchors.get(stream_id);
    }

    // =========================================================================
    // Views: per-address public stream registries (per config)
    // =========================================================================

    // Number of public streams ever created by `account` under `config`. Iterate
    // `get_outgoing_stream_ref(account, config, 0..count)` to list them.
    view fn get_outgoing_stream_count(account: address, config: field) -> u64 {
        let key: field = BHP256::hash_to_field(StreamCountKey { account: account, config: config });
        return outgoing_stream_counts.get_or_use(key, 0u64);
    }

    // Number of public streams ever received by `account` under `config`.
    view fn get_incoming_stream_count(account: address, config: field) -> u64 {
        let key: field = BHP256::hash_to_field(StreamCountKey { account: account, config: config });
        return incoming_stream_counts.get_or_use(key, 0u64);
    }

    // The stream id at slot `index` of `account`'s outgoing registry under `config`,
    // or `0field` when the slot does not exist.
    view fn get_outgoing_stream_ref(account: address, config: field, index: u64) -> field {
        let key: field = BHP256::hash_to_field(StreamRefKey { account: account, config: config, index: index });
        return outgoing_stream_refs.get_or_use(key, 0field);
    }

    // The stream id at slot `index` of `account`'s incoming registry under `config`,
    // or `0field` when the slot does not exist.
    view fn get_incoming_stream_ref(account: address, config: field, index: u64) -> field {
        let key: field = BHP256::hash_to_field(StreamRefKey { account: account, config: config, index: index });
        return incoming_stream_refs.get_or_use(key, 0field);
    }

    // =========================================================================
    // Admin: configuration management
    // =========================================================================

    // One-time initialization of a stream config under a unique
    // `config_name`. The caller becomes the config's admin.
    fn initialize_config(
        config_name: field,
        fee_vault: address,
        withdrawer: address,
        base_fee: u64,
        platform_fee: u64,
    ) -> Final {
        let caller: address = std::ctx::caller();
        return final {
            // Config names are unique: initialization fails if one exists.
            assert(!stream_configs.contains(config_name));
            stream_configs.set(
                config_name,
                StreamConfig {
                    admin: caller,
                    fee_vault: fee_vault,
                    withdrawer: withdrawer,
                    base_fee: base_fee,
                    platform_fee: platform_fee,
                },
            );
        };
    }

    // Update fee/vault settings of a stream config. Config admin only.
    fn update_config(
        config_name: field,
        fee_vault: address,
        withdrawer: address,
        base_fee: u64,
        platform_fee: u64,
    ) -> Final {
        let caller: address = std::ctx::caller();
        return final {
            let config: StreamConfig = stream_configs.get(config_name);
            assert(config.admin == caller);
            stream_configs.set(
                config_name,
                StreamConfig {
                    admin: config.admin,
                    fee_vault: fee_vault,
                    withdrawer: withdrawer,
                    base_fee: base_fee,
                    platform_fee: platform_fee,
                },
            );
        };
    }

    // Whitelist or de-whitelist a streaming token for a stream config.
    // Config admin only.
    fn set_token_whitelisted(
        config_name: field,
        token_program: identifier,
        allowed: bool,
    ) -> Final {
        let caller: address = std::ctx::caller();
        let whitelist_key: field = BHP256::hash_to_field(
            WhitelistKey { config: config_name, token_program: token_program },
        );

        return final {
            let config: StreamConfig = stream_configs.get(config_name);
            assert(config.admin == caller);
            whitelisted_token_programs.set(whitelist_key, allowed);
        };
    }

    view fn get_stream_config(config_name: field) -> StreamConfig {
        assert(stream_configs.contains(config_name));
        return stream_configs.get(config_name);
    }

    view fn is_token_whitelisted(config_name: field, token_program: identifier) -> bool {
        let whitelist_key: field = BHP256::hash_to_field(
            WhitelistKey { config: config_name, token_program: token_program },
        );
        return whitelisted_token_programs.get_or_use(whitelist_key, false);
    }

    // Only this address may deploy upgrades to this program (Leo
    // admin-upgrade mode); this constructor's own logic becomes immutable
    // once the program is first deployed.
    // @admin(address="aleo12czxn500cyj9a7lweuft6r4rrckthfck5k8440qh7atgrnt5kupqsfh038") // testnet
    @admin(address="aleo1ta644kz3qqlwz5tg8pkee8qdwt4wlttuz4zjuhke2e3ph8x8ty9szywrvx") // mainnet
    constructor() {}
}

// =============================================================================
// Transition-level parameter validation shared by both create entry functions.
// Pure asserts only — no mapping access. Inlined by the compiler.
// =============================================================================
fn assert_create_params(params: CreateStreamParams) {
    assert(params.duration > 0u64);
    assert(params.amount > 0u128);
    assert(!params.can_topup || (params.initial_buffer_amount > 0u128 && params.initial_buffer_amount <= params.amount));
    assert(!params.auto_withdrawable || (params.withdraw_frequency > 0u64 && is_withdraw_frequency_valid(params.withdraw_frequency)));
}

// =============================================================================
// Pure helper functions
// =============================================================================

// Compute the total withdrawable and currently withdrawable amounts for a
// stream. Returns (total_withdrawable_amount, currently_withdrawable_amount).
fn compute_withdrawable_amount(
    effective_now: i64,
    start_time: i64,
    duration: u64,
    paused_interval: u64,
    full_stream_amount: u128, 
    withdrawn_amount: u128,
) -> (u128, u128) {
    assert(duration > 0u64);
    
    if (effective_now <= start_time) {
        return (0u128, 0u128);
    }
    
    let elapsed_duration: u64 = (effective_now as u64 - start_time as u64) - paused_interval;
    
    if (elapsed_duration <= 0u64) {
        return (0u128, 0u128);
    }

    if (elapsed_duration >= duration) {
        return (full_stream_amount, full_stream_amount - withdrawn_amount);
    }

    let total_withdrawable_amount: u128 = elapsed_duration as u128 * full_stream_amount / duration as u128;
    assert(total_withdrawable_amount >= withdrawn_amount);
        
    return (total_withdrawable_amount, total_withdrawable_amount - withdrawn_amount);
}

// Assert every field of `provided` matches `onchain`. Used by cancel/topup/
// withdraw finals to confirm the caller-supplied anchor equals on-chain state.
fn assert_stream_anchor_eq(provided: StreamAnchor, onchain: StreamAnchor) {
    assert(onchain.stream_id == provided.stream_id);
    assert(onchain.start_time == provided.start_time);
    assert(onchain.duration == provided.duration);
    assert(onchain.paused == provided.paused);
    assert(onchain.canceled == provided.canceled);
    assert(onchain.canceled_at == provided.canceled_at);
    assert(onchain.deposited_amount == provided.deposited_amount);
    assert(onchain.last_paused_time == provided.last_paused_time);
    assert(onchain.paused_interval == provided.paused_interval);
    assert(onchain.withdrawn_amount == provided.withdrawn_amount);
    assert(onchain.is_public == provided.is_public);
    assert(onchain.created_timestamp == provided.created_timestamp);
    assert(onchain.config == provided.config);
}

// Assert every field of `provided` stream matches `onchain`.
fn assert_stream_eq(provided: Stream, onchain: Stream) {
    assert(onchain.stream_id == provided.stream_id);
    assert(onchain.config == provided.config);
    assert(onchain.sender == provided.sender);
    assert(onchain.receiver == provided.receiver);
    assert(onchain.full_amount == provided.full_amount);
    assert(onchain.token_program == provided.token_program);
    assert(onchain.is_cancelable == provided.is_cancelable);
    assert(onchain.is_pausable == provided.is_pausable);
    assert(onchain.can_topup == provided.can_topup);
    assert(onchain.auto_withdrawable == provided.auto_withdrawable);
    assert(onchain.topup_count == provided.topup_count);
}

// Assert the on-chain config matches the caller-provided config struct.
fn assert_config_fields(chain: StreamConfig, provided: Config) {
    assert(chain.admin == provided.admin);
    assert(chain.fee_vault == provided.fee_vault);
    assert(chain.withdrawer == provided.withdrawer);
    assert(chain.base_fee == provided.base_fee);
    assert(chain.platform_fee == provided.platform_fee);
}

// Read-only binding/expiry checks for the admin-signed token fee. The
// nonce-consume (`token_fee_nonces`) and the Schnorr signature verification
// stay inline in each create entry's own `final {}` block instead of here,
// because they need mapping access — a plain `fn` can't read/write mappings.
// `create_stream_private` and `create_stream_public` do NOT share a
// `finalize_create_stream` helper; they each inline the same checklist
// independently (see the comments on both functions below).
fn assert_token_fee_binding(
    token_fee: StreamTokenFee,
    config: Config,
    token_program: identifier,
    now: i64,
    stream_amount: u128,
) {
    assert(now < token_fee.expiry);
    assert(token_fee.stream_token == token_program);
    assert(token_fee.config == config.config_name);
    // The admin-signed fee is bound to the exact stream amount being created;
    // prevents reusing a smaller-stream fee for a larger `params.amount`.
    assert(token_fee.stream_amount == stream_amount);
}

// Assert the caller-supplied `now` is within NOW_TOLERANCE (2 minutes) of
// the on-chain block timestamp.
// `assert(now > 0i64)` prevents a malformed `now = i64::MIN` from causing an
// i64 checked-arithmetic overflow in the subtraction `real_now - now`.
fn assert_within_tolerance(real_now: i64, now: i64) {
    assert(now > 0i64);
    assert((real_now - now).abs() <= NOW_TOLERANCE);
}

// Apply a pause/resume toggle to `anchor` given the current `now`, returning
// the updated anchor. The caller performs the `stream_anchors.set`.
fn apply_pause_toggle(anchor: StreamAnchor, now: i64) -> StreamAnchor {
    let updated: StreamAnchor = StreamAnchor { ..anchor };
    if (anchor.paused) {
        assert(anchor.last_paused_time <= now);
        let paused_span: u64 = now as u64 - anchor.last_paused_time as u64;
        let paused_interval = anchor.paused_interval + paused_span;
        updated.paused_interval = paused_interval;
        // Keep the contractual duration immutable. Accrual subtracts
        // paused_interval, which already extends the wall-clock end by the
        // complete paused span without reducing the stream rate.
        updated.paused = false;
        updated.last_paused_time = 0i64;
    } else {
        let elapsed_duration: u64 = (now as u64 - anchor.start_time as u64) - anchor.paused_interval;
        assert(elapsed_duration < anchor.duration);
        updated.paused = true;
        updated.last_paused_time = now;
    }
    return updated;
}

// Compute the auto-withdrawal fee in microcredits for a stream.
// `safe_withdraw_frequency` must be > 0 (callers use DEFAULT_WITHDRAW_FREQUENCY
// as a fallback when auto-withdrawal is disabled, to prevent division by zero
// in the flattened ternary).
fn compute_auto_withdrawal_fee(
    duration: u64,
    safe_withdraw_frequency: u64,
    base_fee: u64,
    platform_fee: u64,
) -> u64 {
    assert(is_withdraw_frequency_valid(safe_withdraw_frequency));
    // duration is multiplied by base fee first and divied by withdraw frequency later
    // so that decimal value does get accounted which would have be ommitted if duration
    // was divided by withdraw frequency first
    let transaction_fee: u64 = (duration * base_fee) / safe_withdraw_frequency;
    return platform_fee + transaction_fee;
}

fn is_withdraw_frequency_valid(withdraw_frequency: u64) -> bool {
    let found = false;

    for i in 0u8..WITHDRAW_FREQUENCIES_LEN {
        if (!found && withdraw_frequency == WITHDRAW_FREQUENCIES[i]) {
            found = true;
        }
    }

    return found;
}