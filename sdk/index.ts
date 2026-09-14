/**
 * zebec-stream-sdk — TypeScript SDK for the `test_zebec_stream_v4.aleo` program.
 */

export {
  StreamService as StreamClient,
  DEFAULT_ENDPOINT,
  PROGRAM_ID,
} from "./client.js";

export {
  DEFAULT_ALEO_ENDPOINT,
  CREDITS_PROGRAM_ID,
  ZEBEC_STREAM_PROGRAM_ID,
  STABLE_COINS_CONFIGS,
} from "./config.js";
export type { StablecoinNetworkConfig } from "./config.js";

export { createAleoWallet } from "./wallet.js";
export type { AleoWalletOptions } from "./wallet.js";

export {
  toMicroUnits,
  fromMicroUnits,
  getDecimalsByTokenProgram,
} from "./utils.js";

export {
  createStreamParamsToPlaintext,
  configToPlaintext,
  streamTokenFeeToPlaintext,
  tokenPriceToPlaintext, // @deprecated
  streamAnchorToPlaintext,
  merkleProofToPlaintext,
  merkleProofsToPlaintext,
  streamToPlaintext,
  fieldLiteral,
  identLiteral,
  i64Literal,
  u64Literal,
  classifyTicket,
  matchesTicketRecord,
  parseStructMembers,
  parseStreamAnchor,
  parseStream,
  parseStreamConfig,
  parseSenderTicket,
  parseReceiverTicket,
  parseWithdrawerTicket,
  parseIntLiteral,
  parseBoolLiteral,
  parseFieldLiteral,
  parseIdentLiteral,
} from "./plaintext.js";
export type { TicketRecordName } from "./plaintext.js";

export {
  hashPlaintextToField,
  configNameToField,
  whitelistKey,
  tokenAllowanceKey,
  streamCountKey,
  streamRefKey,
  streamTokenFeeMessage,
} from "./hashing.js";

export {
  computeStreamFee,
  computeAutoWithdrawalFee,
  computeTopupAmount,
  computeWithdrawableAmount,
  findFeeTier,
  isWithdrawFrequencyValid,
  nowSeconds,
  USD_PRICE_DECIMALS_SCALE,
  BPS_DENOMINATOR,
  DEFAULT_WITHDRAW_FREQUENCY,
  WITHDRAW_FREQUENCIES,
} from "./math.js";
export type {
  StreamFee,
  StreamFeeTier,
  TopupAmount,
  WithdrawableAmounts,
} from "./math.js";

export {
  signStreamTokenFee,
  verifyStreamTokenFeeSignature,
} from "./signing.js";

export {
  findCreditsRecord,
  findTokenRecord,
  findTicketRecord,
  recordAmount,
} from "./records.js";

export type {
  AleoWallet,
  Config,
  CreateStreamParams,
  ExecuteOptions,
  MerkleProof,
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
  RawStreamConfig,
  RawStreamTokenFee,
  RawWithdrawerTicket,
  ReceiverTicket,
  SenderTicket,
  Stream,
  StreamAnchor,
  StreamDirection,
  StreamParams,
  StreamServiceOptions,
  StreamTokenFee,
  TopupStreamParams,
  TransactionOptions,
  TokenPrice, // @deprecated alias for RawStreamTokenFee
} from "./types.js";
