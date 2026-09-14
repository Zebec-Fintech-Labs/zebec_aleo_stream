/**
 * TypeScript mirrors of the Leo structs in `test_zebec_stream_v4.aleo` (see
 * `src/main.leo` at the repository root) plus SDK option types.
 *
 * Two layers of types:
 * - **`Raw*`** types mirror the on-chain structs exactly: integer values are
 *   `bigint` micro-units, timestamps are `bigint` unix seconds. These are what
 *   the plaintext serializers/parsers in `sdk/plaintext.ts` produce and
 *   consume, and what the program expects as inputs.
 * - **Human-facing** types (no prefix) are what `StreamService` accepts and
 *   returns: amounts are decimal strings (or numbers) in whole token units,
 *   timestamps/durations are `number` seconds. The service converts between
 *   the two layers with `toMicroUnits` / `fromMicroUnits` (see
 *   `sdk/utils.ts`).
 *
 * Conventions used across the SDK:
 * - Aleo `field` values are represented as strings, either canonical
 *   (`"123field"`) or bare digits (`"123"`); both are accepted on input and
 *   canonical form is produced on output. `bigint` is also accepted on input.
 * - Aleo `identifier` values (e.g. `token_program`) are plain identifier
 *   strings without quotes (`"my_token_program"`).
 * - Aleo addresses are `aleo1...` strings.
 */

// ===========================================================================
// Raw (on-chain) types — bigint micro-units, bigint seconds
// ===========================================================================

/** Leo `Stream` struct, as stored in the `streams` mapping (public streams only). */
export interface RawStream {
  streamId: string;
  /** Config (tenant) the stream was created under. */
  config: string;
  sender: string;
  receiver: string;
  fullAmount: bigint;
  tokenProgram: string;
  isCancelable: boolean;
  isPausable: boolean;
  autoWithdrawable: boolean;
  canTopup: boolean;
  topupCount: bigint;
}

/** Leo `StreamConfig` struct, as stored in the `stream_configs` mapping. */
export interface RawStreamConfig {
  admin: string;
  feeVault: string;
  withdrawer: string;
  baseFee: bigint;
  platformFee: bigint;
}

/** Leo `StreamAnchor` struct, as stored in the `stream_anchors` mapping. */
export interface RawStreamAnchor {
  streamId: string;
  startTime: bigint;
  duration: bigint;
  paused: boolean;
  canceled: boolean;
  canceledAt: bigint;
  depositedAmount: bigint;
  lastPausedTime: bigint;
  pausedInterval: bigint;
  withdrawnAmount: bigint;
  isPublic: boolean;
  createdTimestamp: bigint;
}

/** Leo `CreateStreamParams` struct (input of the create entries). */
export interface RawCreateStreamParams {
  receiver: string;
  /** Randomness for the stream id (a `field`). */
  streamId: string | bigint;
  amount: bigint;
  startTime: bigint;
  duration: bigint;
  isCancelable: boolean;
  isPausable: boolean;
  autoWithdrawable: boolean;
  withdrawFrequency: bigint;
  startNow: boolean;
  canTopup: boolean;
  initialBufferAmount: bigint;
}

/** Leo `Config` struct (input of the create entries). */
export interface RawConfig {
  /** The `field` key of the config in the `stream_configs` mapping. */
  configName: string | bigint;
  admin: string;
  feeVault: string;
  withdrawer: string;
  baseFee: bigint;
  platformFee: bigint;
}

/** Leo `StreamTokenFee` struct — admin-signed fee for a single create transaction. */
export interface RawStreamTokenFee {
  /**
   * Config name (`field`) this fee is signed for. Binds the admin's
   * signature to one stream config so it cannot be replayed elsewhere.
   */
  config: string | bigint;
  /** Identifier of the stream token program. */
  streamToken: string;
  /** Admin-signed stream fee amount in stream-token units (Leo `u128`). */
  streamFeeAmount: bigint;
  /**
   * Full stream amount this fee is signed for (must equal the `amount` field
   * of `CreateStreamParams`). Binds the admin's signature to one stream size
   * so a signed fee cannot be reused for a larger stream.
   */
  streamAmount: bigint;
  /** Unix timestamp after which this signed fee expires. */
  expiry: bigint;
  /** Unique nonce (a `field`), used for replay protection. */
  nonce: string | bigint;
}

/** Leo `SenderStreamTicket` record (ticket_type 0) — authorizes pause/resume/topup/cancel. */
export interface RawSenderTicket {
  owner: string;
  ticketType: bigint;
  /** Config (tenant) the stream was created under. */
  config: string;
  streamId: string;
  receiver: string;
  tokenProgram: string;
  fullAmount: bigint;
  isCancelable: boolean;
  isPausable: boolean;
  canTopup: boolean;
  topupCount: bigint;
}

/** Leo `ReceiverStreamTicket` record (ticket_type 1) — authorizes withdraw. */
export interface RawReceiverTicket {
  owner: string;
  ticketType: bigint;
  /** Config (tenant) the stream was created under. */
  config: string;
  sender: string;
  tokenProgram: string;
  fullAmount: bigint;
  autoWithdrawable: boolean;
  streamId: string;
}

/** Leo `WithdrawerStreamTicket` record (ticket_type 2) — authorizes auto-withdraw. */
export interface RawWithdrawerTicket {
  owner: string;
  ticketType: bigint;
  /** Config (tenant) the stream was created under; binds the withdrawer to it. */
  config: string;
  fullAmount: bigint;
  streamId: string;
  sender: string;
  receiver: string;
  tokenProgram: string;
  autoWithdrawable: boolean;
}

/** @deprecated Use {@link RawStreamTokenFee} instead. */
export type TokenPrice = RawStreamTokenFee;

// ===========================================================================
// Human-facing types — decimal-string amounts, number seconds
// ===========================================================================

/** Human-facing stream entry (see {@link RawStream}). */
export interface Stream {
  streamId: string;
  /** Config (tenant) the stream was created under. */
  config: string;
  sender: string;
  receiver: string;
  /** Stream total in whole token units (decimal string). */
  fullAmount: string;
  tokenProgram: string;
  isCancelable: boolean;
  isPausable: boolean;
  autoWithdrawable: boolean;
  canTopup: boolean;
  topupCount: bigint;
}

/** Human-facing stream anchor (see {@link RawStreamAnchor}). */
export interface StreamAnchor {
  streamId: string;
  startTime: number;
  duration: number;
  paused: boolean;
  canceled: boolean;
  canceledAt: number;
  /** Deposited amount in whole token units (decimal string). */
  depositedAmount: string;
  lastPausedTime: number;
  pausedInterval: number;
  /** Withdrawn amount in whole token units (decimal string). */
  withdrawnAmount: string;
  isPublic: boolean;
  createdTimestamp: number;
}

/** Human-facing stream configuration (see {@link RawConfig}). */
export interface Config {
  /** The `field` key of the config in the `stream_configs` mapping. */
  configName: string | bigint;
  admin: string;
  feeVault: string;
  withdrawer: string;
  /** Auto-withdrawal base fee in ALEO (decimal string or number). */
  baseFee: string | number;
  /** Auto-withdrawal platform fee in ALEO (decimal string or number). */
  platformFee: string | number;
}

/** Human-facing create-stream parameters (see {@link RawCreateStreamParams}). */
export interface CreateStreamParams {
  receiver: string;
  /** Randomness for the stream id (a `field`). */
  streamId: string | bigint;
  /** Stream total in whole token units. */
  amount: string | number;
  /** Unix timestamp of the stream start (ignored when `startNow` is true). */
  startTime: string | number | bigint;
  /** Stream duration in seconds. */
  duration: string | number | bigint;
  isCancelable: boolean;
  isPausable: boolean;
  autoWithdrawable: boolean;
  /** Auto-withdraw frequency in seconds (0 when disabled). */
  withdrawFrequency: string | number | bigint;
  startNow: boolean;
  canTopup: boolean;
  /** Initial buffer deposit in whole token units (buffer mode only). */
  initialBufferAmount: string | number;
}

/** Human-facing admin-signed stream fee (see {@link RawStreamTokenFee}). */
export interface StreamTokenFee {
  /** Config name (`field`) this fee is signed for. */
  config: string | bigint;
  /** Identifier of the stream token program. */
  streamToken: string;
  /** Fee amount in whole stream-token units. */
  streamFeeAmount: string | number;
  /** Full stream amount this fee is signed for (the `params.amount`), in whole stream-token units. */
  streamAmount: string | number;
  /** Unix timestamp after which this signed fee expires. */
  expiry: string | number | bigint;
  /** Unique nonce (a `field`), used for replay protection. */
  nonce: string | bigint;
}

/** Human-facing sender ticket (see {@link RawSenderTicket}). */
export interface SenderTicket {
  owner: string;
  ticketType: 0;
  config: string;
  streamId: string;
  receiver: string;
  tokenProgram: string;
  fullAmount: string;
  isCancelable: boolean;
  isPausable: boolean;
  canTopup: boolean;
  topupCount: bigint;
}

/** Human-facing receiver ticket (see {@link RawReceiverTicket}). */
export interface ReceiverTicket {
  owner: string;
  ticketType: 1;
  config: string;
  sender: string;
  tokenProgram: string;
  fullAmount: string;
  autoWithdrawable: boolean;
  streamId: string;
}

// ===========================================================================
// Method parameter / option types
// ===========================================================================

/** Parameters shared by the private/public lifecycle methods. */
export interface StreamParams {
  streamId: string | bigint;
  /**
   * Unix timestamp the vesting math is evaluated at (the `now` input of the
   * lifecycle entries). Defaults to the current time.
   */
  timestamp?: string | number | bigint;
}

/** Parameters for `topupStreamPrivate` / `topupStreamPublic`. */
export interface TopupStreamParams {
  streamId: string | bigint;
  /** See {@link StreamParams.timestamp}. */
  timestamp?: string | number | bigint;
  /** Top-up amount in whole token units. */
  amount: string | number;
  /** Decimals of the stream token (see `getDecimalsByTokenProgram`). */
  tokenDecimals: number;
}

/** Per-execution options (fee handling and dynamic-dispatch imports). */
export interface ExecuteOptions {
  /**
   * Priority fee in microcredits. Defaults to 100,000 (0.1 ALEO). Passed to
   * the wallet's `fee` parameter as-is.
   */
  priorityFee?: number;
  /** Pay the fee with a private credits record. Defaults to false. */
  privateFee?: boolean;
  /** Fee record (plaintext string) to use when `privateFee` is true. */
  feeRecord?: string;
  /**
   * Program names to import for dynamic-dispatch calls. When omitted, the
   * service resolves the token program's import chain automatically.
   */
  imports?: string[];
}

/** Options for private lifecycle methods driven by a stream ticket record. */
export interface PrivateStreamOperationOptions extends ExecuteOptions {
  /** Pre-located ticket record plaintext; located via the wallet when omitted. */
  ticket?: string;
}

/** Options for `topupStreamPrivate`. */
export interface PrivateTopupStreamOptions extends ExecuteOptions {
  /** Pre-located sender ticket record plaintext. */
  ticket?: string;
  /** Pre-located token record plaintext covering the top-up amount. */
  tokenRecord?: string;
  /** Pre-built `[iarc22::MerkleProof; 2]` compliance-proof plaintext. */
  complianceProofs?: string;
}

// ===========================================================================
// Listing types
// ===========================================================================

/** Relationship of an account to a listed stream. */
export type StreamDirection = "outgoing" | "incoming" | "both";

/** One hydrated entry of `StreamService.listPublicStreams`. */
export interface PublicStreamEntry {
  streamId: string;
  direction: StreamDirection;
  /** On-chain anchor (raw bigint form). */
  rawAnchor: RawStreamAnchor;
  /** On-chain stream entry (raw bigint form). */
  rawStream: RawStream;
  /** Human-facing anchor (decimal-string amounts). */
  anchor: StreamAnchor;
  /** Human-facing stream entry (decimal-string amounts). */
  stream: Stream;
}

/** One hydrated entry of `StreamService.listPrivateStreams`. */
export interface PrivateStreamEntry {
  streamId: string;
  direction: "outgoing" | "incoming";
  /** Which ticket record identified the stream. */
  ticketKind: "SenderStreamTicket" | "ReceiverStreamTicket";
  /** Decrypted plaintext of the ticket record. */
  ticketPlaintext: string;
  /** Parsed ticket record (raw bigint form). */
  rawTicket: RawSenderTicket | RawReceiverTicket;
  /** On-chain anchor (raw bigint form). */
  rawAnchor: RawStreamAnchor;
  /** Human-facing anchor (decimal-string amounts). */
  anchor: StreamAnchor;
  /** Human-facing ticket (decimal-string amounts). */
  ticket: SenderTicket | ReceiverTicket;
}

// ===========================================================================
// Shared struct / wallet types
// ===========================================================================

/** `iarc22::MerkleProof` struct (16 siblings). */
export interface MerkleProof {
  /** 16 field elements. */
  siblings: (string | bigint)[];
  leafIndex: number;
}

/**
 * Options passed to `AleoWallet.executeTransaction`. A subset of the
 * wallet-standard `TransactionOptions` (`@provablehq/aleo-types`), restricted
 * to literal-string inputs — structurally compatible with the wallet
 * adaptor's own type, so an adaptor wallet can be passed straight in.
 */
export interface TransactionOptions {
  /** The program to execute. */
  program: string;
  /** The function to call. */
  function: string;
  /** Literal Aleo values (strings), one per function input. */
  inputs: string[];
  /** Priority fee in microcredits. */
  fee?: number;
  /** Whether the fee is paid with a private credits record. */
  privateFee?: boolean;
  /** Fee record (plaintext string) to use when `privateFee` is true. */
  feeRecord?: string;
  /** Program names the wallet must import for dynamic-dispatch calls. */
  imports?: string[];
}

/**
 * Minimal wallet interface accepted by {@link StreamClient}. In the browser
 * this is the Shield/Leo wallet adaptor's `useWallet()` context; in Node it
 * is created from a private key via `createAleoWallet` (see `sdk/wallet.ts`).
 * All signing, proving, and record decryption happens inside the wallet.
 */
export interface AleoWallet {
  address: string;
  decrypt: (cipherText: string) => Promise<string>;
  requestRecords: (
    program: string,
    includePlaintext?: boolean | undefined,
  ) => Promise<unknown[]>;
  executeTransaction: (options: TransactionOptions) => Promise<{
    transactionId: string;
  }>;
}

/** Options for constructing a {@link StreamClient}. */
export interface StreamServiceOptions {
  /** API host. Defaults to the testnet explorer API. */
  host?: string;
  /**
   * Program id. Defaults to the deployed program —
   * `test_zebec_stream_v4.aleo` on testnet.
   */
  programId?: string;
}
