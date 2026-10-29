// Deploys the program into the local `leo test` VM (testnet consensus).
// This does not broadcast to a public network.
import test_zebec_streaming_v1.aleo;

const CALLER: address = aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px;
const RECEIVER: address = aleo12czxn500cyj9a7lweuft6r4rrckthfck5k8440qh7atgrnt5kupqsfh038;
const VAULT: address = aleo12czxn500cyj9a7lweuft6r4rrckthfck5k8440qh7atgrnt5kupqsfh038;

program local_deploy.aleo {
    @noupgrade
    constructor() {}

    @test
    fn test_initialize_config() -> Final {
        let config_name: field = 1field;
        let created: Final = test_zebec_streaming_v1.aleo::initialize_config(config_name, VAULT, VAULT, 10u64, 20u64);
        return final {
            created.run();
        };
    }

    @test
    @should_fail
    fn test_initialize_config_twice() -> Final {
        let config_name: field = 2field;
        let first: Final = test_zebec_streaming_v1.aleo::initialize_config(config_name, VAULT, VAULT, 0u64, 0u64);
        let second: Final = test_zebec_streaming_v1.aleo::initialize_config(config_name, VAULT, VAULT, 0u64, 0u64);
        return final {
            first.run();
            second.run();
        };
    }

    @test
    fn test_update_config() -> Final {
        let config_name: field = 3field;
        let created: Final = test_zebec_streaming_v1.aleo::initialize_config(config_name, VAULT, VAULT, 1u64, 2u64);
        let updated: Final = test_zebec_streaming_v1.aleo::update_config(config_name, CALLER, CALLER, 8u64, 9u64);
        return final {
            created.run();
            updated.run();
        };
    }

    @test
    @should_fail
    fn test_update_config_missing() -> Final {
        let updated: Final = test_zebec_streaming_v1.aleo::update_config(99field, VAULT, VAULT, 0u64, 0u64);
        return final {
            updated.run();
        };
    }

    @test
    fn test_whitelist_token() -> Final {
        let config_name: field = 4field;
        let created: Final = test_zebec_streaming_v1.aleo::initialize_config(config_name, VAULT, VAULT, 0u64, 0u64);
        let listed: Final = test_zebec_streaming_v1.aleo::set_token_whitelisted(config_name, 'local_deploy', true);
        return final {
            created.run();
            listed.run();
        };
    }

    @test
    @should_fail
    fn test_whitelist_missing_config() -> Final {
        let listed: Final = test_zebec_streaming_v1.aleo::set_token_whitelisted(98field, 'local_deploy', true);
        return final {
            listed.run();
        };
    }

    @test
    @should_fail
    fn test_pause_missing_stream() -> Final {
        let paused: Final = test_zebec_streaming_v1.aleo::pause_resume_stream_public(77field);
        return final {
            paused.run();
        };
    }

    @test
    @should_fail
    fn test_cancel_public_missing() -> Final {
        let stream: test_zebec_streaming_v1.aleo::Stream = test_zebec_streaming_v1.aleo::Stream {
            stream_id: 8field,
            config: 10field,
            sender: CALLER,
            receiver: RECEIVER,
            full_amount: 1u128,
            token_program: 'local_deploy',
            is_cancelable: true,
            is_pausable: true,
            auto_withdrawable: false,
            can_topup: false,
            topup_count: 0u64,
        };
        let anchor: test_zebec_streaming_v1.aleo::StreamAnchor = test_zebec_streaming_v1.aleo::StreamAnchor {
            stream_id: 8field,
            start_time: 1i64,
            duration: 86400u64,
            paused: false,
            canceled: false,
            canceled_at: 0i64,
            deposited_amount: 1u128,
            last_paused_time: 0i64,
            paused_interval: 0u64,
            withdrawn_amount: 0u128,
            is_public: true,
            created_timestamp: 1i64,
            config: 10field,
        };
        let canceled: Final = test_zebec_streaming_v1.aleo::cancel_stream_public(stream, anchor, 1i64);
        return final {
            canceled.run();
        };
    }

    @test
    @should_fail
    fn test_topup_public_missing() -> Final {
        let stream: test_zebec_streaming_v1.aleo::Stream = test_zebec_streaming_v1.aleo::Stream {
            stream_id: 9field,
            config: 10field,
            sender: CALLER,
            receiver: RECEIVER,
            full_amount: 2u128,
            token_program: 'local_deploy',
            is_cancelable: true,
            is_pausable: true,
            auto_withdrawable: false,
            can_topup: true,
            topup_count: 1u64,
        };
        let anchor: test_zebec_streaming_v1.aleo::StreamAnchor = test_zebec_streaming_v1.aleo::StreamAnchor {
            stream_id: 9field,
            start_time: 1i64,
            duration: 86400u64,
            paused: false,
            canceled: false,
            canceled_at: 0i64,
            deposited_amount: 1u128,
            last_paused_time: 0i64,
            paused_interval: 0u64,
            withdrawn_amount: 0u128,
            is_public: true,
            created_timestamp: 1i64,
            config: 10field,
        };
        let topped: Final = test_zebec_streaming_v1.aleo::topup_stream_public(stream, anchor, 1u128, 1i64);
        return final {
            topped.run();
        };
    }

    @test
    @should_fail
    fn test_withdraw_not_receiver() -> Final {
        let stream: test_zebec_streaming_v1.aleo::Stream = test_zebec_streaming_v1.aleo::Stream {
            stream_id: 11field,
            config: 10field,
            sender: RECEIVER,
            receiver: RECEIVER,
            full_amount: 1u128,
            token_program: 'local_deploy',
            is_cancelable: true,
            is_pausable: false,
            auto_withdrawable: false,
            can_topup: false,
            topup_count: 0u64,
        };
        let anchor: test_zebec_streaming_v1.aleo::StreamAnchor = test_zebec_streaming_v1.aleo::StreamAnchor {
            stream_id: 11field,
            start_time: 1i64,
            duration: 86400u64,
            paused: false,
            canceled: false,
            canceled_at: 0i64,
            deposited_amount: 1u128,
            last_paused_time: 0i64,
            paused_interval: 0u64,
            withdrawn_amount: 0u128,
            is_public: true,
            created_timestamp: 1i64,
            config: 10field,
        };
        let drawn: Final = test_zebec_streaming_v1.aleo::withdraw_stream_public(stream, anchor, 1i64);
        return final {
            drawn.run();
        };
    }

    @test
    @should_fail
    fn test_auto_withdraw_missing() -> Final {
        let stream: test_zebec_streaming_v1.aleo::Stream = test_zebec_streaming_v1.aleo::Stream {
            stream_id: 12field,
            config: 10field,
            sender: RECEIVER,
            receiver: RECEIVER,
            full_amount: 1u128,
            token_program: 'local_deploy',
            is_cancelable: false,
            is_pausable: false,
            auto_withdrawable: true,
            can_topup: false,
            topup_count: 0u64,
        };
        let config: test_zebec_streaming_v1.aleo::Config = test_zebec_streaming_v1.aleo::Config {
            config_name: 10field,
            admin: CALLER,
            fee_vault: VAULT,
            withdrawer: CALLER,
            base_fee: 0u64,
            platform_fee: 0u64,
        };
        let anchor: test_zebec_streaming_v1.aleo::StreamAnchor = test_zebec_streaming_v1.aleo::StreamAnchor {
            stream_id: 12field,
            start_time: 1i64,
            duration: 86400u64,
            paused: false,
            canceled: false,
            canceled_at: 0i64,
            deposited_amount: 1u128,
            last_paused_time: 0i64,
            paused_interval: 0u64,
            withdrawn_amount: 0u128,
            is_public: true,
            created_timestamp: 1i64,
            config: 10field,
        };
        let drawn: Final = test_zebec_streaming_v1.aleo::withdraw_stream_auto_public(stream, config, anchor, 1i64);
        return final {
            drawn.run();
        };
    }
}
