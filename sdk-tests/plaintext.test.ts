import { strict as assert } from "node:assert";
import { Plaintext } from "@provablehq/sdk";
import { describe, it } from "mocha";

import {
  classifyTicket,
  configToPlaintext,
  createStreamParamsToPlaintext,
  fieldLiteral,
  i64Literal,
  identLiteral,
  matchesTicketRecord,
  merkleProofToPlaintext,
  merkleProofsToPlaintext,
  parseStream,
  parseStreamConfig,
  parseBoolLiteral,
  parseFieldLiteral,
  parseIdentLiteral,
  parseIntLiteral,
  parseReceiverTicket,
  parseSenderTicket,
  parseStreamAnchor,
  parseStructMembers,
  parseWithdrawerTicket,
  streamToPlaintext,
  streamAnchorToPlaintext,
  streamTokenFeeToPlaintext,
  stripVisibilitySuffix,
  u64Literal,
} from "../sdk/plaintext.js";
import type { RawStream, RawStreamAnchor } from "../sdk/types.js";

const RECEIVER = "aleo1ezamst4pjgj9zfxqq0fwfj8a4cjuqndmasgata3hggzqygggnyfq6kmyd4";
const ADMIN = "aleo129nrpl0dxh4evdsan3f4lyhz5pdgp6klrn5atp37ejlavswx5czsk0j5dj";

describe("fieldLiteral", () => {
  it("normalizes bare digits, suffixed strings, bigints and numbers", () => {
    assert.equal(fieldLiteral("123"), "123field");
    assert.equal(fieldLiteral("123field"), "123field");
    assert.equal(fieldLiteral(123n), "123field");
    assert.equal(fieldLiteral(123), "123field");
  });
});

describe("identLiteral", () => {
  it("wraps valid bare identifiers in single quotes", () => {
    assert.equal(identLiteral("my_token"), "'my_token'");
    assert.equal(identLiteral("x"), "'x'");
  });
  it("rejects invalid identifiers", () => {
    assert.throws(() => identLiteral("1foo"));
    assert.throws(() => identLiteral("a-b"));
    assert.throws(() => identLiteral("my_token.aleo"));
    assert.throws(() => identLiteral("a".repeat(32)));
  });
});

describe("struct serializers", () => {
  it("serializes CreateStreamParams in declaration order and parses as Plaintext", () => {
    const text = createStreamParamsToPlaintext({
      receiver: RECEIVER,
      streamId: 42n,
      amount: 1_000_000n,
      startTime: 1_800_000_000n,
      duration: 3600n,
      isCancelable: true,
      isPausable: false,
      autoWithdrawable: true,
      withdrawFrequency: 60n,
      startNow: true,
      canTopup: false,
      initialBufferAmount: 0n,
    });
    assert.equal(
      text,
      `{ receiver: ${RECEIVER}, stream_id: 42field, amount: 1000000u128, ` +
      `start_time: 1800000000i64, duration: 3600u64, is_cancelable: true, ` +
      `is_pausable: false, auto_withdrawable: true, withdraw_frequency: 60u64, ` +
      `start_now: true, can_topup: false, initial_buffer_amount: 0u128 }`,
    );
    // Must parse with the real snarkVM plaintext parser.
    Plaintext.fromString(text).free();
  });

  it("serializes Config, StreamTokenFee, StreamAnchor and MerkleProofs as parseable Plaintext", () => {
    const config = configToPlaintext({
      configName: "7",
      admin: ADMIN,
      feeVault: ADMIN,
      withdrawer: ADMIN,
      baseFee: 1000n,
      platformFee: 2000n,
    });
    Plaintext.fromString(config).free();

    // StreamTokenFee: fields in Leo struct declaration order.
    const fee = streamTokenFeeToPlaintext({
      config: 12345n,
      streamToken: "token",
      streamFeeAmount: 50_000n,
      streamAmount: 100_000_000n,
      expiry: 1_893_456_000n,
      nonce: 5n,
    });
    assert.equal(
      fee,
      "{ config: 12345field, stream_token: 'token', stream_fee_amount: 50000u128, " +
      "stream_amount: 100000000u128, expiry: 1893456000i64, nonce: 5field }",
    );
    Plaintext.fromString(fee).free();

    const anchor = streamAnchorToPlaintext(sampleAnchor());
    Plaintext.fromString(anchor).free();

    const proof = {
      siblings: Array.from({ length: 16 }, (_, i) => BigInt(i)),
      leafIndex: 3,
    };
    const proofs = merkleProofsToPlaintext([proof, proof]);
    assert.ok(proofs.startsWith("[") && proofs.endsWith("]"));
    assert.ok(merkleProofToPlaintext(proof).includes("leaf_index: 3u32"));
  });

  it("rejects MerkleProofs without exactly 16 siblings", () => {
    assert.throws(() => merkleProofToPlaintext({ siblings: [1n], leafIndex: 0 }));
  });

  it("serializes Stream with member order matching the Leo struct declaration and parses as Plaintext", () => {
    const text = streamToPlaintext(sampleStream());
    assert.equal(
      text,
      `{ stream_id: 42field, config: 7field, sender: ${ADMIN}, receiver: ${RECEIVER}, ` +
      `full_amount: 1000000u128, token_program: 'token', is_cancelable: true, ` +
      `is_pausable: false, auto_withdrawable: true, can_topup: true, ` +
      `topup_count: 1u64 }`,
    );
    Plaintext.fromString(text).free();
  });
});

function sampleStream(): RawStream {
  return {
    streamId: "42field",
    config: "7field",
    sender: ADMIN,
    receiver: RECEIVER,
    fullAmount: 1_000_000n,
    tokenProgram: "token",
    isCancelable: true,
    isPausable: false,
    autoWithdrawable: true,
    canTopup: true,
    topupCount: 1n,
  };
}

function sampleAnchor(): RawStreamAnchor {
  return {
    streamId: "42field",
    startTime: 1_800_000_000n,
    duration: 3600n,
    paused: false,
    canceled: false,
    canceledAt: 0n,
    depositedAmount: 1_000_000n,
    lastPausedTime: 0n,
    pausedInterval: 0n,
    withdrawnAmount: 500_000n,
    isPublic: false,
    createdTimestamp: 1_799_999_000n,
  };
}

describe("parsers", () => {
  it("leaf parsers tolerate visibility suffixes from decrypted records", () => {
    assert.equal(parseIntLiteral("0u8.private"), 0n);
    assert.equal(parseIntLiteral("2000000u128.private"), 2_000_000n);
    assert.equal(parseIntLiteral("-5i64.public"), -5n);
    assert.equal(parseBoolLiteral("true.private"), true);
    assert.equal(parseBoolLiteral("false.public"), false);
    assert.equal(parseIdentLiteral("'test_usdcx_stablecoin'.private"), "test_usdcx_stablecoin");
    assert.equal(parseFieldLiteral("42field.private"), "42field");
    assert.throws(() => parseIntLiteral("abc.private"));
    assert.throws(() => parseBoolLiteral("yes.private"));
  });

  it("round-trips a StreamAnchor through serialize/parse", () => {
    const anchor = sampleAnchor();
    assert.deepEqual(parseStreamAnchor(streamAnchorToPlaintext(anchor)), anchor);
  });

  it("parses multi-line mapping values as returned by the API", () => {
    const value = `{
  admin: ${ADMIN},
  fee_vault: ${RECEIVER},
  withdrawer: ${RECEIVER},
  base_fee: 1000u64,
  platform_fee: 2000u64
}`;
    assert.deepEqual(parseStreamConfig(value), {
      admin: ADMIN,
      feeVault: RECEIVER,
      withdrawer: RECEIVER,
      baseFee: 1000n,
      platformFee: 2000n,
    });
  });

  it("parseStructMembers splits top-level members with nested arrays/structs", () => {
    const members = parseStructMembers(
      "{ a: [1field, 2field], b: { c: 1u8 }, d: true }",
    );
    assert.equal(members.get("a"), "[1field, 2field]");
    assert.equal(members.get("b"), "{ c: 1u8 }");
    assert.equal(members.get("d"), "true");
  });

  it("round-trips a Stream through serialize/parse", () => {
    const stream = sampleStream();
    assert.deepEqual(parseStream(streamToPlaintext(stream)), stream);
  });

  it("parses a Stream mapping value with multi-line formatting", () => {
    const value = `{
      stream_id: 42field,
      config: 7field,
      sender: ${ADMIN},
      receiver: ${RECEIVER},
      full_amount: 1000000u128,
      token_program: 'token',
      is_cancelable: true,
      is_pausable: false,
      auto_withdrawable: true,
      can_topup: true,
      topup_count: 1u64
    }`;
    assert.deepEqual(parseStream(value), sampleStream());
  });
});

describe("ticket parsers", () => {
  const senderTicketPlaintext = `{
    owner: ${RECEIVER},
    ticket_type: 0u8,
    config: 7field,
    stream_id: 42field,
    receiver: ${ADMIN},
    token_program: 'token',
    full_amount: 1000000u128,
    is_cancelable: true,
    is_pausable: false,
    can_topup: true,
    topup_count: 1u64
  }`;

  const receiverTicketPlaintext = `{
    owner: ${RECEIVER},
    ticket_type: 1u8,
    config: 7field,
    sender: ${ADMIN},
    token_program: 'token',
    full_amount: 1000000u128,
    auto_withdrawable: true,
    stream_id: 42field
  }`;

  const withdrawerTicketPlaintext = `{
    owner: ${ADMIN},
    ticket_type: 2u8,
    config: 7field,
    full_amount: 1000000u128,
    stream_id: 42field,
    sender: ${RECEIVER},
    receiver: ${ADMIN},
    token_program: 'token',
    auto_withdrawable: true
  }`;

  it("parses a sender ticket", () => {
    const t = parseSenderTicket(senderTicketPlaintext);
    assert.equal(t.ticketType, 0n);
    assert.equal(t.streamId, "42field");
    assert.equal(t.config, "7field");
    assert.equal(t.tokenProgram, "token");
    assert.equal(t.fullAmount, 1_000_000n);
    assert.equal(t.canTopup, true);
    assert.equal(t.topupCount, 1n);
  });

  it("parses a receiver ticket", () => {
    const t = parseReceiverTicket(receiverTicketPlaintext);
    assert.equal(t.ticketType, 1n);
    assert.equal(t.sender, ADMIN);
    assert.equal(t.autoWithdrawable, true);
    assert.equal(t.streamId, "42field");
  });

  it("parses a withdrawer ticket", () => {
    const t = parseWithdrawerTicket(withdrawerTicketPlaintext);
    assert.equal(t.ticketType, 2n);
    assert.equal(t.config, "7field");
    assert.equal(t.receiver, ADMIN);
    assert.equal(t.autoWithdrawable, true);
  });

  it("rejects the wrong ticket type", () => {
    assert.throws(() => parseSenderTicket(receiverTicketPlaintext));
    assert.throws(() => parseReceiverTicket(withdrawerTicketPlaintext));
    assert.throws(() => parseWithdrawerTicket(senderTicketPlaintext));
  });

  // Wallet-decrypted record plaintexts carry visibility suffixes on every
  // member value plus `_nonce`/`_version` protocol members.
  const decryptedSenderTicket = `{ owner: aleo1pwqc8gu6zu3e8jduu7t05zr70kvhd0ryw5yt4f4f083m3rwa5qysl0rx0d.private, ticket_type: 0u8.private, config: 6175229864096487591670459199122790925183687838110756531581981074812670551244field.private, stream_id: 1775225211523453894208868432285767000626975381302146611094936478568888156684field.private, receiver: aleo1a5kr086g635wkxwk09hmh9a4cvp5xaluhl405d2xd38gq2fq8c8snh57km.private, token_program: 'test_usdcx_stablecoin'.private, full_amount: 2000000u128.private, is_cancelable: true.private, is_pausable: true.private, can_topup: true.private, topup_count: 1u64.private, _nonce: 6292745138386471710808326409511337835748115015294232413164453387930496947857group.public, _version: 1u8.public }`;

  const decryptedReceiverTicket =
    decryptedSenderTicket
      .replace("ticket_type: 0u8.private", "ticket_type: 1u8.private")
      .replace(
        `receiver: aleo1a5kr086g635wkxwk09hmh9a4cvp5xaluhl405d2xd38gq2fq8c8snh57km.private`,
        `sender: ${ADMIN}.private`,
      )
      .replace(/, is_cancelable[^,]+/, "")
      .replace(/, is_pausable[^,]+/, "")
      .replace(/, can_topup[^,]+/, "")
      .replace(/, topup_count[^,]+/, "")
      .replace(/, _nonce:/, ", auto_withdrawable: true.private, _nonce:");

  it("parses a wallet-decrypted sender ticket with visibility suffixes", () => {
    const t = parseSenderTicket(decryptedSenderTicket);
    assert.equal(t.owner, "aleo1pwqc8gu6zu3e8jduu7t05zr70kvhd0ryw5yt4f4f083m3rwa5qysl0rx0d");
    assert.equal(t.ticketType, 0n);
    assert.equal(
      t.config,
      "6175229864096487591670459199122790925183687838110756531581981074812670551244field",
    );
    assert.equal(
      t.streamId,
      "1775225211523453894208868432285767000626975381302146611094936478568888156684field",
    );
    assert.equal(t.receiver, "aleo1a5kr086g635wkxwk09hmh9a4cvp5xaluhl405d2xd38gq2fq8c8snh57km");
    assert.equal(t.tokenProgram, "test_usdcx_stablecoin");
    assert.equal(t.fullAmount, 2_000_000n);
    assert.equal(t.isCancelable, true);
    assert.equal(t.isPausable, true);
    assert.equal(t.canTopup, true);
    assert.equal(t.topupCount, 1n);
  });

  it("parses a wallet-decrypted receiver ticket with visibility suffixes", () => {
    const t = parseReceiverTicket(decryptedReceiverTicket);
    assert.equal(t.ticketType, 1n);
    assert.equal(t.sender, ADMIN);
    assert.equal(t.autoWithdrawable, true);
    assert.equal(t.tokenProgram, "test_usdcx_stablecoin");
    assert.equal(t.fullAmount, 2_000_000n);
  });
});

// ===========================================================================
// Edge cases derived from `src/main.leo`
// ===========================================================================

describe("literal helpers — edge cases", () => {
  it("rejects values the snarkVM field parser will not accept", () => {
    assert.throws(() => fieldLiteral("abc"));
    assert.throws(() => fieldLiteral(""));
    assert.throws(() => fieldLiteral("42fields"));
  });

  it("reduces out-of-range field values modulo the field prime", () => {
    // Stream ids and fee nonces are caller-supplied; anything at or above the
    // prime wraps rather than erroring, so two distinct off-chain ids can map
    // to the same on-chain `stream_id`.
    assert.equal(
      fieldLiteral("-1"),
      "8444461749428370424248824938781546531375899335154063827935233455917409239040field",
    );
    assert.equal(fieldLiteral("9".repeat(80)), fieldLiteral("9".repeat(80)));
  });

  it("accepts identifiers up to the 31-character Leo limit", () => {
    assert.equal(identLiteral("a".repeat(31)), `'${"a".repeat(31)}'`);
    assert.throws(() => identLiteral("a".repeat(32)));
    assert.throws(() => identLiteral(""));
    assert.throws(() => identLiteral("Token")); // uppercase
    assert.throws(() => identLiteral("_token")); // must start with a letter
    assert.throws(() => identLiteral("9token")); // must start with a letter
  });

  it("renders signed and unsigned integer literals", () => {
    assert.equal(u64Literal("42"), "42u64");
    assert.equal(u64Literal(0), "0u64");
    assert.equal(i64Literal(-5), "-5i64");
    // `now` inputs are i64 and legitimately pre-epoch in tests/backfills.
    assert.equal(i64Literal(-1_800_000_000n), "-1800000000i64");
  });
});

describe("struct serializers — edge cases", () => {
  it("serializes an anchor at the u128 / i64 extremes", () => {
    const extreme: RawStreamAnchor = {
      ...sampleAnchor(),
      startTime: -1n,
      canceledAt: -1_800_000_000n,
      duration: (1n << 64n) - 1n,
      depositedAmount: (1n << 128n) - 1n,
      withdrawnAmount: 0n,
      pausedInterval: (1n << 64n) - 1n,
    };
    // `validated()` runs the snarkVM parser, so an out-of-range member throws.
    assert.deepEqual(parseStreamAnchor(streamAnchorToPlaintext(extreme)), extreme);
    assert.throws(() => streamAnchorToPlaintext({ ...extreme, duration: 1n << 64n }));
    assert.throws(() =>
      streamAnchorToPlaintext({ ...extreme, depositedAmount: 1n << 128n }),
    );
  });

  it("round-trips a paused, canceled anchor", () => {
    const anchor: RawStreamAnchor = {
      ...sampleAnchor(),
      paused: true,
      canceled: true,
      canceledAt: 1_800_003_600n,
      lastPausedTime: 1_800_001_800n,
      pausedInterval: 600n,
      isPublic: true,
    };
    assert.deepEqual(parseStreamAnchor(streamAnchorToPlaintext(anchor)), anchor);
  });

  it("rejects merkle proofs with the wrong sibling count", () => {
    const siblings = (n: number) => Array.from({ length: n }, (_, i) => BigInt(i));
    assert.throws(() => merkleProofToPlaintext({ siblings: siblings(15), leafIndex: 0 }));
    assert.throws(() => merkleProofToPlaintext({ siblings: siblings(17), leafIndex: 0 }));
    assert.throws(() => merkleProofToPlaintext({ siblings: [], leafIndex: 0 }));
    assert.ok(
      merkleProofToPlaintext({ siblings: siblings(16), leafIndex: 0 }).includes(
        "leaf_index: 0u32",
      ),
    );
  });

  it("keeps StreamTokenFee member order stable (signature preimage)", () => {
    // Reordering these members changes `BHP256::hash_to_field(token_fee)` and
    // silently invalidates every admin signature.
    const text = streamTokenFeeToPlaintext({
      config: 1n,
      streamToken: "t",
      streamFeeAmount: 0n,
      streamAmount: 0n,
      expiry: 0n,
      nonce: 0n,
    });
    assert.deepEqual(
      [...parseStructMembers(text).keys()],
      ["config", "stream_token", "stream_fee_amount", "stream_amount", "expiry", "nonce"],
    );
  });

  it("keeps CreateStreamParams member order stable", () => {
    const text = createStreamParamsToPlaintext({
      receiver: RECEIVER,
      streamId: 1n,
      amount: 1n,
      startTime: 0n,
      duration: 1n,
      isCancelable: false,
      isPausable: false,
      autoWithdrawable: false,
      withdrawFrequency: 0n,
      startNow: true,
      canTopup: false,
      initialBufferAmount: 0n,
    });
    assert.deepEqual(
      [...parseStructMembers(text).keys()],
      [
        "receiver",
        "stream_id",
        "amount",
        "start_time",
        "duration",
        "is_cancelable",
        "is_pausable",
        "auto_withdrawable",
        "withdraw_frequency",
        "start_now",
        "can_topup",
        "initial_buffer_amount",
      ],
    );
  });

  it("keeps Config member order stable", () => {
    const text = configToPlaintext({
      configName: 1n,
      admin: ADMIN,
      feeVault: ADMIN,
      withdrawer: ADMIN,
      baseFee: 0n,
      platformFee: 0n,
    });
    assert.deepEqual(
      [...parseStructMembers(text).keys()],
      ["config_name", "admin", "fee_vault", "withdrawer", "base_fee", "platform_fee"],
    );
  });
});

describe("parsers — edge cases", () => {
  it("rejects values that are not struct literals", () => {
    assert.throws(() => parseStructMembers("42field"), /not a struct literal/);
    assert.throws(() => parseStructMembers("{ a: 1u8"), /not a struct literal/);
    assert.throws(() => parseStructMembers("{ a 1u8 }"), /malformed struct member/);
  });

  it("handles empty and trailing-comma struct bodies", () => {
    assert.equal(parseStructMembers("{}").size, 0);
    assert.equal(parseStructMembers("{ a: 1u8, }").get("a"), "1u8");
  });

  it("splits members whose values contain commas", () => {
    const members = parseStructMembers(
      "{ proof: { siblings: [1field, 2field], leaf_index: 0u32 }, ok: true }",
    );
    assert.equal(members.size, 2);
    assert.equal(members.get("proof"), "{ siblings: [1field, 2field], leaf_index: 0u32 }");
    assert.equal(members.get("ok"), "true");
  });

  it("reports the first missing member by name", () => {
    assert.throws(
      () => parseStreamAnchor("{ stream_id: 42field }"),
      /missing struct member: start_time/,
    );
    assert.throws(
      () => parseStream("{ stream_id: 42field, config: 7field }"),
      /missing struct member: sender/,
    );
    assert.throws(
      () => parseStreamConfig(`{ admin: ${ADMIN} }`),
      /missing struct member: fee_vault/,
    );
  });

  it("rejects empty mapping values (absent key read as a value)", () => {
    assert.throws(() => parseStream(""), /empty/);
    assert.throws(() => parseStreamAnchor(""), /empty/);
    assert.throws(() => parseStreamConfig(""), /empty/);
    assert.throws(() => parseSenderTicket(""), /empty/);
  });

  it("rejects malformed leaf literals", () => {
    assert.throws(() => parseIntLiteral("5"), /not an integer literal/); // no suffix
    assert.throws(() => parseIntLiteral("5field"), /not an integer literal/);
    assert.throws(() => parseIntLiteral("5u256"), /not an integer literal/);
    assert.throws(() => parseIdentLiteral("my_token"), /not an identifier literal/); // unquoted
    assert.throws(() => parseIdentLiteral("'My_Token'"), /not an identifier literal/);
    assert.throws(() => parseFieldLiteral("nope"));
  });

  it("does not range-check the integer type suffix", () => {
    // The regex accepts a sign on any width, so a forged `-5u64` parses. Values
    // reaching the parsers come from the chain, which cannot produce these.
    assert.equal(parseIntLiteral("-5u64"), -5n);
    assert.equal(parseIntLiteral("999999999999999999999999999999999999999u8"), 999999999999999999999999999999999999999n);
  });

  it("strips one visibility suffix, and only at the end", () => {
    assert.equal(stripVisibilitySuffix("1u64.private"), "1u64");
    assert.equal(stripVisibilitySuffix(" 1u64.public "), "1u64");
    assert.equal(stripVisibilitySuffix("1u64"), "1u64");
    assert.equal(stripVisibilitySuffix("1u64.private.private"), "1u64.private");
    // Not a suffix: token program ids keep their `.aleo`.
    assert.equal(stripVisibilitySuffix("credits.aleo"), "credits.aleo");
  });
});

describe("ticket classification — edge cases", () => {
  const ticket = (type: number) => `{ owner: ${ADMIN}, ticket_type: ${type}u8, stream_id: 1field }`;

  it("classifies each on-chain ticket_type", () => {
    assert.equal(classifyTicket(ticket(0)), "SenderStreamTicket");
    assert.equal(classifyTicket(ticket(1)), "ReceiverStreamTicket");
    assert.equal(classifyTicket(ticket(2)), "WithdrawerStreamTicket");
  });

  it("returns undefined for non-ticket and unknown-type records", () => {
    assert.equal(classifyTicket(`{ owner: ${ADMIN}, amount: 5u128 }`), undefined);
    assert.equal(classifyTicket(ticket(3)), undefined);
    assert.equal(classifyTicket(""), undefined);
  });

  it("matchesTicketRecord only matches its own type", () => {
    assert.equal(matchesTicketRecord(ticket(0), "SenderStreamTicket"), true);
    assert.equal(matchesTicketRecord(ticket(0), "ReceiverStreamTicket"), false);
    assert.equal(matchesTicketRecord(ticket(2), "WithdrawerStreamTicket"), true);
    assert.equal(matchesTicketRecord("{ amount: 5u128 }", "SenderStreamTicket"), false);
  });

  it("rejects a ticket parsed as the wrong type by name", () => {
    assert.throws(
      () => parseWithdrawerTicket(ticket(0)),
      /not a ticket_type 2 record \(got 0u8\)/,
    );
    assert.throws(() => parseSenderTicket("{ owner: x }"), /missing struct member: ticket_type/);
  });
});
