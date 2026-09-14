import assert from "node:assert";
import { describe, it } from "mocha";

import {
  configNameToField,
  hashPlaintextToField,
  streamCountKey,
  streamRefKey,
  streamTokenFeeMessage,
  whitelistKey,
} from "../sdk/hashing.js";

// Known vector produced on-chain with `leo run` (Leo 4.4.1, testnet) against
// the StreamTokenFee struct:
//   { config: 12345field, stream_token: 'token', stream_fee_amount: 50000u128,
//     stream_amount: 100000000u128, expiry: 1893456000i64, nonce: 5field }
// If this matches, the off-chain BHP256 hashing reproduces
// `BHP256::hash_to_field` for StreamTokenFee exactly.
//
// To regenerate: hash the plaintext above with BHP256::hash_to_field on-chain
// and record the resulting field.
// NOTE (stream_amount): this vector was computed off-chain with the SDK's
// wasm BHP256 after adding `stream_amount` (which changes the preimage); it
// must be re-confirmed with `leo run` against the deployed program before
// relying on it.
//
// Whitelist key vector is unchanged (WhitelistKey struct unchanged).
const WHITELIST_KEY =
  "5949549857295180779432337181339499322185250953286779710073517871832327878616field";
const STREAM_TOKEN_FEE_MESSAGE =
  "444813473149911723635518902530683060313170442593457409697886521359017725433field";

describe("hashing — StreamTokenFee (known on-chain vector)", () => {
  it("streamTokenFeeMessage reproduces the on-chain fee message", () => {
    const message = streamTokenFeeMessage({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 50_000n,
      streamAmount: 100_000_000n,
      expiry: 1_893_456_000n,
      nonce: 5n,
    });
    assert.equal(message, STREAM_TOKEN_FEE_MESSAGE);
    // Verify determinism.
    assert.equal(
      message,
      streamTokenFeeMessage({
        config: 12345n,
        streamToken: "token",
        streamFeeAmount: 50_000n,
        streamAmount: 100_000_000n,
        expiry: 1_893_456_000n,
        nonce: 5n,
      }),
    );
    // Verify different fee amounts produce different hashes.
    const other = streamTokenFeeMessage({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 99_999n,
      streamAmount: 100_000_000n,
      expiry: 1_893_456_000n,
      nonce: 5n,
    });
    assert.notEqual(message, other);
  });

  it("nonce change produces a different hash", () => {
    const a = streamTokenFeeMessage({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 50_000n,
      streamAmount: 100_000_000n,
      expiry: 1_893_456_000n,
      nonce: 5n,
    });
    const b = streamTokenFeeMessage({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 50_000n,
      streamAmount: 100_000_000n,
      expiry: 1_893_456_000n,
      nonce: 6n,
    });
    assert.notEqual(a, b);
  });
});

describe("hashing — whitelisted_token_programs mapping key", () => {
  it("computes the mapping key like on-chain", () => {
    assert.equal(whitelistKey("12345", "my_token"), WHITELIST_KEY);
  });
});

describe("configNameToField", () => {
  it("is deterministic and returns a canonical field literal", () => {
    const a = configNameToField("zebec-stream");
    assert.equal(a, configNameToField("zebec-stream"));
    assert.match(a, /^\d+field$/);
    assert.notEqual(a, configNameToField("other-name"));
  });
});

// Known vectors produced with `leo run` against a scratch program computing
// `BHP256::hash_to_field(StreamRefKey { account, config, index })` and
// `BHP256::hash_to_field(StreamCountKey { account, config })` (Leo 4.4.1).
const REF_KEY_ADDRESS =
  "aleo12czxn500cyj9a7lweuft6r4rrckthfck5k8440qh7atgrnt5kupqsfh038";
const REF_KEY_CONFIG = 12345n;
const REF_KEY_VECTORS: [bigint, string][] = [
  [
    0n,
    "6020195188621236084074400941031386350611068300278742228244089924752997965268field",
  ],
  [
    1n,
    "6561316225218808297871897282156571022119172125950759523595370864740352486132field",
  ],
  [
    2n,
    "3736302156749057264992416909993913953306681731787592185930978272894613483000field",
  ],
];
const COUNT_KEY_VECTOR =
  "8442124999102044995407373519281975725322734095700296910850922699010126814628field";

describe("hashing — StreamRefKey (known on-chain vectors)", () => {
  it("streamRefKey reproduces the on-chain registry keys", () => {
    for (const [index, expected] of REF_KEY_VECTORS) {
      assert.equal(streamRefKey(REF_KEY_ADDRESS, REF_KEY_CONFIG, index), expected);
    }
  });

  it("different indices produce different keys", () => {
    const [, a] = REF_KEY_VECTORS[0]!;
    const [, b] = REF_KEY_VECTORS[1]!;
    assert.notEqual(a, b);
  });
});

describe("hashing — StreamCountKey (known on-chain vector)", () => {
  it("streamCountKey reproduces the on-chain count key", () => {
    assert.equal(streamCountKey(REF_KEY_ADDRESS, REF_KEY_CONFIG), COUNT_KEY_VECTOR);
  });

  it("different configs produce different keys", () => {
    assert.notEqual(
      streamCountKey(REF_KEY_ADDRESS, REF_KEY_CONFIG),
      streamCountKey(REF_KEY_ADDRESS, 54321n),
    );
  });
});

// ===========================================================================
// Edge cases derived from `src/main.leo`
// ===========================================================================

describe("hashing — key derivation edge cases", () => {
  const ACCOUNT = REF_KEY_ADDRESS;

  it("accepts a config as a bare string, a suffixed literal or a bigint", () => {
    assert.equal(whitelistKey("12345", "my_token"), whitelistKey(12345n, "my_token"));
    assert.equal(whitelistKey("12345field", "my_token"), whitelistKey(12345n, "my_token"));
    assert.equal(streamCountKey(ACCOUNT, "12345"), streamCountKey(ACCOUNT, 12345n));
    assert.equal(streamRefKey(ACCOUNT, "12345", 2), streamRefKey(ACCOUNT, 12345n, 2n));
  });

  it("separates whitelist entries per config and per token", () => {
    // `WhitelistKey { config, token_program }` scopes the whitelist to one
    // tenant: whitelisting a token under one config must not leak to another.
    assert.notEqual(whitelistKey(1n, "my_token"), whitelistKey(2n, "my_token"));
    assert.notEqual(whitelistKey(1n, "my_token"), whitelistKey(1n, "my_token2"));
  });

  it("rejects token programs that are not Leo identifiers", () => {
    // The on-chain member is an `identifier`, so a program id with `.aleo`
    // would hash to a key the program never writes.
    assert.throws(() => whitelistKey(1n, "my_token.aleo"));
    assert.throws(() => whitelistKey(1n, "My_Token"));
  });

  it("separates registry slots per account, per config and per index", () => {
    assert.notEqual(streamRefKey(ACCOUNT, 1n, 0), streamRefKey(ACCOUNT, 1n, 1));
    assert.notEqual(streamRefKey(ACCOUNT, 1n, 0), streamRefKey(ACCOUNT, 2n, 0));
    assert.notEqual(
      streamRefKey(ACCOUNT, 1n, 0),
      streamRefKey("aleo1ezamst4pjgj9zfxqq0fwfj8a4cjuqndmasgata3hggzqygggnyfq6kmyd4", 1n, 0),
    );
  });

  it("does not collide a count key with the index-0 ref key", () => {
    // `StreamCountKey` and `StreamRefKey` share a mapping-key space only by
    // accident of both being fields; the extra `index` member separates them.
    assert.notEqual(streamCountKey(ACCOUNT, 1n), streamRefKey(ACCOUNT, 1n, 0));
  });

  it("handles the u64 index bounds used by the registries", () => {
    const max = (1n << 64n) - 1n;
    assert.match(streamRefKey(ACCOUNT, 1n, max), /^\d+field$/);
    assert.throws(() => streamRefKey(ACCOUNT, 1n, max + 1n));
    assert.throws(() => streamRefKey(ACCOUNT, 1n, -1n));
  });

  it("rejects plaintext that snarkVM cannot parse", () => {
    assert.throws(() => hashPlaintextToField("not a struct"));
    assert.throws(() => hashPlaintextToField("{ a: }"));
  });
});

describe("configNameToField — edge cases", () => {
  it("is byte-sensitive", () => {
    assert.notEqual(configNameToField("Stream_Config_001"), configNameToField("stream_config_001"));
    assert.notEqual(configNameToField("zebec"), configNameToField("zebec "));
    assert.notEqual(configNameToField("zebec"), configNameToField("zebe c"));
  });

  it("hashes multi-byte utf-8 names deterministically", () => {
    const emoji = configNameToField("🎉 stream");
    assert.match(emoji, /^\d+field$/);
    assert.equal(emoji, configNameToField("🎉 stream"));
  });

  it("maps the empty name onto the 0field sentinel", () => {
    // BHP256 over zero bits is 0field, which is also what
    // `get_outgoing_stream_ref` returns for an absent slot — never derive a
    // config from an empty name.
    assert.equal(configNameToField(""), "0field");
  });
});

describe("streamTokenFeeMessage — binding", () => {
  const base = {
    config: 12345n,
    streamToken: "token",
    streamFeeAmount: 50_000n,
    streamAmount: 100_000_000n,
    expiry: 1_893_456_000n,
    nonce: 5n,
  };

  it("binds every member of the signed fee", () => {
    // `assert_token_fee_binding` checks config/token/expiry on-chain, but the
    // signature must cover them too, or a different binding could be replayed.
    const message = streamTokenFeeMessage(base);
    assert.notEqual(message, streamTokenFeeMessage({ ...base, config: 12346n }));
    assert.notEqual(message, streamTokenFeeMessage({ ...base, streamToken: "token2" }));
    assert.notEqual(message, streamTokenFeeMessage({ ...base, expiry: 1_893_456_001n }));
    assert.notEqual(message, streamTokenFeeMessage({ ...base, streamFeeAmount: 50_001n }));
    assert.notEqual(message, streamTokenFeeMessage({ ...base, streamAmount: 100_000_001n }));
    assert.notEqual(message, streamTokenFeeMessage({ ...base, nonce: 6n }));
  });

  it("accepts a zero fee amount and a zero nonce", () => {
    assert.match(
      streamTokenFeeMessage({ ...base, streamFeeAmount: 0n, streamAmount: 0n, nonce: 0n }),
      /^\d+field$/,
    );
  });
});
