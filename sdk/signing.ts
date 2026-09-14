/**
 * Admin-side signing of `StreamTokenFee` messages.
 *
 * On-chain, `create_stream_private` and `create_stream_public` verify
 * `std::sig::verify_schnorr(fee_signature, config.admin, fee_message)`
 * where `fee_message = BHP256::hash_to_field(token_fee)`. Off-chain we
 * reproduce the message field via {@link streamTokenFeeMessage} and sign it
 * as an Aleo value with the admin's private key.
 */

import { Address, PrivateKey, Signature } from "@provablehq/sdk";
import { streamTokenFeeMessage } from "./hashing.js";
import type { RawStreamTokenFee } from "./types.js";

/**
 * Sign a `StreamTokenFee` with the config admin's private key. Returns the
 * signature literal (`sign1...`) to pass as the `fee_signature` input of
 * `create_stream_private` or `create_stream_public`. The fee object is in
 * raw on-chain form (`streamFeeAmount`/`streamAmount` in token micro-units).
 */
export function signStreamTokenFee(
  privateKey: string | PrivateKey,
  tokenFee: RawStreamTokenFee,
): string {
  const key =
    typeof privateKey === "string" ? PrivateKey.from_string(privateKey) : privateKey;
  const message = streamTokenFeeMessage(tokenFee);
  const signature: Signature = key.signValue(message);
  try {
    return signature.toString();
  } finally {
    signature.free();
  }
}

/**
 * Verify a `StreamTokenFee` signature against an admin address. Useful for
 * sanity-checking signatures produced off-chain.
 */
export function verifyStreamTokenFeeSignature(
  address: string,
  tokenFee: RawStreamTokenFee,
  signature: string,
): boolean {
  const message = streamTokenFeeMessage(tokenFee);
  const sig = Signature.from_string(signature);
  try {
    return sig.verifyValue(Address.from_string(address), message);
  } finally {
    sig.free();
  }
}