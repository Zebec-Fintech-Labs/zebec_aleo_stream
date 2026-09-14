/**
 * Live testnet integration tests for the stream lifecycle.
 *
 * These run only when `ADMIN_PRIVATE_KEY`, `SENDER_PRIVATE_KEY`, and
 * `RECEIVER_PRIVATE_KEY` are all set to funded testnet private keys (plus
 * `PROVABLE_API_KEY` / `PROVABLE_CONSUMER_ID` for the delegated proving and
 * record scanning services used by `createAleoWallet`). Three accounts are
 * used, mirroring `scripts/stream.ts`:
 *
 * - `ADMIN_PRIVATE_KEY`: initializes a fresh config, signs every
 *   `StreamTokenFee`, and is also set as the config's `withdrawer` (so it
 *   drives the auto-withdraw entries too — one funded key covers both roles).
 * - `SENDER_PRIVATE_KEY`: the employer. Needs unspent private
 *   `test_usdcx_stablecoin.aleo` `Token` records, a public balance of the
 *   same token (public streams pull deposits via `transfer_from_public`),
 *   and a `credits.aleo` record plus a public credits balance (auto-withdraw
 *   fees and priority fees).
 * - `RECEIVER_PRIVATE_KEY`: the employee who withdraws. Needs a small public
 *   credits balance for withdraw priority fees. Must differ from the sender
 *   (the contract asserts `receiver != caller` at stream creation).
 *
 * Exercises `create/pause/resume/withdraw/topup/cancel` and
 * `withdraw_*_auto_*` for both private and public streams, plus the edge
 * cases called out in `src/main.leo`'s asserts: parameter validation,
 * signed-fee binding/replay, pause/cancel/withdraw/topup authorization and
 * lifecycle-state guards (including top-up and withdraw behavior once a
 * stream has ended), auto-withdraw tenant binding, timestamp tolerance, and
 * stale on-chain snapshot detection.
 *
 * Every write waits for confirmation **and then sleeps** before the next
 * read/write — see `confirmWrite` in `admin.test.ts` for why. Rejected
 * writes are asserted via `expectRejected`, which accepts either an
 * on-chain rejection or a local proving failure (many of `main.leo`'s
 * asserts live in the transition body and so fail before broadcast).
 *
 * Environment variables:
 * - ADMIN_PRIVATE_KEY / SENDER_PRIVATE_KEY / RECEIVER_PRIVATE_KEY (required).
 * - ENDPOINT (optional): API host, defaults to the testnet explorer.
 * - ONCHAIN_SETTLE_MS (optional): post-write settle time, defaults to 60s.
 */

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, before } from "mocha";

import dotenv from "dotenv";

import {
  computeStreamFee,
  configNameToField,
  createAleoWallet,
  DEFAULT_ENDPOINT,
  fromMicroUnits,
  i64Literal,
  isWithdrawFrequencyValid,
  nowSeconds,
  signStreamTokenFee,
  streamAnchorToPlaintext,
  streamToPlaintext,
  StreamClient,
  toMicroUnits,
  type Config,
  type CreateStreamParams,
  type RawStream,
  type RawStreamAnchor,
  type RawStreamTokenFee,
  type StreamTokenFee,
} from "../sdk/index.js";

dotenv.config();

const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const SENDER_PRIVATE_KEY = process.env.SENDER_PRIVATE_KEY;
const RECEIVER_PRIVATE_KEY = process.env.RECEIVER_PRIVATE_KEY;
if (!ADMIN_PRIVATE_KEY || !SENDER_PRIVATE_KEY || !RECEIVER_PRIVATE_KEY) {
  console.warn(
    "ADMIN_PRIVATE_KEY / SENDER_PRIVATE_KEY / RECEIVER_PRIVATE_KEY are not all set; skipping stream integration tests.",
  );
}
const HOST = process.env.ENDPOINT ?? DEFAULT_ENDPOINT;

/** See `admin.test.ts`: post-write settle time before the next mapping read. */
const SETTLE_MS = Number(process.env.ONCHAIN_SETTLE_MS ?? 60_000);

/** Per-test budget: several sequential writes, each followed by a settle. */
const TEST_TIMEOUT_MS = 6_000_000;

const TOKEN_PROGRAM = "test_usdcx_stablecoin"; // testnet USDCx token program ID
const TOKEN_DECIMALS = 6;
const TOKEN_PRICE_USD = 1_000_000n; // $1.00 per token, 6 decimals — off-chain fee quote only
const PRIORITY_FEE = 100_000; // 0.1 ALEO, in microcredits

const BASE_FEE = "0.001";
const PLATFORM_FEE = "0.002";

/**
 * Long enough to safely outlive the entire suite (including edge cases that
 * reuse a stream created much earlier), so "still active" streams never
 * accidentally end from real wall-clock time passing during the run.
 */
const LIFECYCLE_DURATION = 2 * 60 * 60; // 2 hours
/**
 * Shorter than the default settle wait, so a stream created with this
 * duration is already "ended" by the time its create-tx settles — no extra
 * sleeping needed for the "stream already ended" edge cases.
 */
const SHORT_DURATION = 20; // seconds
/** Smallest allowed auto-withdraw frequency (`WITHDRAW_FREQUENCIES[0]`). */
const AUTO_WITHDRAW_FREQUENCY = 60; // per minute

// Random per-run config name so reruns don't collide with existing configs.
const CONFIG_NAME = configNameToField(`zebec-itest-stream-${randomBytes(8).toString("hex")}`);

/** Random field value for stream ids / fee nonces (hash of random bytes). */
function randomField(): string {
  return configNameToField(randomBytes(16).toString("hex"));
}

describe("testnet integration: stream lifecycle", function () {
  if (!ADMIN_PRIVATE_KEY || !SENDER_PRIVATE_KEY || !RECEIVER_PRIVATE_KEY) {
    it("is skipped (set ADMIN_PRIVATE_KEY, SENDER_PRIVATE_KEY, RECEIVER_PRIVATE_KEY to run)", function () {
      this.skip();
    });
    return;
  }

  this.timeout(TEST_TIMEOUT_MS);

  // Re-bind as locally-narrowed consts: TS does not carry the outer guard's
  // narrowing into a nested function's default-parameter initializer.
  const adminKey: string = ADMIN_PRIVATE_KEY;
  const senderKey: string = SENDER_PRIVATE_KEY;
  const receiverKey: string = RECEIVER_PRIVATE_KEY;

  let adminClient: StreamClient;
  let senderClient: StreamClient;
  let receiverClient: StreamClient;
  let admin: string;
  let sender: string;
  let receiver: string;
  let programAddress: string;

  // Public streams referenced again from the "edge cases" section below.
  let publicBasicId: string;
  let publicBufferId: string;
  let publicAutoId: string;

  before(async () => {
    const adminWallet = await createAleoWallet(adminKey, { host: HOST });
    const senderWallet = await createAleoWallet(senderKey, { host: HOST });
    const receiverWallet = await createAleoWallet(receiverKey, { host: HOST });
    adminClient = new StreamClient(adminWallet, { host: HOST });
    senderClient = new StreamClient(senderWallet, { host: HOST });
    receiverClient = new StreamClient(receiverWallet, { host: HOST });
    admin = adminWallet.address;
    sender = senderWallet.address;
    receiver = receiverWallet.address;
    assert.notEqual(sender, receiver, "SENDER_PRIVATE_KEY and RECEIVER_PRIVATE_KEY must differ");

    const initTx = await adminClient.initializeConfig({
      configName: CONFIG_NAME,
      admin,
      feeVault: admin,
      withdrawer: admin,
      baseFee: BASE_FEE,
      platformFee: PLATFORM_FEE,
    });
    await confirmWrite(initTx);

    const whitelistTx = await adminClient.setTokenWhitelisted(CONFIG_NAME, TOKEN_PROGRAM, true);
    await confirmWrite(whitelistTx);

    programAddress = await senderClient.programAddress();
    // One large up-front approval covers every `create_stream_public` /
    // `topup_stream_public` call in this file — every amount used here is
    // tiny (a handful of whole tokens).
    const approveTx = await senderClient.approveTokenPublic(
      TOKEN_PROGRAM,
      programAddress,
      "1000",
      TOKEN_DECIMALS,
      { priorityFee: PRIORITY_FEE },
    );
    await confirmWrite(approveTx);
  });

  /**
   * Wait for `txId` to be confirmed, then give the explorer time to index the
   * new mapping state. Every read that follows a write must go through this.
   */
  async function confirmWrite(txId: string) {
    await senderClient.networkClient.waitForTransactionConfirmation(txId, 2_000, 600_000);
    await sleep(SETTLE_MS);
  }

  /**
   * Submit a write that's expected to be rejected, and assert it was.
   * Many of `main.leo`'s asserts live in the transition body, so the wallet
   * throws before ever broadcasting; others are only caught by the on-chain
   * `final` block, so the transaction broadcasts and is rejected in a later
   * block. Both are treated as a valid rejection here.
   */
  async function expectRejected(submit: () => Promise<string>, what: string): Promise<string> {
    let txId: string;
    try {
      txId = await submit();
    } catch (error) {
      return `not broadcast: ${error instanceof Error ? error.message : String(error)}`;
    }
    await assert.rejects(
      senderClient.networkClient.waitForTransactionConfirmation(txId, 2_000, 600_000),
      /rejected by the network/,
      `${what} should have been rejected on-chain (tx ${txId})`,
    );
    await sleep(SETTLE_MS);
    return txId;
  }

  function microAmount(amount: string | number): bigint {
    return BigInt(toMicroUnits(amount, TOKEN_DECIMALS));
  }

  function configInput(): Config {
    return {
      configName: CONFIG_NAME,
      admin,
      feeVault: admin,
      withdrawer: admin,
      baseFee: BASE_FEE,
      platformFee: PLATFORM_FEE,
    };
  }

  function createParams(overrides: Partial<CreateStreamParams> = {}): CreateStreamParams {
    return {
      receiver,
      streamId: randomField(),
      amount: "2",
      startTime: 0,
      duration: LIFECYCLE_DURATION,
      isCancelable: true,
      isPausable: true,
      autoWithdrawable: false,
      withdrawFrequency: 0,
      startNow: true,
      canTopup: false,
      initialBufferAmount: "0",
      ...overrides,
    };
  }

  /**
   * Build and sign a `StreamTokenFee` for `amountMicro` (the stream amount,
   * used only to size the fee off-chain). `signerKey` defaults to the
   * config admin; pass a different key to build a fee with an invalid
   * signature.
   */
  function signedFee(
    amountMicro: bigint,
    overrides: Partial<RawStreamTokenFee> = {},
    signerKey: string = adminKey,
  ): { tokenFee: StreamTokenFee; signature: string } {
    const { streamFee } = computeStreamFee(amountMicro, TOKEN_PRICE_USD);
    const rawFee: RawStreamTokenFee = {
      config: CONFIG_NAME,
      streamToken: TOKEN_PROGRAM,
      streamFeeAmount: streamFee,
      streamAmount: amountMicro,
      expiry: nowSeconds() + 3600n,
      nonce: randomField(),
      ...overrides,
    };
    const tokenFee: StreamTokenFee = {
      config: rawFee.config,
      streamToken: rawFee.streamToken,
      streamFeeAmount: fromMicroUnits(rawFee.streamFeeAmount, TOKEN_DECIMALS),
      streamAmount: fromMicroUnits(rawFee.streamAmount, TOKEN_DECIMALS),
      expiry: rawFee.expiry,
      nonce: rawFee.nonce,
    };
    return { tokenFee, signature: signStreamTokenFee(signerKey, rawFee) };
  }

  /** Submit a raw `cancel_stream_public` call, bypassing the client's fresh-anchor lookup. */
  async function rawCancelPublic(stream: RawStream, anchor: RawStreamAnchor, now: bigint): Promise<string> {
    const { transactionId } = await senderClient.wallet.executeTransaction({
      program: senderClient.programId,
      function: "cancel_stream_public",
      inputs: [streamToPlaintext(stream), streamAnchorToPlaintext(anchor), i64Literal(now)],
      fee: PRIORITY_FEE,
    });
    return transactionId;
  }

  // =========================================================================
  // Private stream lifecycle
  // =========================================================================

  describe("private stream lifecycle", function () {
    this.timeout(TEST_TIMEOUT_MS);
    let streamId: string;

    it("creates a private stream", async () => {
      streamId = randomField();
      const params = createParams({ streamId, amount: "2" });
      const { tokenFee, signature } = signedFee(microAmount(params.amount));
      const txId = await senderClient.createStreamPrivate(
        params,
        TOKEN_PROGRAM,
        TOKEN_DECIMALS,
        configInput(),
        tokenFee,
        signature,
        { priorityFee: PRIORITY_FEE },
      );
      await confirmWrite(txId);
      const anchor = await senderClient.getStreamAnchor(streamId);
      assert.equal(anchor.canceled, false);
      assert.equal(anchor.isPublic, false);
      assert.equal(anchor.depositedAmount, microAmount("2"));
    });

    it("pauses and resumes", async () => {
      const pauseTx = await senderClient.pauseResumeStreamPrivate({ streamId }, { priorityFee: PRIORITY_FEE });
      await confirmWrite(pauseTx);
      let anchor = await senderClient.getStreamAnchor(streamId);
      assert.equal(anchor.paused, true);

      const resumeTx = await senderClient.pauseResumeStreamPrivate({ streamId }, { priorityFee: PRIORITY_FEE });
      await confirmWrite(resumeTx);
      anchor = await senderClient.getStreamAnchor(streamId);
      assert.equal(anchor.paused, false);
      assert.ok(anchor.pausedInterval > 0n);
    });

    it("withdraws a partial amount", async () => {
      const txId = await receiverClient.withdrawStreamPrivate({ streamId }, { priorityFee: PRIORITY_FEE });
      await confirmWrite(txId);
      const anchor = await receiverClient.getStreamAnchor(streamId);
      assert.ok(Number(anchor.withdrawnAmount) > microAmount(0));
      assert.ok(Number(anchor.withdrawnAmount) < microAmount("2"));
    });

    it("cancels the stream", async () => {
      const txId = await senderClient.cancelStreamPrivate({ streamId }, { priorityFee: PRIORITY_FEE });
      await confirmWrite(txId);
      const anchor = await senderClient.getStreamAnchor(streamId);
      assert.equal(anchor.canceled, true);
    });
  });

  describe("private buffer stream (top-up)", function () {
    this.timeout(TEST_TIMEOUT_MS);
    let streamId: string;

    it("creates a buffer-mode private stream", async () => {
      streamId = randomField();
      const params = createParams({ streamId, amount: "2", canTopup: true, initialBufferAmount: "1" });
      const { tokenFee, signature } = signedFee(microAmount(params.amount));
      const txId = await senderClient.createStreamPrivate(
        params,
        TOKEN_PROGRAM,
        TOKEN_DECIMALS,
        configInput(),
        tokenFee,
        signature,
        { priorityFee: PRIORITY_FEE },
      );
      await confirmWrite(txId);
      const anchor = await senderClient.getStreamAnchor(streamId);
      assert.equal(anchor.depositedAmount, microAmount("1"));
    });

    it("tops up the buffer", async () => {
      const txId = await senderClient.topupStreamPrivate(
        { streamId, amount: "0.5", tokenDecimals: TOKEN_DECIMALS },
        { priorityFee: PRIORITY_FEE },
      );
      await confirmWrite(txId);
      const anchor = await senderClient.getStreamAnchor(streamId);
      assert.equal(anchor.depositedAmount, microAmount("1.5"));
    });
  });

  describe("private auto-withdraw", function () {
    this.timeout(TEST_TIMEOUT_MS);
    let streamId: string;

    it("creates an auto-withdrawable private stream", async () => {
      streamId = randomField();
      const params = createParams({
        streamId,
        amount: "2",
        autoWithdrawable: true,
        withdrawFrequency: AUTO_WITHDRAW_FREQUENCY,
      });
      const { tokenFee, signature } = signedFee(microAmount(params.amount));
      const txId = await senderClient.createStreamPrivate(
        params,
        TOKEN_PROGRAM,
        TOKEN_DECIMALS,
        configInput(),
        tokenFee,
        signature,
        { priorityFee: PRIORITY_FEE },
      );
      await confirmWrite(txId);
    });

    it("auto-withdraws via the withdrawer ticket", async () => {
      const txId = await adminClient.withdrawStreamAutoPrivate(
        { streamId },
        configInput(),
        { priorityFee: PRIORITY_FEE },
      );
      await confirmWrite(txId);
      const anchor = await adminClient.getStreamAnchor(streamId);
      assert.ok(Number(anchor.withdrawnAmount) > microAmount(0));
    });
  });

  // =========================================================================
  // Public stream lifecycle
  // =========================================================================

  describe("public stream lifecycle", function () {
    this.timeout(TEST_TIMEOUT_MS);

    it("creates a public stream", async () => {
      publicBasicId = randomField();
      const params = createParams({ streamId: publicBasicId, amount: "2" });
      const { tokenFee, signature } = signedFee(microAmount(params.amount));
      const txId = await senderClient.createStreamPublic(
        params,
        TOKEN_PROGRAM,
        TOKEN_DECIMALS,
        configInput(),
        tokenFee,
        signature,
        { priorityFee: PRIORITY_FEE },
      );
      await confirmWrite(txId);
      const anchor = await senderClient.getStreamAnchor(publicBasicId);
      const stream = await senderClient.getStream(publicBasicId);
      assert.equal(anchor.canceled, false);
      assert.equal(anchor.isPublic, true);
      assert.equal(stream.sender, sender);
      assert.equal(stream.receiver, receiver);
    });

    it("pauses and resumes", async () => {
      const pauseTx = await senderClient.pauseResumeStreamPublic({ streamId: publicBasicId }, { priorityFee: PRIORITY_FEE });
      await confirmWrite(pauseTx);
      let anchor = await senderClient.getStreamAnchor(publicBasicId);
      assert.equal(anchor.paused, true);

      const resumeTx = await senderClient.pauseResumeStreamPublic({ streamId: publicBasicId }, { priorityFee: PRIORITY_FEE });
      await confirmWrite(resumeTx);
      anchor = await senderClient.getStreamAnchor(publicBasicId);
      assert.equal(anchor.paused, false);
      assert.ok(anchor.pausedInterval > 0n);
    });

    it("withdraws a partial amount", async () => {
      const txId = await receiverClient.withdrawStreamPublic({ streamId: publicBasicId }, { priorityFee: PRIORITY_FEE });
      await confirmWrite(txId);
      const anchor = await receiverClient.getStreamAnchor(publicBasicId);
      assert.ok(Number(anchor.withdrawnAmount) > microAmount("0"));
      assert.ok(Number(anchor.withdrawnAmount) < microAmount("2"));
    });

    it("cancels the stream", async () => {
      const txId = await senderClient.cancelStreamPublic({ streamId: publicBasicId }, { priorityFee: PRIORITY_FEE });
      await confirmWrite(txId);
      const anchor = await senderClient.getStreamAnchor(publicBasicId);
      assert.equal(anchor.canceled, true);
    });
  });

  describe("public buffer stream (top-up)", function () {
    this.timeout(TEST_TIMEOUT_MS);

    it("creates a buffer-mode public stream", async () => {
      publicBufferId = randomField();
      const params = createParams({
        streamId: publicBufferId,
        amount: "2",
        canTopup: true,
        initialBufferAmount: "1",
      });
      const { tokenFee, signature } = signedFee(microAmount(params.amount));
      const txId = await senderClient.createStreamPublic(
        params,
        TOKEN_PROGRAM,
        TOKEN_DECIMALS,
        configInput(),
        tokenFee,
        signature,
        { priorityFee: PRIORITY_FEE },
      );
      await confirmWrite(txId);
      const anchor = await senderClient.getStreamAnchor(publicBufferId);
      assert.equal(anchor.depositedAmount, microAmount("1"));
    });

    it("tops up the buffer", async () => {
      const txId = await senderClient.topupStreamPublic(
        { streamId: publicBufferId, amount: "0.5", tokenDecimals: TOKEN_DECIMALS },
        { priorityFee: PRIORITY_FEE },
      );
      await confirmWrite(txId);
      const anchor = await senderClient.getStreamAnchor(publicBufferId);
      assert.equal(anchor.depositedAmount, microAmount("1.5"));
    });
  });

  describe("public auto-withdraw", function () {
    this.timeout(TEST_TIMEOUT_MS);

    it("creates an auto-withdrawable public stream", async () => {
      publicAutoId = randomField();
      const params = createParams({
        streamId: publicAutoId,
        amount: "2",
        autoWithdrawable: true,
        withdrawFrequency: AUTO_WITHDRAW_FREQUENCY,
      });
      const { tokenFee, signature } = signedFee(microAmount(params.amount));
      const txId = await senderClient.createStreamPublic(
        params,
        TOKEN_PROGRAM,
        TOKEN_DECIMALS,
        configInput(),
        tokenFee,
        signature,
        { priorityFee: PRIORITY_FEE },
      );
      await confirmWrite(txId);
    });

    it("auto-withdraws via the withdrawer ticket", async () => {
      const txId = await adminClient.withdrawStreamAutoPublic(
        { streamId: publicAutoId },
        configInput(),
        { priorityFee: PRIORITY_FEE },
      );
      await confirmWrite(txId);
      const anchor = await adminClient.getStreamAnchor(publicAutoId);
      assert.ok(Number(anchor.withdrawnAmount) > 0);
    });
  });

  // =========================================================================
  // Edge cases derived from `src/main.leo`
  //
  // These lean on the public entry points where private/public share the
  // same helper functions (`assert_create_params`, `assert_config_fields`,
  // `assert_token_fee_binding`, `compute_withdrawable_amount`, the top-up
  // debt math, `apply_pause_toggle`) — the private entries are already
  // exercised end-to-end above, and re-testing shared pure logic through the
  // private path would only add compliance-proof fetches and record lookups
  // without covering anything new.
  // =========================================================================

  describe("edge cases", function () {
    this.timeout(TEST_TIMEOUT_MS);

    describe("create — parameter validation", function () {
      it("rejects the sender as their own receiver", async () => {
        const params = createParams({ receiver: sender });
        const { tokenFee, signature } = signedFee(microAmount("2"));
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a stream to oneself",
        );
      });

      it("rejects a zero duration", async () => {
        const params = createParams({ duration: 0 });
        const { tokenFee, signature } = signedFee(microAmount("2"));
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a zero-duration stream",
        );
      });

      it("rejects a zero amount", async () => {
        const params = createParams({ amount: "0" });
        const { tokenFee, signature } = signedFee(microAmount("2"));
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a zero-amount stream",
        );
      });

      it("rejects a buffer stream with no initial buffer amount", async () => {
        const params = createParams({ canTopup: true, initialBufferAmount: "0" });
        const { tokenFee, signature } = signedFee(microAmount("2"));
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a buffer stream with a zero initial amount",
        );
      });

      it("rejects a buffer amount exceeding the full amount", async () => {
        const params = createParams({ canTopup: true, initialBufferAmount: "3", amount: "2" });
        const { tokenFee, signature } = signedFee(microAmount("2"));
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a buffer amount exceeding the full amount",
        );
      });

      it("rejects auto-withdraw with a zero frequency", async () => {
        const params = createParams({ autoWithdrawable: true, withdrawFrequency: 0 });
        const { tokenFee, signature } = signedFee(microAmount("2"));
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "auto-withdraw with a zero frequency",
        );
      });

      it("rejects an invalid withdraw frequency", async () => {
        assert.ok(!isWithdrawFrequencyValid(45n), "45 seconds must not be a valid withdraw frequency");
        const params = createParams({ autoWithdrawable: true, withdrawFrequency: 45 });
        const { tokenFee, signature } = signedFee(microAmount("2"));
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "an unlisted withdraw frequency",
        );
      });

      it("rejects a scheduled start time in the past", async () => {
        // Checked against the on-chain block timestamp inside `final`, so this
        // one broadcasts and is rejected on-chain rather than failing locally.
        const params = createParams({ startNow: false, startTime: Number(nowSeconds()) - 1000 });
        const { tokenFee, signature } = signedFee(microAmount("2"));
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a start time in the past",
        );
      });
    });

    describe("create — finalize validation", function () {
      it("rejects a config with a tampered field", async () => {
        const params = createParams();
        const { tokenFee, signature } = signedFee(microAmount(params.amount));
        const badConfig: Config = { ...configInput(), feeVault: receiver };
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, badConfig, tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a create with a tampered config field",
        );
      });

      it("rejects an expired token fee", async () => {
        const params = createParams();
        const { tokenFee, signature } = signedFee(microAmount(params.amount), { expiry: nowSeconds() - 10n });
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "an expired token fee",
        );
      });

      it("rejects a token fee signed for a different config", async () => {
        const params = createParams();
        const { tokenFee, signature } = signedFee(microAmount(params.amount), { config: randomField() });
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a token fee bound to a different config",
        );
      });

      it("rejects a token fee for a different token program", async () => {
        const params = createParams();
        const { tokenFee, signature } = signedFee(microAmount(params.amount), { streamToken: "test_usad_stablecoin" });
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a token fee bound to a different token program",
        );
      });

      it("rejects a token fee for a different stream amount", async () => {
        // The admin-signed `stream_amount` must equal `params.amount`; a
        // smaller-stream fee must not be reusable for a larger stream.
        const params = createParams();
        const { tokenFee, signature } = signedFee(microAmount(params.amount), {
          streamAmount: microAmount(params.amount) + 1n,
        });
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a token fee for a different stream amount",
        );
      });

      it("rejects a fee signature from a non-admin key", async () => {
        const params = createParams();
        const { tokenFee, signature } = signedFee(microAmount(params.amount), {}, senderKey);
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a fee signed by a non-admin key",
        );
      });

      it("rejects a replayed fee nonce", async () => {
        const shared = signedFee(microAmount("2"));
        const firstParams = createParams();
        const txId = await senderClient.createStreamPublic(
          firstParams,
          TOKEN_PROGRAM,
          TOKEN_DECIMALS,
          configInput(),
          shared.tokenFee,
          shared.signature,
          { priorityFee: PRIORITY_FEE },
        );
        await confirmWrite(txId);

        const secondParams = createParams();
        await expectRejected(
          () =>
            senderClient.createStreamPublic(
              secondParams,
              TOKEN_PROGRAM,
              TOKEN_DECIMALS,
              configInput(),
              shared.tokenFee,
              shared.signature,
              { priorityFee: PRIORITY_FEE },
            ),
          "a replayed fee nonce",
        );
      });

      it("rejects a duplicate stream id", async () => {
        const params = createParams({ streamId: publicBasicId });
        const { tokenFee, signature } = signedFee(microAmount(params.amount));
        await expectRejected(
          () =>
            senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
              priorityFee: PRIORITY_FEE,
            }),
          "a duplicate stream id",
        );
      });

      it("rejects creating against a de-whitelisted token", async () => {
        const offTx = await adminClient.setTokenWhitelisted(CONFIG_NAME, TOKEN_PROGRAM, false);
        await confirmWrite(offTx);
        try {
          const params = createParams();
          const { tokenFee, signature } = signedFee(microAmount(params.amount));
          await expectRejected(
            () =>
              senderClient.createStreamPublic(params, TOKEN_PROGRAM, TOKEN_DECIMALS, configInput(), tokenFee, signature, {
                priorityFee: PRIORITY_FEE,
              }),
            "a create against a de-whitelisted token",
          );
        } finally {
          const onTx = await adminClient.setTokenWhitelisted(CONFIG_NAME, TOKEN_PROGRAM, true);
          await confirmWrite(onTx);
        }
        assert.equal(await senderClient.isTokenWhitelisted(CONFIG_NAME, TOKEN_PROGRAM), true);
      });
    });

    describe("pause and cancel authorization / lifecycle guards", function () {
      let restrictedId: string;
      let futureStartId: string;

      it("creates a non-pausable, non-cancelable stream", async () => {
        restrictedId = randomField();
        const params = createParams({ streamId: restrictedId, isCancelable: false, isPausable: false });
        const { tokenFee, signature } = signedFee(microAmount(params.amount));
        const txId = await senderClient.createStreamPublic(
          params,
          TOKEN_PROGRAM,
          TOKEN_DECIMALS,
          configInput(),
          tokenFee,
          signature,
          { priorityFee: PRIORITY_FEE },
        );
        await confirmWrite(txId);
      });

      it("rejects pause from a non-sender caller", async () => {
        await expectRejected(
          () => receiverClient.pauseResumeStreamPublic({ streamId: restrictedId }, { priorityFee: PRIORITY_FEE }),
          "a pause from a non-sender caller",
        );
      });

      it("rejects pausing a non-pausable stream", async () => {
        await expectRejected(
          () => senderClient.pauseResumeStreamPublic({ streamId: restrictedId }, { priorityFee: PRIORITY_FEE }),
          "pausing a non-pausable stream",
        );
      });

      it("rejects cancel from a non-sender caller", async () => {
        await expectRejected(
          () => receiverClient.cancelStreamPublic({ streamId: restrictedId }, { priorityFee: PRIORITY_FEE }),
          "a cancel from a non-sender caller",
        );
      });

      it("rejects canceling a non-cancelable stream", async () => {
        await expectRejected(
          () => senderClient.cancelStreamPublic({ streamId: restrictedId }, { priorityFee: PRIORITY_FEE }),
          "canceling a non-cancelable stream",
        );
      });

      it("rejects canceling an already-canceled stream", async () => {
        // `publicBasicId` was already canceled at the end of "public stream lifecycle".
        await expectRejected(
          () => senderClient.cancelStreamPublic({ streamId: publicBasicId }, { priorityFee: PRIORITY_FEE }),
          "canceling an already-canceled stream",
        );
      });

      it("creates a stream that hasn't started yet", async () => {
        futureStartId = randomField();
        const params = createParams({
          streamId: futureStartId,
          startNow: false,
          startTime: nowSeconds() + 300n,
        });
        const { tokenFee, signature } = signedFee(microAmount(params.amount));
        const txId = await senderClient.createStreamPublic(
          params,
          TOKEN_PROGRAM,
          TOKEN_DECIMALS,
          configInput(),
          tokenFee,
          signature,
          { priorityFee: PRIORITY_FEE },
        );
        await confirmWrite(txId);
      });

      it("rejects pausing before the start time", async () => {
        await expectRejected(
          () => senderClient.pauseResumeStreamPublic({ streamId: futureStartId }, { priorityFee: PRIORITY_FEE }),
          "pausing before the start time",
        );
      });

      it("rejects withdrawing before the start time", async () => {
        await expectRejected(
          () => receiverClient.withdrawStreamPublic({ streamId: futureStartId }, { priorityFee: PRIORITY_FEE }),
          "withdrawing before the start time",
        );
      });
    });

    describe("stale on-chain snapshots", function () {
      it("rejects a tampered stream snapshot", async () => {
        const stream = await senderClient.getStream(publicBufferId);
        const anchor = await senderClient.getStreamAnchor(publicBufferId);
        const tamperedStream: RawStream = { ...stream, fullAmount: stream.fullAmount + 1n };
        await expectRejected(
          () => rawCancelPublic(tamperedStream, anchor, nowSeconds()),
          "a cancel with a tampered stream snapshot",
        );
      });

      it("rejects a tampered anchor snapshot", async () => {
        const stream = await senderClient.getStream(publicBufferId);
        const anchor = await senderClient.getStreamAnchor(publicBufferId);
        const tamperedAnchor: RawStreamAnchor = { ...anchor, depositedAmount: anchor.depositedAmount + 1n };
        await expectRejected(
          () => rawCancelPublic(stream, tamperedAnchor, nowSeconds()),
          "a cancel with a tampered anchor snapshot",
        );
      });
    });

    describe("top-up and withdraw once a stream has ended", function () {
      let fundedLateId: string;
      let underfundedId: string;

      it("creates a short-lived buffer stream and lets it end", async () => {
        fundedLateId = randomField();
        const params = createParams({
          streamId: fundedLateId,
          amount: "2",
          canTopup: true,
          initialBufferAmount: "1",
          duration: SHORT_DURATION,
        });
        const { tokenFee, signature } = signedFee(microAmount(params.amount));
        const txId = await senderClient.createStreamPublic(
          params,
          TOKEN_PROGRAM,
          TOKEN_DECIMALS,
          configInput(),
          tokenFee,
          signature,
          { priorityFee: PRIORITY_FEE },
        );
        // The default settle wait (60s) already exceeds SHORT_DURATION (20s),
        // so the stream is "ended" by the time this resolves.
        await confirmWrite(txId);
      });

      it("allows a top-up after the end to cover the remaining debt", async () => {
        const txId = await senderClient.topupStreamPublic(
          { streamId: fundedLateId, amount: "0", tokenDecimals: TOKEN_DECIMALS },
          { priorityFee: PRIORITY_FEE },
        );
        await confirmWrite(txId);
        const anchor = await senderClient.getStreamAnchor(fundedLateId);
        assert.equal(anchor.depositedAmount, microAmount("2"));
      });

      it("rejects a further top-up once fully funded", async () => {
        await expectRejected(
          () =>
            senderClient.topupStreamPublic(
              { streamId: fundedLateId, amount: "0", tokenDecimals: TOKEN_DECIMALS },
              { priorityFee: PRIORITY_FEE },
            ),
          "a top-up once fully funded",
        );
      });

      it("allows a withdraw after the end to drain the full deposited amount", async () => {
        const txId = await receiverClient.withdrawStreamPublic({ streamId: fundedLateId }, { priorityFee: PRIORITY_FEE });
        await confirmWrite(txId);
        const anchor = await receiverClient.getStreamAnchor(fundedLateId);
        assert.equal(anchor.withdrawnAmount, microAmount("2"));
      });

      it("rejects a further withdraw once fully withdrawn", async () => {
        await expectRejected(
          () => receiverClient.withdrawStreamPublic({ streamId: fundedLateId }, { priorityFee: PRIORITY_FEE }),
          "withdrawing once fully withdrawn",
        );
      });

      it("creates a short-lived under-funded buffer stream and lets it end", async () => {
        underfundedId = randomField();
        const params = createParams({
          streamId: underfundedId,
          amount: "2",
          canTopup: true,
          initialBufferAmount: "1",
          duration: SHORT_DURATION,
        });
        const { tokenFee, signature } = signedFee(microAmount(params.amount));
        const txId = await senderClient.createStreamPublic(
          params,
          TOKEN_PROGRAM,
          TOKEN_DECIMALS,
          configInput(),
          tokenFee,
          signature,
          { priorityFee: PRIORITY_FEE },
        );
        await confirmWrite(txId);
      });

      it("rejects pausing an ended stream", async () => {
        await expectRejected(
          () => senderClient.pauseResumeStreamPublic({ streamId: underfundedId }, { priorityFee: PRIORITY_FEE }),
          "pausing an ended stream",
        );
      });

      it("allows a partial withdraw capped at the funded (under-full) amount", async () => {
        const txId = await receiverClient.withdrawStreamPublic({ streamId: underfundedId }, { priorityFee: PRIORITY_FEE });
        await confirmWrite(txId);
        const anchor = await receiverClient.getStreamAnchor(underfundedId);
        assert.equal(anchor.withdrawnAmount, microAmount("1"));
        assert.equal(anchor.depositedAmount, microAmount("1"));
      });

      it("rejects a further withdraw once the funded buffer is exhausted", async () => {
        await expectRejected(
          () => receiverClient.withdrawStreamPublic({ streamId: underfundedId }, { priorityFee: PRIORITY_FEE }),
          "withdrawing once the buffer is exhausted",
        );
      });

      it("rejects canceling an ended stream", async () => {
        await expectRejected(
          () => senderClient.cancelStreamPublic({ streamId: underfundedId }, { priorityFee: PRIORITY_FEE }),
          "canceling an ended stream",
        );
      });
    });

    describe("auto-withdraw authorization", function () {
      it("rejects a caller who isn't the config withdrawer", async () => {
        await expectRejected(
          () =>
            senderClient.withdrawStreamAutoPublic({ streamId: publicAutoId }, configInput(), {
              priorityFee: PRIORITY_FEE,
            }),
          "an auto-withdraw from a non-withdrawer caller",
        );
      });

      it("rejects auto-withdraw on a stream that didn't opt in", async () => {
        // `publicBasicId` was created with `autoWithdrawable: false`.
        await expectRejected(
          () =>
            adminClient.withdrawStreamAutoPublic({ streamId: publicBasicId }, configInput(), {
              priorityFee: PRIORITY_FEE,
            }),
          "an auto-withdraw on a stream that opted out",
        );
      });

      it("rejects auto-withdraw under a foreign config", async () => {
        const foreignConfig: Config = { ...configInput(), configName: randomField() };
        await expectRejected(
          () =>
            adminClient.withdrawStreamAutoPublic({ streamId: publicAutoId }, foreignConfig, {
              priorityFee: PRIORITY_FEE,
            }),
          "an auto-withdraw under a foreign config",
        );
      });
    });

    describe("timestamp tolerance", function () {
      it("rejects a `now` far in the future", async () => {
        await expectRejected(
          () =>
            receiverClient.withdrawStreamPublic(
              { streamId: publicBasicId, timestamp: nowSeconds() + 10_000n },
              { priorityFee: PRIORITY_FEE },
            ),
          "a future-dated `now`",
        );
      });

      it("rejects a `now` far in the past", async () => {
        // Either the tolerance check or (rarely, for a very recently-created
        // stream) the start-time guard rejects this — both correctly refuse
        // to let a caller backdate accrual.
        await expectRejected(
          () =>
            receiverClient.withdrawStreamPublic(
              { streamId: publicBasicId, timestamp: nowSeconds() - 360n },
              { priorityFee: PRIORITY_FEE },
            ),
          "a past-dated `now`",
        );
      });
    });

    describe("views and registries", function () {
      it("reports an unknown stream and anchor as missing", async () => {
        const unknown = randomField();
        await assert.rejects(senderClient.getStream(unknown), /not found/);
        await assert.rejects(senderClient.getStreamAnchor(unknown), /not found/);
      });

      it("tracks public streams in the sender/receiver registries", async () => {
        const outgoingCount = await senderClient.getOutgoingStreamCount(sender, CONFIG_NAME);
        const incomingCount = await receiverClient.getIncomingStreamCount(receiver, CONFIG_NAME);
        assert.ok(outgoingCount >= 1n);
        assert.ok(incomingCount >= 1n);

        const outgoingIds = await senderClient.listOutgoingStreamIds(sender, CONFIG_NAME);
        const incomingIds = await receiverClient.listIncomingStreamIds(receiver, CONFIG_NAME);
        assert.ok(outgoingIds.includes(publicBasicId));
        assert.ok(incomingIds.includes(publicBasicId));

        const entries = await senderClient.listPublicStreams(CONFIG_NAME);
        const entry = entries.find((e) => e.streamId === publicBasicId);
        assert.ok(entry, "publicBasicId should appear in listPublicStreams");
        assert.equal(entry?.direction, "outgoing");
      });
    });
  });
});
