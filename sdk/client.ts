/**
 * `StreamService` — high-level interface to the Zebec stream program
 * (`test_zebec_stream_v4.aleo`): stream lifecycle, admin configuration,
 * mapping reads, and record discovery.
 *
 * The service is **wallet-only**: every transaction goes through
 * `wallet.executeTransaction` and every record comes from
 * `wallet.requestRecords` + `wallet.decrypt` (see `AleoWallet` in
 * `sdk/types.ts`). In the browser, pass the Shield/Leo wallet adaptor's
 * `useWallet()` context; in Node, build a wallet from a private key with
 * `createAleoWallet` (see `sdk/wallet.ts`).
 *
 * Amounts cross the API boundary in human units (decimal strings/numbers in
 * whole tokens) and are converted to on-chain micro-units internally; reads
 * that hydrate entries convert back with the token's on-chain decimals.
 */

import {
  Address,
  AleoNetworkClient,
  SealanceMerkleTree,
} from "@provablehq/sdk/testnet.js";

import {
  CREDITS_PROGRAM_ID,
  DEFAULT_ALEO_ENDPOINT,
  STABLE_COINS_CONFIGS,
  ZEBEC_STREAM_PROGRAM_ID,
} from "./config.js";
import { streamCountKey, streamRefKey, whitelistKey } from "./hashing.js";
import {
  computeAutoWithdrawalFee,
  computeWithdrawableAmount,
  nowSeconds,
} from "./math.js";
import {
  classifyTicket,
  configToPlaintext,
  createStreamParamsToPlaintext,
  fieldLiteral,
  i64Literal,
  identLiteral,
  parseBoolLiteral,
  parseFieldLiteral,
  parseIntLiteral,
  parseReceiverTicket,
  parseSenderTicket,
  parseStream,
  parseStreamAnchor,
  parseStreamConfig,
  parseWithdrawerTicket,
  streamAnchorToPlaintext,
  streamTokenFeeToPlaintext,
  streamToPlaintext,
  u64Literal,
} from "./plaintext.js";
import { recordAmount } from "./records.js";
import type {
  AleoWallet,
  Config,
  CreateStreamParams,
  ExecuteOptions,
  PrivateStreamEntry,
  PrivateStreamOperationOptions,
  PrivateTopupStreamOptions,
  PublicStreamEntry,
  RawConfig,
  RawCreateStreamParams,
  RawReceiverTicket,
  RawSenderTicket,
  RawStream,
  RawStreamAnchor,
  RawStreamTokenFee,
  ReceiverTicket,
  SenderTicket,
  Stream,
  StreamAnchor,
  StreamParams,
  StreamServiceOptions,
  StreamTokenFee,
  TopupStreamParams,
  TransactionOptions,
} from "./types.js";
import {
  fromMicroUnits,
  getDecimalsByTokenProgram,
  toMicroUnits,
} from "./utils.js";
import type { WithdrawableAmounts } from "./math.js";

export const DEFAULT_ENDPOINT = DEFAULT_ALEO_ENDPOINT;
export const PROGRAM_ID = ZEBEC_STREAM_PROGRAM_ID;

/** Default priority fee: 0.1 ALEO in microcredits. */
const DEFAULT_PRIORITY_FEE = 100_000;

export class StreamService {
  readonly wallet: AleoWallet;
  readonly programId: string;
  readonly host: string;
  readonly networkClient: AleoNetworkClient;

  constructor(wallet: AleoWallet, options: StreamServiceOptions = {}) {
    this.host = options.host ?? DEFAULT_ALEO_ENDPOINT;
    const programId = options.programId ?? ZEBEC_STREAM_PROGRAM_ID;
    this.programId = programId;
    this.wallet = wallet;
    this.networkClient = new AleoNetworkClient(this.host);
  }

  /** Aleo address of the connected wallet. */
  get address(): string {
    return this.wallet.address;
  }

  // =======================================================================
  // Internals: execution
  // =======================================================================

  /**
   * Validate a stream receiver: it must be a well-formed Aleo address, and
   * it must not be the wallet creating the stream (no self-streams — these
   * would surface as a "both" direction registry entry and break accounting
   * invariants).
   */
  private assertValidReceiver(receiver: string) {
    if (!Address.isValid(receiver)) {
      throw new Error(`invalid receiver address: ${receiver}`);
    }
    if (receiver === this.wallet.address) {
      throw new Error("cannot create a stream to yourself");
    }
  }

  /** Submit a stream-program transition, applying the common fee options. */
  private async execute(
    functionName: string,
    inputs: string[],
    options: ExecuteOptions = {},
  ): Promise<string> {
    return this.executeOnProgram(this.programId, functionName, inputs, options);
  }

  /** Submit a transition on any program (e.g. the IARC22 token program). */
  private async executeOnProgram(
    program: string,
    functionName: string,
    inputs: string[],
    options: ExecuteOptions = {},
  ): Promise<string> {
    const txOptions: TransactionOptions = {
      function: functionName,
      inputs,
      program,
      fee: options.priorityFee ?? DEFAULT_PRIORITY_FEE,
    };
    if (options.privateFee) txOptions.privateFee = true;
    if (options.feeRecord) txOptions.feeRecord = options.feeRecord;
    if (options.imports) {
      txOptions.imports = options.imports;
    } else if (program !== this.programId) {
      txOptions.imports = Object.keys(
        await this.networkClient.getProgramImports(program),
      );
    }
    const { transactionId } = await this.wallet.executeTransaction(txOptions);
    if (!transactionId) {
      throw new Error("wallet did not return a transaction id (rejected?)");
    }
    return transactionId;
  }

  private tokenProgramId(tokenProgram: string): string {
    const trimmed = tokenProgram.trim();
    return trimmed.endsWith(".aleo") ? trimmed : `${trimmed}.aleo`;
  }

  private async resolveTokenDispatchImports(tokenProgram: string): Promise<string[]> {
    const tokenProgramId = this.tokenProgramId(tokenProgram);
    const nested = await this.networkClient.getProgramImports(tokenProgramId);
    return [...new Set([tokenProgramId, ...Object.keys(nested)])];
  }

  private async withTokenImports(
    tokenProgram: string,
    options: ExecuteOptions,
  ): Promise<ExecuteOptions> {
    if (options.imports) return options;
    return {
      ...options,
      imports: await this.resolveTokenDispatchImports(tokenProgram),
    };
  }

  /** Aleo address of the stream program, used as the IARC22 spender. */
  async programAddress(): Promise<string> {
    const program = await this.networkClient.getProgramObject(this.programId);
    try {
      return program.address().to_string();
    } finally {
      program.free();
    }
  }

  // =======================================================================
  // Internals: human → raw conversions
  // =======================================================================

  private parseConfig(config: Config): RawConfig {
    return {
      configName: config.configName,
      admin: config.admin,
      feeVault: config.feeVault,
      withdrawer: config.withdrawer,
      baseFee: BigInt(toMicroUnits(config.baseFee)),
      platformFee: BigInt(toMicroUnits(config.platformFee)),
    };
  }

  private parseCreateParams(
    params: CreateStreamParams,
    tokenDecimals: number,
  ): RawCreateStreamParams {
    return {
      receiver: params.receiver,
      streamId: params.streamId,
      amount: BigInt(toMicroUnits(params.amount, tokenDecimals)),
      startTime: BigInt(params.startTime),
      duration: BigInt(params.duration),
      isCancelable: params.isCancelable,
      isPausable: params.isPausable,
      autoWithdrawable: params.autoWithdrawable,
      withdrawFrequency: BigInt(params.withdrawFrequency),
      startNow: params.startNow,
      canTopup: params.canTopup,
      initialBufferAmount: BigInt(toMicroUnits(params.initialBufferAmount, tokenDecimals)),
    };
  }

  private parseTokenFee(
    tokenFee: StreamTokenFee,
    tokenDecimals: number,
  ): RawStreamTokenFee {
    return {
      config: tokenFee.config,
      streamToken: tokenFee.streamToken,
      streamFeeAmount: BigInt(toMicroUnits(tokenFee.streamFeeAmount, tokenDecimals)),
      streamAmount: BigInt(toMicroUnits(tokenFee.streamAmount, tokenDecimals)),
      expiry: BigInt(tokenFee.expiry),
      nonce: tokenFee.nonce,
    };
  }

  private tokenStablecoinKey(tokenProgram: string): "usad" | "usdcx" {
    if (tokenProgram.includes("usad")) return "usad";
    if (tokenProgram.includes("usdcx")) return "usdcx";
    throw new Error(
      `compliance proofs are only available for usad/usdcx: ${tokenProgram}`,
    );
  }

  // =======================================================================
  // User: stream lifecycle
  // =======================================================================

  /**
   * Execute `create_stream_private`. The credit record only covers the
   * auto-withdrawal fee (paid in ALEO); the token record must cover the
   * token-denominated stream fee plus the deposit. Records and compliance
   * proofs are located automatically when omitted.
   */
  async createStreamPrivate(
    params: CreateStreamParams,
    tokenProgram: string,
    tokenDecimals: number,
    config: Config,
    tokenFee: StreamTokenFee,
    feeSignature: string,
    options: ExecuteOptions & {
      creditRecord?: string | { toString(): string };
      tokenRecord?: string | { toString(): string };
    } = {},
  ): Promise<string> {
    this.assertValidReceiver(params.receiver);
    const tokenProgramId = this.tokenProgramId(tokenProgram);

    const parsedParams = this.parseCreateParams(params, tokenDecimals);
    const parsedTokenFee = this.parseTokenFee(tokenFee, tokenDecimals);
    const parsedConfig = this.parseConfig(config);

    const depositAmount = parsedParams.canTopup
      ? parsedParams.initialBufferAmount
      : parsedParams.amount;

    // Exact mirror of the on-chain fee math (multiply before divide); a
    // lower estimate would make the credit-record coverage assert fail.
    const autoWithdrawalFee = params.autoWithdrawable
      ? computeAutoWithdrawalFee(
        parsedParams.duration,
        parsedParams.withdrawFrequency,
        parsedConfig.baseFee,
        parsedConfig.platformFee,
      )
      : 0n;
    const creditRecord =
      options.creditRecord !== undefined
        ? options.creditRecord.toString()
        : await this.findCredits(autoWithdrawalFee);
    const tokenRecord =
      options.tokenRecord !== undefined
        ? options.tokenRecord.toString()
        : await this.findToken(
          tokenProgramId,
          depositAmount + parsedTokenFee.streamFeeAmount,
        );
    const merkleProofs = await this.getComplianceProofs(
      this.tokenStablecoinKey(tokenProgram),
      this.wallet.address,
    );

    return this.execute(
      "create_stream_private",
      [
        createStreamParamsToPlaintext(parsedParams),
        identLiteral(tokenProgram),
        configToPlaintext(parsedConfig),
        streamTokenFeeToPlaintext(parsedTokenFee),
        feeSignature,
        creditRecord,
        tokenRecord,
        merkleProofs,
      ],
      await this.withTokenImports(tokenProgram, options),
    );
  }

  /**
   * Execute `create_stream_public`, funded from the sender's public token
   * balance. The sender must first approve this stream program for
   * `streamFeeAmount + deposit` (the stream fee is pulled in the stream token
   * via `transfer_from_public`, and the auto-withdrawal fee is still paid in
   * public credits).
   */
  async createStreamPublic(
    params: CreateStreamParams,
    tokenProgram: string,
    tokenDecimals: number,
    config: Config,
    tokenFee: StreamTokenFee,
    feeSignature: string,
    options: ExecuteOptions = {},
  ): Promise<string> {
    this.assertValidReceiver(params.receiver);
    return this.execute(
      "create_stream_public",
      [
        createStreamParamsToPlaintext(this.parseCreateParams(params, tokenDecimals)),
        identLiteral(tokenProgram),
        configToPlaintext(this.parseConfig(config)),
        streamTokenFeeToPlaintext(this.parseTokenFee(tokenFee, tokenDecimals)),
        feeSignature,
      ],
      await this.withTokenImports(tokenProgram, options),
    );
  }

  /** Execute `pause_resume_stream_private` (toggles pause/resume). */
  async pauseResumeStreamPrivate(
    params: StreamParams,
    options: PrivateStreamOperationOptions = {},
  ): Promise<string> {
    const senderTicket = options.ticket ?? (await this.findTicket(0, params.streamId));
    const tokenProgram = parseSenderTicket(senderTicket).tokenProgram;
    return this.execute(
      "pause_resume_stream_private",
      [senderTicket],
      await this.withTokenImports(tokenProgram, options),
    );
  }

  /** Execute `pause_resume_stream_public` (toggles pause/resume). */
  async pauseResumeStreamPublic(
    params: StreamParams,
    options: ExecuteOptions = {},
  ): Promise<string> {
    return this.execute(
      "pause_resume_stream_public",
      [fieldLiteral(params.streamId)],
      options,
    );
  }

  /** Execute `cancel_stream_private` (sender ticket is burned). */
  async cancelStreamPrivate(
    params: StreamParams,
    options: PrivateStreamOperationOptions = {},
  ): Promise<string> {
    const senderTicket = options.ticket ?? (await this.findTicket(0, params.streamId));
    const tokenProgram = parseSenderTicket(senderTicket).tokenProgram;
    const anchor = await this.getStreamAnchor(params.streamId);
    return this.execute(
      "cancel_stream_private",
      [
        senderTicket,
        streamAnchorToPlaintext(anchor),
        i64Literal(params.timestamp ?? nowSeconds()),
      ],
      await this.withTokenImports(tokenProgram, options),
    );
  }

  /** Execute `cancel_stream_public`. The signer must be the stream's sender. */
  async cancelStreamPublic(
    params: StreamParams,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const stream = await this.getStream(params.streamId);
    const anchor = await this.getStreamAnchor(params.streamId);
    return this.execute(
      "cancel_stream_public",
      [
        streamToPlaintext(stream),
        streamAnchorToPlaintext(anchor),
        i64Literal(params.timestamp ?? nowSeconds()),
      ],
      await this.withTokenImports(stream.tokenProgram, options),
    );
  }

  /**
   * Execute `topup_stream_private`: pay the accrued debt of a buffer-mode
   * stream plus `params.amount` of pre-paid coverage. The token record must
   * cover the accrued debt plus the amount.
   */
  async topupStreamPrivate(
    params: TopupStreamParams,
    options: PrivateTopupStreamOptions = {},
  ): Promise<string> {
    const senderTicket = options.ticket ?? (await this.findTicket(0, params.streamId));
    const parsedTicket = parseSenderTicket(senderTicket);
    const anchor = await this.getStreamAnchor(params.streamId);
    const amount = BigInt(toMicroUnits(params.amount, params.tokenDecimals));
    const tokenRecord =
      options.tokenRecord ??
      (await this.findToken(this.tokenProgramId(parsedTicket.tokenProgram), amount));
    const complianceProofs =
      options.complianceProofs ??
      (await this.getComplianceProofs(
        this.tokenStablecoinKey(parsedTicket.tokenProgram),
        this.wallet.address,
      ));
    return this.execute(
      "topup_stream_private",
      [
        senderTicket,
        streamAnchorToPlaintext(anchor),
        `${amount}u128`,
        i64Literal(params.timestamp ?? nowSeconds()),
        tokenRecord,
        complianceProofs,
      ],
      await this.withTokenImports(parsedTicket.tokenProgram, options),
    );
  }

  /**
   * Execute `topup_stream_public`. The signer must be the stream's sender and
   * must have approved this program on the token for the top-up amount.
   */
  async topupStreamPublic(
    params: TopupStreamParams,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const stream = await this.getStream(params.streamId);
    const anchor = await this.getStreamAnchor(params.streamId);
    const amount = BigInt(toMicroUnits(params.amount, params.tokenDecimals));
    return this.execute(
      "topup_stream_public",
      [
        streamToPlaintext(stream),
        streamAnchorToPlaintext(anchor),
        `${amount}u128`,
        i64Literal(params.timestamp ?? nowSeconds()),
      ],
      await this.withTokenImports(stream.tokenProgram, options),
    );
  }

  /** Execute `withdraw_stream_private` (receiver only). */
  async withdrawStreamPrivate(
    params: StreamParams,
    options: PrivateStreamOperationOptions = {},
  ): Promise<string> {
    const receiverTicket = options.ticket ?? (await this.findTicket(1, params.streamId));
    const tokenProgram = parseReceiverTicket(receiverTicket).tokenProgram;
    const anchor = await this.getStreamAnchor(params.streamId);
    return this.execute(
      "withdraw_stream_private",
      [
        receiverTicket,
        streamAnchorToPlaintext(anchor),
        i64Literal(params.timestamp ?? nowSeconds()),
      ],
      await this.withTokenImports(tokenProgram, options),
    );
  }

  /** Execute `withdraw_stream_public`. The signer must be the stream's receiver. */
  async withdrawStreamPublic(
    params: StreamParams,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const stream = await this.getStream(params.streamId);
    const anchor = await this.getStreamAnchor(params.streamId);
    return this.execute(
      "withdraw_stream_public",
      [
        streamToPlaintext(stream),
        streamAnchorToPlaintext(anchor),
        i64Literal(params.timestamp ?? nowSeconds()),
      ],
      await this.withTokenImports(stream.tokenProgram, options),
    );
  }

  /** Execute `withdraw_stream_auto_private` (authorized withdrawer only). */
  async withdrawStreamAutoPrivate(
    params: StreamParams,
    config: Config,
    options: PrivateStreamOperationOptions = {},
  ): Promise<string> {
    const withdrawerTicket = options.ticket ?? (await this.findTicket(2, params.streamId));
    const tokenProgram = parseWithdrawerTicket(withdrawerTicket).tokenProgram;
    const anchor = await this.getStreamAnchor(params.streamId);
    return this.execute(
      "withdraw_stream_auto_private",
      [
        withdrawerTicket,
        configToPlaintext(this.parseConfig(config)),
        streamAnchorToPlaintext(anchor),
        i64Literal(params.timestamp ?? nowSeconds()),
      ],
      await this.withTokenImports(tokenProgram, options),
    );
  }

  /** Execute `withdraw_stream_auto_public` (authorized withdrawer only). */
  async withdrawStreamAutoPublic(
    params: StreamParams,
    config: Config,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const stream = await this.getStream(params.streamId);
    const anchor = await this.getStreamAnchor(params.streamId);
    return this.execute(
      "withdraw_stream_auto_public",
      [
        streamToPlaintext(stream),
        configToPlaintext(this.parseConfig(config)),
        streamAnchorToPlaintext(anchor),
        i64Literal(params.timestamp ?? nowSeconds()),
      ],
      await this.withTokenImports(stream.tokenProgram, options),
    );
  }

  // =======================================================================
  // Token program helpers (IARC22)
  // =======================================================================

  /**
   * Approve `spender` to pull public tokens via `transfer_from_public`.
   * `create_stream_public` spends `streamFeeAmount + deposit` from this
   * allowance (stream fee to the fee vault, deposit into the program);
   * `topup_stream_public` spends the top-up amount.
   */
  async approveTokenPublic(
    tokenProgram: string,
    spender: string,
    amount: string | number,
    tokenDecimals: number,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const parsedAmount = BigInt(toMicroUnits(amount, tokenDecimals));
    return this.executeOnProgram(
      this.tokenProgramId(tokenProgram),
      "approve_public",
      [spender, `${parsedAmount}u128`],
      options,
    );
  }

  /** Transfer public tokens from the connected wallet to `recipient`. */
  async transferTokenPublic(
    tokenProgram: string,
    tokenDecimals: number,
    amount: string | number,
    recipient: string,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const parsedAmount = BigInt(toMicroUnits(amount, tokenDecimals));
    return this.executeOnProgram(
      this.tokenProgramId(tokenProgram),
      "transfer_public",
      [recipient, `${parsedAmount}u128`],
      options,
    );
  }

  /**
   * Convert a private token record into a public balance for `recipient`.
   * Retries with the next-highest record when the wallet's record view is
   * stale (commitment already spent on-chain).
   */
  async transferTokenPrivateToPublic(
    tokenProgram: string,
    tokenDecimals: number,
    amount: string | number,
    recipient: string = this.wallet.address,
    options: ExecuteOptions & { tokenRecord?: string } = {},
  ): Promise<string> {
    const tokenProgramId = this.tokenProgramId(tokenProgram);
    const parsedAmount = BigInt(toMicroUnits(amount, tokenDecimals));
    const merkleProofs = await this.getComplianceProofs(
      this.tokenStablecoinKey(tokenProgram),
      this.wallet.address,
    );
    const records =
      options.tokenRecord !== undefined
        ? [options.tokenRecord]
        : (await this.findTokenRecords(tokenProgramId, parsedAmount)).reverse();
    if (records.length === 0) {
      throw new Error(
        `no unspent token record in ${tokenProgramId} with at least ${parsedAmount}`,
      );
    }
    let lastError: unknown;
    for (const tokenRecord of records) {
      try {
        return await this.executeOnProgram(
          tokenProgramId,
          "transfer_private_to_public",
          [recipient, `${parsedAmount}u128`, tokenRecord, merkleProofs],
          options,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/commitment|does not exist|already spent/i.test(message)) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // =======================================================================
  // Admin: configuration management
  // =======================================================================

  /** Execute `initialize_config` (one-time; the caller becomes config admin). */
  async initializeConfig(config: Config, options: ExecuteOptions = {}): Promise<string> {
    const parsed = this.parseConfig(config);
    return this.execute(
      "initialize_config",
      [
        fieldLiteral(parsed.configName),
        parsed.feeVault,
        parsed.withdrawer,
        u64Literal(parsed.baseFee),
        u64Literal(parsed.platformFee),
      ],
      options,
    );
  }

  /** Execute `update_config` (config admin only). */
  async updateConfig(config: Config, options: ExecuteOptions = {}): Promise<string> {
    const parsed = this.parseConfig(config);
    return this.execute(
      "update_config",
      [
        fieldLiteral(parsed.configName),
        parsed.feeVault,
        parsed.withdrawer,
        u64Literal(parsed.baseFee),
        u64Literal(parsed.platformFee),
      ],
      options,
    );
  }

  /** Execute `set_token_whitelisted` (config admin only). */
  async setTokenWhitelisted(
    configName: string | bigint,
    tokenProgram: string,
    whitelisted: boolean,
    options: ExecuteOptions = {},
  ): Promise<string> {
    return this.execute(
      "set_token_whitelisted",
      [fieldLiteral(configName), identLiteral(tokenProgram), whitelisted ? "true" : "false"],
      options,
    );
  }

  // =======================================================================
  // Compliance proofs (Sealance freeze lists)
  // =======================================================================

  /**
   * Build a Sealance Merkle exclusion proof showing `senderAddress` is NOT on
   * the stablecoin's freeze list. Returns the single
   * `[iarc22::MerkleProof; 2]` plaintext input.
   */
  async getComplianceProofs(
    stablecoinKey: "usad" | "usdcx",
    senderAddress: string,
  ): Promise<string> {
    const config = STABLE_COINS_CONFIGS.default;
    if (config === undefined) {
      throw new Error(`no stablecoin freeze-list configuration`);
    }
    const res = await fetch(config.freezeListApi[stablecoinKey]);
    if (!res.ok) {
      throw new Error(`failed to fetch freeze list: ${res.status} ${res.statusText}`);
    }
    const sealance = new SealanceMerkleTree();
    const tree = sealance.convertTreeToBigInt(await res.json());
    const [leftIdx, rightIdx] = sealance.getLeafIndices(tree, senderAddress);
    const leftProof = sealance.getSiblingPath(tree, leftIdx, 16);
    const rightProof = sealance.getSiblingPath(tree, rightIdx, 16);
    return sealance.formatMerkleProof([leftProof, rightProof]);
  }

  // =======================================================================
  // Reads (mapping queries)
  // =======================================================================

  /** Read and parse `streams[streamId]` (public streams only, raw form). */
  async getStream(streamId: string | bigint): Promise<RawStream> {
    const value = await this.readMappingValue(
      "streams",
      fieldLiteral(streamId),
      `stream not found for stream ${streamId}`,
    );
    return parseStream(value);
  }

  /** Read and parse `stream_anchors[streamId]` (raw form). */
  async getStreamAnchor(streamId: string | bigint): Promise<RawStreamAnchor> {
    const value = await this.readMappingValue(
      "stream_anchors",
      fieldLiteral(streamId),
      `stream anchor not found for stream ${streamId}`,
    );
    return parseStreamAnchor(value);
  }

  /**
   * Mapping reads right after a transaction confirms can race explorer
   * indexing; retry a few times before declaring the value missing.
   */
  private async readMappingValue(
    mapping: string,
    key: string,
    missingMessage: string,
  ): Promise<string> {
    const attempts = 10;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const value = await this.networkClient.getProgramMappingValue(
        this.programId,
        mapping,
        key,
      );
      if (value) return value;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    throw new Error(missingMessage);
  }

  /** Read `stream_configs[configName]` in human units (fees in ALEO). */
  async getStreamConfig(configName: string | bigint): Promise<Config> {
    const value = await this.networkClient.getProgramMappingValue(
      this.programId,
      "stream_configs",
      fieldLiteral(configName),
    );
    if (!value) throw new Error(`stream config not found: ${configName}`);
    const raw = parseStreamConfig(value);
    return {
      configName,
      admin: raw.admin,
      feeVault: raw.feeVault,
      withdrawer: raw.withdrawer,
      baseFee: fromMicroUnits(raw.baseFee),
      platformFee: fromMicroUnits(raw.platformFee),
    };
  }

  /**
   * Read `whitelisted_token_programs[whitelistKey(configName, token)]`.
   * Returns `false` when the key has never been set (mirroring the on-chain
   * `get_or_use(..., false)`).
   */
  async isTokenWhitelisted(
    configName: string | bigint,
    tokenProgram: string,
  ): Promise<boolean> {
    try {
      const value = await this.networkClient.getProgramMappingValue(
        this.programId,
        "whitelisted_token_programs",
        whitelistKey(configName, tokenProgram),
      );
      if (!value) return false;
      return parseBoolLiteral(value);
    } catch {
      return false;
    }
  }

  /**
   * Preview the withdrawable amounts of a stream at `now` by combining the
   * on-chain anchor with the off-chain vesting math. Amounts are raw
   * micro-units. `fullAmount` — the stream's total (from the receiver/sender
   * ticket for private streams or the `streams` mapping for public ones).
   * When omitted, it is fetched from `streams` for public streams; for
   * private streams it falls back to `depositedAmount`, which understates
   * accrued-but-unfunded amounts on buffer-mode streams.
   */
  async getWithdrawableAmounts(
    streamId: string | bigint,
    now: bigint = nowSeconds(),
    fullAmount?: bigint,
  ): Promise<WithdrawableAmounts> {
    const anchor = await this.getStreamAnchor(streamId);
    const effectiveNow = anchor.paused ? anchor.lastPausedTime : now;
    let base = fullAmount;
    if (base === undefined) {
      if (anchor.isPublic) {
        base = (await this.getStream(streamId)).fullAmount;
      } else {
        // Private fallback without ticket access: cap at what is funded.
        base = anchor.depositedAmount;
      }
    }
    const { totalWithdrawable, currentlyWithdrawable } = computeWithdrawableAmount(
      effectiveNow,
      anchor.startTime,
      anchor.duration,
      anchor.pausedInterval,
      base,
      anchor.withdrawnAmount,
    );
    // Payout is capped at the funded remainder.
    const available = anchor.depositedAmount - anchor.withdrawnAmount;
    return {
      totalWithdrawable,
      currentlyWithdrawable:
        currentlyWithdrawable <= available ? currentlyWithdrawable : available,
    };
  }

  // =======================================================================
  // Reads (per-address, per-config public stream registries)
  // =======================================================================

  /**
   * Number of public streams ever created by `account` under `config`, from
   * the `outgoing_stream_counts` mapping. Returns `0n` when unset.
   */
  async getOutgoingStreamCount(account: string, config: string | bigint): Promise<bigint> {
    return this.getRegistryCount("outgoing_stream_counts", account, config);
  }

  /**
   * Number of public streams ever received by `account` under `config`, from
   * the `incoming_stream_counts` mapping. Returns `0n` when unset.
   */
  async getIncomingStreamCount(account: string, config: string | bigint): Promise<bigint> {
    return this.getRegistryCount("incoming_stream_counts", account, config);
  }

  /**
   * The stream id at slot `index` of `account`'s outgoing registry under
   * `config` (`outgoing_stream_refs`), or `undefined` when the slot is absent.
   */
  async getOutgoingStreamRef(
    account: string,
    config: string | bigint,
    index: bigint | number,
  ): Promise<string | undefined> {
    return this.getRegistryRef("outgoing_stream_refs", account, config, index);
  }

  /**
   * The stream id at slot `index` of `account`'s incoming registry under
   * `config` (`incoming_stream_refs`), or `undefined` when the slot is absent.
   */
  async getIncomingStreamRef(
    account: string,
    config: string | bigint,
    index: bigint | number,
  ): Promise<string | undefined> {
    return this.getRegistryRef("incoming_stream_refs", account, config, index);
  }

  /**
   * List all public stream ids ever created by `account` under `config`
   * (outgoing registry, in creation order). Includes canceled and ended
   * streams — filter via {@link StreamService.getStreamAnchor}.
   */
  async listOutgoingStreamIds(account: string, config: string | bigint): Promise<string[]> {
    const count = await this.getOutgoingStreamCount(account, config);
    const ids: string[] = [];
    for (let i = 0n; i < count; i++) {
      const ref = await this.getOutgoingStreamRef(account, config, i);
      if (ref === undefined) {
        throw new Error(`missing outgoing stream ref for ${account} at index ${i}`);
      }
      ids.push(ref);
    }
    return ids;
  }

  /**
   * List all public stream ids ever received by `account` under `config`
   * (incoming registry, in creation order). Includes canceled and ended
   * streams.
   */
  async listIncomingStreamIds(account: string, config: string | bigint): Promise<string[]> {
    const count = await this.getIncomingStreamCount(account, config);
    const ids: string[] = [];
    for (let i = 0n; i < count; i++) {
      const ref = await this.getIncomingStreamRef(account, config, i);
      if (ref === undefined) {
        throw new Error(`missing incoming stream ref for ${account} at index ${i}`);
      }
      ids.push(ref);
    }
    return ids;
  }

  /**
   * List every public stream touching the connected wallet under `config` in
   * both directions via the on-chain per-address, per-config registries,
   * hydrated with the raw and human-facing anchor and stream entries.
   * Canceled and ended streams are included; use `anchor.canceled` /
   * `anchor.withdrawnAmount >= stream.fullAmount` to filter.
   */
  async listPublicStreams(config: string | bigint): Promise<PublicStreamEntry[]> {
    const account = this.wallet.address;
    const [outIds, inIds] = await Promise.all([
      this.listOutgoingStreamIds(account, config),
      this.listIncomingStreamIds(account, config),
    ]);
    const byId = new Map<string, { streamId: string; direction: "outgoing" | "incoming" }>();
    for (const streamId of outIds) {
      byId.set(streamId, { streamId, direction: "outgoing" });
    }
    for (const streamId of inIds) {
      if (byId.has(streamId)) {
        throw new Error(
          `invariant violation: stream ${streamId} is registered as both outgoing and incoming for ${account}`,
        );
      }
      byId.set(streamId, { streamId, direction: "incoming" });
    }
    const entries = [...byId.values()];
    return Promise.all(
      entries.map(async (entry) => {
        const [rawAnchor, rawStream] = await Promise.all([
          this.getStreamAnchor(entry.streamId),
          this.getStream(entry.streamId),
        ]);
        const decimals = await getDecimalsByTokenProgram(
          this.networkClient,
          this.tokenProgramId(rawStream.tokenProgram),
        );
        const stream: Stream = {
          streamId: rawStream.streamId,
          config: rawStream.config,
          sender: rawStream.sender,
          receiver: rawStream.receiver,
          fullAmount: fromMicroUnits(rawStream.fullAmount, decimals),
          tokenProgram: rawStream.tokenProgram,
          isCancelable: rawStream.isCancelable,
          isPausable: rawStream.isPausable,
          autoWithdrawable: rawStream.autoWithdrawable,
          canTopup: rawStream.canTopup,
          topupCount: rawStream.topupCount,
        };
        const anchor = humanAnchor(rawAnchor, decimals);
        return { ...entry, rawAnchor, rawStream, anchor, stream };
      }),
    );
  }

  private async getRegistryCount(
    mappingName: string,
    account: string,
    config: string | bigint,
  ): Promise<bigint> {
    try {
      const raw = await this.networkClient.getProgramMappingValue(
        this.programId,
        mappingName,
        streamCountKey(account, config),
      );
      if (!raw) return 0n;
      return parseIntLiteral(raw);
    } catch {
      return 0n;
    }
  }

  private async getRegistryRef(
    mappingName: string,
    account: string,
    config: string | bigint,
    index: bigint | number,
  ): Promise<string | undefined> {
    try {
      const raw = await this.networkClient.getProgramMappingValue(
        this.programId,
        mappingName,
        streamRefKey(account, config, index),
      );
      if (!raw) return undefined;
      return parseFieldLiteral(raw);
    } catch {
      return undefined;
    }
  }

  // =======================================================================
  // Records (via the wallet)
  // =======================================================================

  /**
   * Decrypt all unspent records of a program held by the wallet into
   * single-line plaintexts (the records-via-wallet pattern:
   * `requestRecords` → keep unspent → `wallet.decrypt`).
   */
  async decryptProgramRecords(programId: string): Promise<string[]> {
    const records = await this.wallet.requestRecords(programId, false);
    const plaintexts: string[] = [];
    for (const record of records) {
      const envelope = record as {
        recordCiphertext?: string;
        ciphertext?: string;
        spent?: boolean;
      } | null;
      if (envelope == null || envelope.spent === true) continue;
      const ciphertext = envelope.recordCiphertext ?? envelope.ciphertext;
      if (ciphertext === undefined) continue;
      const plaintext = (await this.wallet.decrypt(ciphertext))
        .replace(/\s+/g, " ")
        .trim();
      plaintexts.push(plaintext);
    }
    return plaintexts;
  }

  /**
   * Find the unspent stream ticket of `ticketType` (0 = sender, 1 = receiver,
   * 2 = withdrawer) for `streamId` held by the wallet. Throws if not found.
   */
  async findTicket(ticketType: 0 | 1 | 2, streamId: string | bigint): Promise<string> {
    const records = await this.decryptProgramRecords(this.programId);
    for (const record of records) {
      try {
        const parsed =
          ticketType === 0
            ? parseSenderTicket(record)
            : ticketType === 1
              ? parseReceiverTicket(record)
              : parseWithdrawerTicket(record);
        if (parsed.streamId === fieldLiteral(streamId)) return record;
      } catch {
        // Other records are expected in the wallet.
      }
    }
    throw new Error(`no unspent stream ticket found for stream ${streamId}`);
  }

  /**
   * List the wallet's private streams by scanning its unspent stream ticket
   * records — no on-chain index exists for private streams (by design:
   * sender/receiver never touch public state). Sender tickets are outgoing,
   * receiver tickets are incoming. Deduplicated per (stream id, direction);
   * withdrawer tickets mirror existing streams and are skipped. Canceled
   * streams may still appear — check the anchor's `canceled` flag.
   */
  async listPrivateStreams(): Promise<PrivateStreamEntry[]> {
    const streams = new Map<
      string,
      Omit<PrivateStreamEntry, "anchor" | "rawAnchor" | "ticket">
    >();
    for (const text of await this.decryptProgramRecords(this.programId)) {
      const kind = classifyTicket(text);
      if (kind === undefined || kind === "WithdrawerStreamTicket") continue;
      let direction: "outgoing" | "incoming";
      let rawTicket: RawSenderTicket | RawReceiverTicket;
      if (kind === "SenderStreamTicket") {
        rawTicket = parseSenderTicket(text);
        direction = "outgoing";
      } else {
        rawTicket = parseReceiverTicket(text);
        direction = "incoming";
      }
      const key = `${rawTicket.streamId}:${direction}`;
      if (!streams.has(key)) {
        streams.set(key, {
          streamId: rawTicket.streamId,
          direction,
          ticketKind: kind,
          ticketPlaintext: text,
          rawTicket,
        });
      }
    }
    const entries = [...streams.values()];
    return Promise.all(
      entries.map(async (entry) => {
        const decimals = await getDecimalsByTokenProgram(
          this.networkClient,
          this.tokenProgramId(entry.rawTicket.tokenProgram),
        );
        let ticket: SenderTicket | ReceiverTicket;
        if (entry.ticketKind === "SenderStreamTicket") {
          const rawTicket = entry.rawTicket as RawSenderTicket;
          ticket = {
            owner: rawTicket.owner,
            ticketType: 0,
            config: rawTicket.config,
            streamId: rawTicket.streamId,
            receiver: rawTicket.receiver,
            tokenProgram: rawTicket.tokenProgram,
            fullAmount: fromMicroUnits(rawTicket.fullAmount, decimals),
            isCancelable: rawTicket.isCancelable,
            isPausable: rawTicket.isPausable,
            canTopup: rawTicket.canTopup,
            topupCount: rawTicket.topupCount,
          };
        } else {
          const rawTicket = entry.rawTicket as RawReceiverTicket;
          ticket = {
            owner: rawTicket.owner,
            ticketType: 1,
            config: rawTicket.config,
            sender: rawTicket.sender,
            tokenProgram: rawTicket.tokenProgram,
            fullAmount: fromMicroUnits(rawTicket.fullAmount, decimals),
            autoWithdrawable: rawTicket.autoWithdrawable,
            streamId: rawTicket.streamId,
          };
        }
        const rawAnchor = await this.getStreamAnchor(entry.streamId);
        const anchor = humanAnchor(rawAnchor, decimals);
        return { ...entry, rawAnchor, anchor, ticket };
      }),
    );
  }

  /** Find the highest-value unspent credits record covering `minMicrocredits`. */
  async findCredits(minMicrocredits: bigint): Promise<string> {
    const plaintexts = await this.decryptProgramRecords(CREDITS_PROGRAM_ID);
    let best: { text: string; amount: bigint } | undefined;
    for (const text of plaintexts) {
      const amount = recordAmount(text, "microcredits");
      if (
        amount !== undefined &&
        amount >= minMicrocredits &&
        (best === undefined || amount > best.amount)
      ) {
        best = { text, amount };
      }
    }
    if (best === undefined) {
      throw new Error(
        `no unspent credits.aleo record with at least ${minMicrocredits} microcredits`,
      );
    }
    return best.text;
  }

  /** Find the highest-value unspent token record covering `minAmount`. */
  async findToken(tokenProgramId: string, minAmount: bigint): Promise<string> {
    const records = await this.findTokenRecords(tokenProgramId, minAmount);
    const first = records[0];
    if (first === undefined) {
      throw new Error(
        `no unspent token record in ${tokenProgramId} with at least ${minAmount}`,
      );
    }
    return first;
  }

  /** Unspent IARC22 `Token` records covering `minAmount`, highest first. */
  async findTokenRecords(tokenProgramId: string, minAmount: bigint): Promise<string[]> {
    const plaintexts = await this.decryptProgramRecords(tokenProgramId);
    const found: { text: string; amount: bigint }[] = [];
    for (const text of plaintexts) {
      if (!isTokenRecord(text)) continue;
      const amount = recordAmount(text, "amount");
      if (amount !== undefined && amount >= minAmount) {
        found.push({ text, amount });
      }
    }
    found.sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
    return found.map((record) => record.text);
  }

  // =======================================================================
  // Balances
  // =======================================================================

  /** Public ALEO balance of the connected wallet, in whole ALEO. */
  async getPublicBalance(): Promise<string> {
    const balance = await this.networkClient.getPublicBalance(this.wallet.address);
    return fromMicroUnits(balance);
  }

  /** Public token balance of the connected wallet, in whole token units. */
  async getPublicTokenBalance(
    tokenProgramId: string,
    tokenDecimals: number,
  ): Promise<string> {
    const mappingNames = await this.networkClient.getProgramMappingNames(tokenProgramId);
    const balanceMappingName = mappingNames.includes("balances")
      ? "balances"
      : mappingNames.includes("account")
        ? "account"
        : null;
    if (!balanceMappingName) {
      throw new Error("No public balance mapping found (no 'balances' or 'account').");
    }
    const balance = await this.networkClient.getProgramMappingValue(
      tokenProgramId,
      balanceMappingName,
      this.wallet.address,
    );
    if (!balance) return "0";
    const match = /(\d+)u\d+/.exec(balance);
    if (!match) {
      throw new Error(`Invalid balance format: ${balance}`);
    }
    return fromMicroUnits(match[1]!, tokenDecimals);
  }

  /** Total private ALEO balance (sum of unspent credits records), in whole ALEO. */
  async getPrivateBalance(): Promise<string> {
    const plaintexts = await this.decryptProgramRecords(CREDITS_PROGRAM_ID);
    if (plaintexts.length === 0) {
      throw new Error("No unspent credits.aleo records found");
    }
    const balance = plaintexts
      .map((text) => recordAmount(text, "microcredits") ?? 0n)
      .reduce((acc, val) => acc + val, 0n);
    return fromMicroUnits(balance, 6);
  }

  /** Total private token balance (sum of unspent token records), in whole token units. */
  async getPrivateTokenBalance(
    tokenProgramId: string,
    tokenDecimals: number,
  ): Promise<string> {
    const plaintexts = await this.decryptProgramRecords(tokenProgramId);
    if (plaintexts.length === 0) {
      throw new Error(`No unspent ${tokenProgramId} records found`);
    }
    const balance = plaintexts
      .map((text) => recordAmount(text, "amount") ?? 0n)
      .reduce((acc, val) => acc + val, 0n);
    return fromMicroUnits(balance, tokenDecimals);
  }
}

/** Whether a decrypted record plaintext is an IARC22 `Token` record. */
function isTokenRecord(plaintext: string): boolean {
  return (
    /(?:^|[\s,{])amount:\s*\d+u128/.test(plaintext) &&
    !plaintext.includes("ticket_type:") &&
    !plaintext.includes("full_amount:") &&
    !plaintext.includes("sender:") &&
    !plaintext.includes("recipient:")
  );
}

/** Convert a raw anchor to its human-facing form at `decimals` precision. */
function humanAnchor(raw: RawStreamAnchor, decimals: number): StreamAnchor {
  return {
    streamId: raw.streamId,
    startTime: Number(raw.startTime),
    duration: Number(raw.duration),
    paused: raw.paused,
    canceled: raw.canceled,
    canceledAt: Number(raw.canceledAt),
    depositedAmount: fromMicroUnits(raw.depositedAmount, decimals),
    lastPausedTime: Number(raw.lastPausedTime),
    pausedInterval: Number(raw.pausedInterval),
    withdrawnAmount: fromMicroUnits(raw.withdrawnAmount, decimals),
    isPublic: raw.isPublic,
    createdTimestamp: Number(raw.createdTimestamp),
  };
}
