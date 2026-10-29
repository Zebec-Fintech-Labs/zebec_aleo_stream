// Failing-tests-first for the zebec_streaming_v1.aleo first-pass audit.
//
// The pure helpers under test (compute_withdrawable_amount,
// compute_auto_withdrawal_fee, assert_within_tolerance) are NOT exported from
// zebec_streaming_v1.aleo, so they cannot be called cross-program. To keep the
// audited contract untouched, this test file re-declares them VERBATIM
// (byte-for-byte from src/main.leo at the SHA under review,
// e87fdf70d4b4d590733defcdb4abca5ea0a92fa6) as top-level functions and drives
// those copies. Any fix must be applied to BOTH src/main.leo AND these copies
// so the tests flip to passing — the copies are the unpatched oracle.
//
// Run with: leo test
//
// NOTE: we intentionally do NOT `import zebec_streaming_v1.aleo` — importing it
// forces a deployment of the audited program inside the test VM, which is
// rejected in this environment. The helpers are copied verbatim instead.

// ---- VERBATIM top-level copies from src/main.leo (unpatched) -------------

const NOW_TOLERANCE: i64 = 2i64 * 60i64; // 2 minutes

const WITHDRAW_FREQUENCIES_LEN: u8 = 11u8;
const WITHDRAW_FREQUENCIES: [u64; WITHDRAW_FREQUENCIES_LEN] = [
    60u64, 60u64 * 2u64, 60u64 * 60u64, 60u64 * 60u64 * 12u64,
    60u64 * 60u64 * 24u64, 60u64 * 60u64 * 24u64 * 7u64,
    60u64 * 60u64 * 24u64 * 14u64, 60u64 * 60u64 * 24u64 * 30u64,
    60u64 * 60u64 * 24u64 * 30u64 * 3u64, 60u64 * 60u64 * 24u64 * 30u64 * 6u64,
    60u64 * 60u64 * 24u64 * 365u64,
];

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

fn compute_auto_withdrawal_fee(
    duration: u64,
    safe_withdraw_frequency: u64,
    base_fee: u64,
    platform_fee: u64,
) -> u64 {
    assert(is_withdraw_frequency_valid(safe_withdraw_frequency));
    let transaction_fee: u64 = (duration * base_fee) / safe_withdraw_frequency;
    return platform_fee + transaction_fee;
}

fn assert_within_tolerance(real_now: i64, now: i64) {
    assert((real_now - now).abs() <= NOW_TOLERANCE);
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

// Identity functions used to defeat compile-time constant evaluation: the
// compiler cannot see through a function boundary, so values passed through
// these become RUNTIME witnesses. This is what forces the overflow in the
// findings to surface as a runtime abort (a real test pass/fail signal)
// instead of a compile-time constant-eval error.
fn id_u128(x: u128) -> u128 {
    return x + 0u128;
}
fn id_u64(x: u64) -> u64 {
    return x + 0u64;
}
fn id_i64(x: i64) -> i64 {
    return x + 0i64;
}

// ---- Test program ---------------------------------------------------------

program test_audit_findings.aleo {
    @noupgrade
    constructor() {}

    // C3-01: elapsed * full_amount overflows u128 mid-stream for large amounts.
    // full_amount = 1e34, duration = 1 year, elapsed = 40,000s (> ~34,029s
    // overflow onset). MUST NOT abort; unpatched code aborts in the multiply.
    @test
    fn c3_01_vesting_overflow() {
        let full_amount: u128 = id_u128(10_000_000_000_000_000_000_000_000_000_000_000u128); // 1e34
        let duration: u64 = 31_536_000u64; // 1 year
        let start_time: i64 = 1_700_000_000i64;
        let effective_now: i64 = id_i64(start_time + 40_000i64); // elapsed 40,000
        let (total, current) = compute_withdrawable_amount(
            effective_now, start_time, duration, 0u64, full_amount, 0u128
        );
        // Expected exact share, computed overflow-free (divide first):
        let d128: u128 = duration as u128;
        let e128: u128 = 40_000u128;
        let expected: u128 =
            full_amount / d128 * e128 + (full_amount % d128) * e128 / d128;
        assert_eq(total, expected);
        assert_eq(current, expected);
    }

    // Boundary: largest no-overflow amount for a 1-year stream, at
    // elapsed = duration - 1. Unpatched code aborts. MUST NOT abort.
    @test
    fn c3_01_vesting_overflow_edge() {
        let full_amount: u128 = id_u128(10_790_283_412_963_656_659_913_472_455_138u128); // ~1.079e31
        let duration: u64 = 31_536_000u64;
        let start_time: i64 = 1_700_000_000i64;
        let effective_now: i64 = id_i64(start_time + 31_535_999i64); // elapsed = duration-1
        let (total, cur) = compute_withdrawable_amount(
            effective_now, start_time, duration, 0u64, full_amount, 0u128
        );
        assert(total > 0u128);
        assert(total <= full_amount);
    }

    // C3-02: (duration * base_fee) u64 overflow. 1-year duration + base_fee
    // above floor(u64::MAX/31_536_000)=584,942,417,355 aborts -> create DoS.
    // MUST NOT abort for a correct impl; unpatched aborts.
    @test
    fn c3_02_autofee_overflow() {
        let duration: u64 = id_u64(31_536_000u64); // 1 year
        let base_fee: u64 = id_u64(600_000_000_000u64); // > 584,942,417,355
        let platform_fee: u64 = 0u64;
        let frequency: u64 = 86_400u64; // daily (valid)
        let fee: u64 = compute_auto_withdrawal_fee(duration, frequency, base_fee, platform_fee);
        // Expected exact value, computed overflow-free:
        let expected: u64 =
            base_fee * (duration / frequency) + base_fee * (duration % frequency) / frequency;
        assert_eq(fee, expected);
    }

    // 9-A: (real_now - now) overflows i64 for now = i64::MIN -> uncontrolled
    // abort instead of a clean tolerance reject. @should_fail catches the
    // rejection today, but the reason is an overflow halt, not a clean assert.
    @test
    @should_fail
    fn a9_tolerance_extreme_now() {
        assert_within_tolerance(id_i64(1_700_000_000i64), id_i64(-9_223_372_036_854_775_808i64));
    }

    // In-tolerance `now` MUST be accepted (guards inverted-boolean blind spot,
    // ToB-ALEO-21). Must PASS now and after any fix.
    @test
    fn a9_tolerance_valid_now() {
        assert_within_tolerance(1_700_000_000i64, 1_699_999_970i64); // 30s
        assert_within_tolerance(1_700_000_000i64, 1_699_999_880i64); // 120s boundary
    }

    // 121s stale must be REJECTED (one past last valid value).
    @test
    @should_fail
    fn a9_tolerance_121s_stale() {
        assert_within_tolerance(1_700_000_000i64, 1_699_999_879i64);
    }
}
