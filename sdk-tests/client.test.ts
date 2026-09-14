import assert from "node:assert";
import { describe, it } from "mocha";

import { StreamService as StreamClient, PROGRAM_ID } from "../sdk/client.js";
import type { AleoWallet, TransactionOptions } from "../sdk/types.js";

const WALLET_ADDRESS = "aleo1ezamst4pjgj9zfxqq0fwfj8a4cjuqndmasgata3hggzqygggnyfq6kmyd4";
const OTHER_ADDRESS = "aleo129nrpl0dxh4evdsan3f4lyhz5pdgp6klrn5atp37ejlavswx5czsk0j5dj";

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

interface MockWallet extends AleoWallet {
  txCalls: TransactionOptions[];
}

type MockRecord = { text: string; spent?: boolean };

/**
 * Mock wallet: record "ciphertexts" are JSON-encoded plaintexts and
 * `executeTransaction` just records its options.
 */
function makeWallet(records: Record<string, MockRecord[]>, txId = "at1mock"): MockWallet {
  const txCalls: TransactionOptions[] = [];
  return {
    address: WALLET_ADDRESS,
    txCalls,
    decrypt: async (cipherText) => JSON.parse(cipherText) as string,
    requestRecords: async (program) =>
      (records[program] ?? []).map((r) => ({
        spent: r.spent ?? false,
        recordCiphertext: JSON.stringify(r.text),
      })),
    executeTransaction: async (options) => {
      txCalls.push(options);
      return { transactionId: txId };
    },
  };
}

function creditRecord(microcredits: bigint): string {
  return `{
    owner: ${WALLET_ADDRESS}.private,
    microcredits: ${microcredits}u64.private,
    _nonce: 111group.public,
    _version: 1u8.public
  }`;
}

function tokenRecord(amount: bigint): string {
  return `{
    owner: ${WALLET_ADDRESS}.private,
    amount: ${amount}u128.private,
    _nonce: 222group.public,
    _version: 1u8.public
  }`;
}

function senderTicket(streamId: bigint): string {
  return `{
    owner: ${WALLET_ADDRESS}.private,
    ticket_type: 0u8.private,
    config: 7field.private,
    stream_id: ${streamId}field.private,
    receiver: ${OTHER_ADDRESS}.private,
    token_program: 'test_token'.private,
    full_amount: 1000000u128.private,
    is_cancelable: true.private,
    is_pausable: false.private,
    can_topup: true.private,
    topup_count: 1u64.private,
    _nonce: 333group.public,
    _version: 1u8.public
  }`;
}

function receiverTicket(streamId: bigint): string {
  return `{
    owner: ${WALLET_ADDRESS}.private,
    ticket_type: 1u8.private,
    config: 7field.private,
    sender: ${OTHER_ADDRESS}.private,
    token_program: 'test_token'.private,
    full_amount: 1000000u128.private,
    auto_withdrawable: true.private,
    stream_id: ${streamId}field.private,
    _nonce: 444group.public,
    _version: 1u8.public
  }`;
}

describe("StreamClient — construction", () => {
  it("exposes the wallet address and default program id", () => {
    const client = new StreamClient(makeWallet({}));
    assert.equal(client.address, WALLET_ADDRESS);
    assert.equal(client.programId, PROGRAM_ID);
  });
});

describe("StreamClient — wallet execution", () => {
  it("executes with the default fee and program", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    const txId = await client.pauseResumeStreamPublic({ streamId: 42n });
    assert.equal(txId, "at1mock");
    const call = wallet.txCalls[0]!;
    assert.equal(call.program, PROGRAM_ID);
    assert.equal(call.function, "pause_resume_stream_public");
    assert.deepEqual(call.inputs, ["42field"]);
    assert.equal(call.fee, 100_000); // default priority fee, in microcredits
  });

  it("passes fee options and imports through to the wallet", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    await client.pauseResumeStreamPublic(
      { streamId: 42n },
      {
        priorityFee: 250_000,
        privateFee: true,
        feeRecord: "{ owner: record... }",
        imports: ["credits.aleo"],
      },
    );
    const call = wallet.txCalls[0]!;
    assert.equal(call.fee, 250_000);
    assert.equal(call.privateFee, true);
    assert.equal(call.feeRecord, "{ owner: record... }");
    assert.deepEqual(call.imports, ["credits.aleo"]);
  });

  it("throws when the wallet returns no transaction id", async () => {
    const client = new StreamClient(makeWallet({}, ""));
    await assert.rejects(
      client.pauseResumeStreamPublic({ streamId: 42n }),
      /did not return a transaction id/,
    );
  });

  it("approveTokenPublic converts human amounts to micro units", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    await client.approveTokenPublic(
      "test_token",
      "aleo1aprgaddress0spender0000000000000000000000000000000000000000",
      "2.5",
      6,
      { imports: ["test_token.aleo"] },
    );
    const call = wallet.txCalls[0]!;
    assert.equal(call.program, "test_token.aleo");
    assert.equal(call.function, "approve_public");
    assert.deepEqual(call.inputs[1], "2500000u128");
  });

  it("initializeConfig converts human fees to microcredits", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    await client.initializeConfig({
      configName: 7n,
      admin: WALLET_ADDRESS,
      feeVault: WALLET_ADDRESS,
      withdrawer: WALLET_ADDRESS,
      baseFee: "0.01",
      platformFee: "0.1",
    });
    const call = wallet.txCalls[0]!;
    assert.equal(call.function, "initialize_config");
    assert.deepEqual(call.inputs, [
      "7field",
      WALLET_ADDRESS,
      WALLET_ADDRESS,
      "10000u64",
      "100000u64",
    ]);
  });

  it("rejects self-streams before touching the network", async () => {
    const client = new StreamClient(makeWallet({}));
    await assert.rejects(
      client.createStreamPublic(
        {
          receiver: WALLET_ADDRESS,
          streamId: 1n,
          amount: "1",
          startTime: 0,
          duration: 60,
          isCancelable: true,
          isPausable: true,
          autoWithdrawable: false,
          withdrawFrequency: 0,
          startNow: true,
          canTopup: false,
          initialBufferAmount: "0",
        },
        "test_token",
        6,
        {
          configName: 7n,
          admin: WALLET_ADDRESS,
          feeVault: WALLET_ADDRESS,
          withdrawer: WALLET_ADDRESS,
          baseFee: "0.01",
          platformFee: "0.1",
        },
        { config: 7n, streamToken: "test_token", streamFeeAmount: "0.1", streamAmount: "100", expiry: 0, nonce: 1n },
        "sign1mock",
      ),
      /cannot create a stream to yourself/,
    );
  });
});

describe("StreamClient — records via wallet", () => {
  it("findCredits picks the highest covering record and skips spent ones", async () => {
    const small = creditRecord(500_000n);
    const mid = creditRecord(5_000_000n);
    const high = creditRecord(10_000_000n);
    const wallet = makeWallet({
      "credits.aleo": [{ text: mid }, { text: high, spent: true }, { text: small }],
    });
    const client = new StreamClient(wallet);
    const found = await client.findCredits(1_000_000n);
    assert.equal(found, norm(mid));
    await assert.rejects(client.findCredits(100_000_000n), /no unspent credits/);
  });

  it("findTokenRecords returns covering records highest-first", async () => {
    const tokenProgramId = "test_token.aleo";
    const low = tokenRecord(2_000_000n);
    const high = tokenRecord(8_000_000n);
    const wallet = makeWallet({
      [tokenProgramId]: [{ text: low }, { text: high }],
    });
    const client = new StreamClient(wallet);
    assert.deepEqual(await client.findTokenRecords(tokenProgramId, 1_000_000n), [
      norm(high),
      norm(low),
    ]);
    assert.equal(await client.findToken(tokenProgramId, 1_000_000n), norm(high));
    await assert.rejects(
      client.findToken(tokenProgramId, 9_000_000n),
      /no unspent token record/,
    );
  });

  it("findToken ignores ticket-like records", async () => {
    const tokenProgramId = "test_token.aleo";
    const wallet = makeWallet({
      [tokenProgramId]: [{ text: senderTicket(111n) }],
    });
    const client = new StreamClient(wallet);
    await assert.rejects(client.findToken(tokenProgramId, 1n), /no unspent token record/);
  });

  it("findTicket matches ticket_type and stream id", async () => {
    const sender = senderTicket(111n);
    const wallet = makeWallet({
      [PROGRAM_ID]: [{ text: receiverTicket(111n) }, { text: sender }, { text: senderTicket(222n) }],
    });
    const client = new StreamClient(wallet);
    assert.equal(await client.findTicket(0, 111n), norm(sender));
    assert.equal(await client.findTicket(1, 111n), norm(receiverTicket(111n)));
    await assert.rejects(
      client.findTicket(2, 111n),
      /no unspent stream ticket found for stream 111/,
    );
  });
});

// ===========================================================================
// Edge cases derived from `src/main.leo`
// ===========================================================================

/**
 * Stub the client's mapping reads. `values` is keyed by mapping name and
 * returns the plaintext the explorer would return; a missing entry becomes the
 * empty string, which is how the client sees an unset mapping key.
 */
function stubMappings(
  client: StreamClient,
  values: Record<string, string | (() => string)>,
): { reads: { mapping: string; key: string }[] } {
  const reads: { mapping: string; key: string }[] = [];
  client.networkClient.getProgramMappingValue = async (_program, mapping, key) => {
    reads.push({ mapping, key: String(key) });
    const value = values[mapping];
    return typeof value === "function" ? value() : (value ?? "");
  };
  return { reads };
}

function anchorValue(overrides: Partial<Record<string, string | number | bigint | boolean>> = {}): string {
  const anchor = {
    stream_id: "111field",
    start_time: "1000i64",
    duration: "100u64",
    paused: "false",
    canceled: "false",
    canceled_at: "0i64",
    deposited_amount: "3000u128",
    last_paused_time: "0i64",
    paused_interval: "0u64",
    withdrawn_amount: "0u128",
    is_public: "false",
    created_timestamp: "1000i64",
    ...overrides,
  };
  return `{ ${Object.entries(anchor).map(([k, v]) => `${k}: ${v}`).join(", ")} }`;
}

function streamValue(overrides: Partial<Record<string, string>> = {}): string {
  const stream = {
    stream_id: "111field",
    config: "7field",
    sender: OTHER_ADDRESS,
    receiver: WALLET_ADDRESS,
    full_amount: "10000u128",
    token_program: "'test_token'",
    is_cancelable: "true",
    is_pausable: "true",
    auto_withdrawable: "false",
    can_topup: "true",
    topup_count: "1u64",
    ...overrides,
  };
  return `{ ${Object.entries(stream).map(([k, v]) => `${k}: ${v}`).join(", ")} }`;
}

describe("StreamClient — receiver validation", () => {
  it("rejects a receiver that is not a valid Aleo address", async () => {
    const client = new StreamClient(makeWallet({}));
    const params = {
      receiver: "aleo1notanaddress",
      streamId: 1n,
      amount: "1",
      startTime: 0,
      duration: 60,
      isCancelable: true,
      isPausable: true,
      autoWithdrawable: false,
      withdrawFrequency: 0,
      startNow: true,
      canTopup: false,
      initialBufferAmount: "0",
    };
    const config = {
      configName: 7n,
      admin: WALLET_ADDRESS,
      feeVault: WALLET_ADDRESS,
      withdrawer: WALLET_ADDRESS,
      baseFee: "0.01",
      platformFee: "0.1",
    };
    const fee = { config: 7n, streamToken: "test_token", streamFeeAmount: "0.1", streamAmount: "100", expiry: 0, nonce: 1n };
    await assert.rejects(
      client.createStreamPublic(params, "test_token", 6, config, fee, "sign1mock"),
      /invalid receiver address/,
    );
  });
});

describe("StreamClient — token program id normalization", () => {
  it("does not double-suffix an id that already ends in .aleo", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    await client.approveTokenPublic("test_token.aleo", OTHER_ADDRESS, "1", 6, {
      imports: ["test_token.aleo"],
    });
    await client.transferTokenPublic("test_token", 6, "1", OTHER_ADDRESS, {
      imports: ["test_token.aleo"],
    });
    assert.equal(wallet.txCalls[0]!.program, "test_token.aleo");
    assert.equal(wallet.txCalls[1]!.program, "test_token.aleo");
  });
});

describe("StreamClient — mapping reads", () => {
  it("retries a stale mapping read before giving up", async function () {
    // Right after a write confirms, the explorer may still serve the pre-write
    // (empty) value; `readMappingValue` retries rather than reporting the
    // stream as missing.
    this.timeout(20_000);
    const client = new StreamClient(makeWallet({}));
    let attempt = 0;
    stubMappings(client, {
      stream_anchors: () => (++attempt < 3 ? "" : anchorValue()),
    });
    const anchor = await client.getStreamAnchor(111n);
    assert.equal(attempt, 3);
    assert.equal(anchor.streamId, "111field");
    assert.equal(anchor.depositedAmount, 3_000n);
  });

  it("reports an unwhitelisted token as false rather than throwing", async () => {
    // Mirrors the on-chain `get_or_use(whitelist_key, false)`.
    const client = new StreamClient(makeWallet({}));
    stubMappings(client, {});
    assert.equal(await client.isTokenWhitelisted(7n, "test_token"), false);

    const throwing = new StreamClient(makeWallet({}));
    stubMappings(throwing, {
      whitelisted_token_programs: () => {
        throw new Error("500");
      },
    });
    assert.equal(await throwing.isTokenWhitelisted(7n, "test_token"), false);
  });

  it("reports an explicit de-whitelisting", async () => {
    const client = new StreamClient(makeWallet({}));
    stubMappings(client, { whitelisted_token_programs: "false" });
    assert.equal(await client.isTokenWhitelisted(7n, "test_token"), false);
    stubMappings(client, { whitelisted_token_programs: "true" });
    assert.equal(await client.isTokenWhitelisted(7n, "test_token"), true);
  });

  it("treats absent registry counts as zero and lists nothing", async () => {
    // Mirrors `get_or_use(count_key, 0u64)` — a config with no public streams.
    const client = new StreamClient(makeWallet({}));
    stubMappings(client, {});
    assert.equal(await client.getOutgoingStreamCount(WALLET_ADDRESS, 7n), 0n);
    assert.equal(await client.getIncomingStreamCount(WALLET_ADDRESS, 7n), 0n);
    assert.deepEqual(await client.listOutgoingStreamIds(WALLET_ADDRESS, 7n), []);
    assert.deepEqual(await client.listPublicStreams(7n), []);
  });

  it("throws when a registry slot below the count is missing", async () => {
    // An append-only registry cannot have holes; a missing slot means the
    // count and the refs disagree.
    const client = new StreamClient(makeWallet({}));
    stubMappings(client, { outgoing_stream_counts: "2u64" });
    await assert.rejects(
      client.listOutgoingStreamIds(WALLET_ADDRESS, 7n),
      /missing outgoing stream ref/,
    );
  });

  it("throws when a stream is registered in both directions", async () => {
    // `create_stream_public` asserts `caller != receiver`, so the same stream
    // id can never be in both registries of one account.
    const client = new StreamClient(makeWallet({}));
    client.networkClient.getProgramMappingValue = async (_program, mapping) => {
      if (mapping.endsWith("_counts")) return "1u64";
      if (mapping.endsWith("_refs")) return "111field";
      return "";
    };
    await assert.rejects(client.listPublicStreams(7n), /both outgoing and incoming/);
  });
});

describe("StreamClient — withdrawable preview", () => {
  it("caps the payout at the funded remainder in buffer mode", async () => {
    // Mirrors `capped_withdrawable_amount` in withdraw_stream_*: 10_000 over
    // 100s is fully vested at t=1100, but only 3_000 was ever deposited.
    const client = new StreamClient(makeWallet({}));
    stubMappings(client, {
      stream_anchors: anchorValue({ is_public: "true" }),
      streams: streamValue(),
    });
    const amounts = await client.getWithdrawableAmounts(111n, 1_100n);
    assert.equal(amounts.totalWithdrawable, 10_000n);
    assert.equal(amounts.currentlyWithdrawable, 3_000n);
  });

  it("subtracts what was already withdrawn from the funded remainder", async () => {
    const client = new StreamClient(makeWallet({}));
    stubMappings(client, {
      stream_anchors: anchorValue({
        is_public: "true",
        deposited_amount: "10000u128",
        withdrawn_amount: "4000u128",
      }),
      streams: streamValue(),
    });
    const amounts = await client.getWithdrawableAmounts(111n, 1_050n);
    assert.equal(amounts.totalWithdrawable, 5_000n);
    assert.equal(amounts.currentlyWithdrawable, 1_000n);
  });

  it("freezes accrual at the pause timestamp", async () => {
    // Mirrors `effective_time = paused ? last_paused_time : now`.
    const client = new StreamClient(makeWallet({}));
    stubMappings(client, {
      stream_anchors: anchorValue({
        is_public: "true",
        deposited_amount: "10000u128",
        paused: "true",
        last_paused_time: "1020i64",
      }),
      streams: streamValue(),
    });
    const amounts = await client.getWithdrawableAmounts(111n, 9_999n);
    assert.equal(amounts.totalWithdrawable, 2_000n);
    assert.equal(amounts.currentlyWithdrawable, 2_000n);
  });

  it("falls back to the deposited amount for a private stream", async () => {
    // Without a ticket the full amount is unknown, so the preview understates
    // accrual beyond the funded buffer rather than overstating it.
    const client = new StreamClient(makeWallet({}));
    stubMappings(client, { stream_anchors: anchorValue() });
    const amounts = await client.getWithdrawableAmounts(111n, 9_999n);
    assert.equal(amounts.totalWithdrawable, 3_000n);
    assert.equal(amounts.currentlyWithdrawable, 3_000n);
  });

  it("uses an explicitly supplied full amount over the fallback", async () => {
    const client = new StreamClient(makeWallet({}));
    stubMappings(client, { stream_anchors: anchorValue() });
    const amounts = await client.getWithdrawableAmounts(111n, 1_050n, 10_000n);
    assert.equal(amounts.totalWithdrawable, 5_000n);
    assert.equal(amounts.currentlyWithdrawable, 3_000n);
  });
});

describe("StreamClient — anchor snapshot inputs", () => {
  it("sends the on-chain anchor and the caller timestamp for a public withdraw", async () => {
    // `withdraw_stream_public` re-checks the snapshot with
    // `assert_stream_anchor_eq` and the timestamp against NOW_TOLERANCE.
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    stubMappings(client, {
      stream_anchors: anchorValue({ is_public: "true" }),
      streams: streamValue(),
    });
    client.networkClient.getProgramImports = async () => ({});
    await client.withdrawStreamPublic({ streamId: 111n, timestamp: 1_050n });
    const inputs = wallet.txCalls[0]!.inputs;
    assert.equal(inputs.length, 3);
    assert.ok(inputs[0]!.includes("stream_id: 111field"));
    assert.ok(inputs[1]!.includes("deposited_amount: 3000u128"));
    assert.equal(inputs[2], "1050i64");
  });

  it("converts the top-up amount to token micro-units", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    stubMappings(client, {
      stream_anchors: anchorValue({ is_public: "true" }),
      streams: streamValue(),
    });
    client.networkClient.getProgramImports = async () => ({});
    await client.topupStreamPublic({
      streamId: 111n,
      amount: "2.5",
      tokenDecimals: 6,
      timestamp: 1_050n,
    });
    assert.equal(wallet.txCalls[0]!.inputs[2], "2500000u128");
  });

  it("defaults the timestamp to now when the caller omits it", async () => {
    const wallet = makeWallet({});
    const client = new StreamClient(wallet);
    stubMappings(client, {
      stream_anchors: anchorValue({ is_public: "true" }),
      streams: streamValue(),
    });
    client.networkClient.getProgramImports = async () => ({});
    const before = BigInt(Math.floor(Date.now() / 1000));
    await client.withdrawStreamPublic({ streamId: 111n });
    const sent = BigInt(wallet.txCalls[0]!.inputs[2]!.replace("i64", ""));
    // Must land inside the on-chain NOW_TOLERANCE window (2 minutes).
    assert.ok(sent >= before - 1n && sent <= before + 120n, `${sent} vs ${before}`);
  });
});

describe("StreamClient — record discovery edge cases", () => {
  it("accepts a record that exactly covers the minimum", async () => {
    const wallet = makeWallet({ "credits.aleo": [{ text: creditRecord(1_000_000n) }] });
    const client = new StreamClient(wallet);
    assert.equal(await client.findCredits(1_000_000n), norm(creditRecord(1_000_000n)));
    await assert.rejects(client.findCredits(1_000_001n), /no unspent credits/);
  });

  it("ignores spent, empty and ciphertext-less record envelopes", async () => {
    const wallet: MockWallet = {
      ...makeWallet({}),
      requestRecords: async () => [
        null,
        { spent: true, recordCiphertext: JSON.stringify(creditRecord(9_000_000n)) },
        { spent: false },
        { spent: false, recordCiphertext: JSON.stringify(creditRecord(2_000_000n)) },
      ],
    };
    const client = new StreamClient(wallet);
    const records = await client.decryptProgramRecords("credits.aleo");
    assert.deepEqual(records, [norm(creditRecord(2_000_000n))]);
  });

  it("does not confuse a receiver ticket with a sender ticket", async () => {
    const client = new StreamClient(
      makeWallet({ [PROGRAM_ID]: [{ text: receiverTicket(111n) }] }),
    );
    await assert.rejects(client.findTicket(0, 111n), /no unspent stream ticket/);
    await assert.rejects(client.findTicket(2, 111n), /no unspent stream ticket/);
  });

  it("matches a stream id given as a suffixed field literal", async () => {
    const client = new StreamClient(
      makeWallet({ [PROGRAM_ID]: [{ text: senderTicket(111n) }] }),
    );
    assert.equal(await client.findTicket(0, "111field"), norm(senderTicket(111n)));
  });

  it("reports an empty private stream list when the wallet holds no tickets", async () => {
    const client = new StreamClient(makeWallet({ [PROGRAM_ID]: [] }));
    assert.deepEqual(await client.listPrivateStreams(), []);
  });

  it("skips withdrawer tickets when listing private streams", async () => {
    // A withdrawer ticket mirrors a stream the wallet does not own either side
    // of; listing it would double-count the stream.
    const withdrawerTicket = `{
      owner: ${WALLET_ADDRESS}.private,
      ticket_type: 2u8.private,
      config: 7field.private,
      full_amount: 1000000u128.private,
      stream_id: 999field.private,
      sender: ${OTHER_ADDRESS}.private,
      receiver: ${OTHER_ADDRESS}.private,
      token_program: 'test_token'.private,
      auto_withdrawable: true.private,
      _nonce: 555group.public,
      _version: 1u8.public
    }`;
    const client = new StreamClient(
      makeWallet({ [PROGRAM_ID]: [{ text: withdrawerTicket }] }),
    );
    assert.deepEqual(await client.listPrivateStreams(), []);
  });
});

describe("StreamClient — balances", () => {
  it("returns 0 for an unset public token balance", async () => {
    const client = new StreamClient(makeWallet({}));
    client.networkClient.getProgramMappingNames = async () => ["balances"];
    stubMappings(client, {});
    assert.equal(await client.getPublicTokenBalance("test_token.aleo", 6), "0");
  });

  it("throws when the token program exposes no balance mapping", async () => {
    const client = new StreamClient(makeWallet({}));
    client.networkClient.getProgramMappingNames = async () => ["token_info"];
    await assert.rejects(
      client.getPublicTokenBalance("test_token.aleo", 6),
      /No public balance mapping found/,
    );
  });

  it("sums every unspent record for the private balance", async () => {
    const client = new StreamClient(
      makeWallet({
        "credits.aleo": [
          { text: creditRecord(1_500_000n) },
          { text: creditRecord(2_500_000n) },
          { text: creditRecord(9_000_000n), spent: true },
        ],
      }),
    );
    assert.equal(await client.getPrivateBalance(), "4");
  });

  it("throws rather than reporting zero when no records are found", async () => {
    const client = new StreamClient(makeWallet({ "credits.aleo": [] }));
    await assert.rejects(client.getPrivateBalance(), /No unspent credits.aleo records/);
  });
});
