/**
 * BHP256 hashing helpers reproducing the on-chain `BHP256::hash_to_field`
 * calls in `test_zebec_stream_v4.aleo` (mapping keys and the signed fee message).
 *
 * Verified against `leo run`: hashing a struct's plaintext bits with the
 * default wasm `BHP256` hasher produces the identical field (see
 * `test/unit/hashing.test.ts` for the known vector).
 */

import { BHP256, Plaintext } from "@provablehq/sdk";
import { fieldLiteral, identLiteral, streamTokenFeeToPlaintext } from "./plaintext.js";
import type { RawStreamTokenFee } from "./types.js";

let hasher: BHP256 | undefined;

function getHasher(): BHP256 {
  hasher ??= new BHP256();
  return hasher;
}

/**
 * Hash a Leo plaintext value to a field, exactly as
 * `BHP256::hash_to_field(value)` does on-chain. Returns the canonical field
 * literal (`"123field"`).
 */
export function hashPlaintextToField(plaintext: string): string {
  const value = Plaintext.fromString(plaintext);
  try {
    return getHasher().hash(value.toBitsLe()).toString();
  } finally {
    value.free();
  }
}

/**
 * Derive the `field` config key from an off-chain config name. Convention:
 * the name's UTF-8 bytes are hashed with BHP256 (8 little-endian bits per
 * byte). This is an SDK/backend convention — the on-chain program only ever
 * sees the resulting field.
 */
export function configNameToField(name: string): string {
  const bytes = new TextEncoder().encode(name);
  const bits: boolean[] = [];
  for (const byte of bytes) {
    for (let i = 0; i <= 7; i++) {
      // Shift the bit to the rightmost position and mask it
      bits.push(((byte >> i) & 1) === 1);
    }
  }
  return getHasher().hash(bits).toString();
}

/**
 * Mapping key of `whitelisted_token_programs` for `(config, token)` — BHP256
 * Mapping key of `whitelisted_token_programs` for `(config, token)` — BHP256
 * hash of the `WhitelistKey { config: field, token_program: identifier }`
 * struct.
 */
export function whitelistKey(configName: string | bigint, tokenProgram: string): string {
  return hashPlaintextToField(
    `{ config: ${fieldLiteral(configName)}, token_program: ${identLiteral(tokenProgram)} }`,
  );
}

/**
 * Mapping key of `allowances` on an IARC22 token for `(owner, spender)` — BHP256
 * hash of the `TokenAllowance { account, spender }` struct, matching the key the
 * token's `approve_public` / `transfer_from_public` transitions compute with
 * `hash.bhp256`. `account` is the owner, `spender` the spender.
 */
export function tokenAllowanceKey(owner: string, spender: string): string {
  return hashPlaintextToField(`{ account: ${owner}, spender: ${spender} }`);
}

/**
 * Mapping key of `outgoing_stream_counts` / `incoming_stream_counts` for
 * `(account, config)` — BHP256 hash of the
 * `StreamCountKey { account: address, config: field }` struct.
 */
export function streamCountKey(account: string, config: string | bigint): string {
  return hashPlaintextToField(`{ account: ${account}, config: ${fieldLiteral(config)} }`);
}

/**
 * Mapping key of `outgoing_stream_refs` / `incoming_stream_refs` for
 * `(account, config, index)` — BHP256 hash of the
 * `StreamRefKey { account: address, config: field, index: u64 }` struct.
 */
export function streamRefKey(account: string, config: string | bigint, index: bigint | number): string {
  return hashPlaintextToField(
    `{ account: ${account}, config: ${fieldLiteral(config)}, index: ${index}u64 }`,
  );
}

/**
 * The message the config admin signs for a `StreamTokenFee` — must equal
 * `BHP256::hash_to_field(token_fee)` as computed on-chain by
 * `finalize_create_stream`. Returns the canonical field literal.
 */
export function streamTokenFeeMessage(tokenFee: RawStreamTokenFee): string {
  return hashPlaintextToField(streamTokenFeeToPlaintext(tokenFee));
}
