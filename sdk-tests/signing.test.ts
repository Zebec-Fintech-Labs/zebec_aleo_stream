import assert from "node:assert";
import { Account } from "@provablehq/sdk";
import { describe, it } from "mocha";

import { signStreamTokenFee, verifyStreamTokenFeeSignature } from "../sdk/signing.js";
import type { RawStreamTokenFee } from "../sdk/types.js";

// Well-known Leo CLI default private key (public, used for tests only).
const TEST_PRIVATE_KEY =
  "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";

const tokenFee: RawStreamTokenFee = {
  config: 12345n,
  streamToken: "token",
  streamFeeAmount: 50_000n,
  streamAmount: 100_000_000n,
  expiry: 1_893_456_000n,
  nonce: 5n,
};

describe("signStreamTokenFee", () => {
  it("produces a sign1... signature that verifies against the signer address", () => {
    const account = new Account({ privateKey: TEST_PRIVATE_KEY });
    const signature = signStreamTokenFee(TEST_PRIVATE_KEY, tokenFee);
    assert.ok(signature.startsWith("sign1"));
    assert.ok(
      verifyStreamTokenFeeSignature(account.address().to_string(), tokenFee, signature),
    );
  });

  it("fails verification for a different fee object (nonce changed)", () => {
    const account = new Account({ privateKey: TEST_PRIVATE_KEY });
    const signature = signStreamTokenFee(TEST_PRIVATE_KEY, tokenFee);
    const other = { ...tokenFee, nonce: 6n };
    assert.ok(
      !verifyStreamTokenFeeSignature(account.address().to_string(), other, signature),
    );
  });

  it("fails verification for a different fee amount", () => {
    const account = new Account({ privateKey: TEST_PRIVATE_KEY });
    const signature = signStreamTokenFee(TEST_PRIVATE_KEY, tokenFee);
    const other = { ...tokenFee, streamFeeAmount: 99_999n };
    assert.ok(
      !verifyStreamTokenFeeSignature(account.address().to_string(), other, signature),
    );
  });

  it("fails verification for a different stream amount", () => {
    // The signed fee is bound to the stream's `params.amount`; reusing a
    // smaller-stream fee for a larger stream must not verify.
    const account = new Account({ privateKey: TEST_PRIVATE_KEY });
    const signature = signStreamTokenFee(TEST_PRIVATE_KEY, tokenFee);
    const other = { ...tokenFee, streamAmount: 100_000_001n };
    assert.ok(
      !verifyStreamTokenFeeSignature(account.address().to_string(), other, signature),
    );
  });

  it("fails verification for a different address", () => {
    const signature = signStreamTokenFee(TEST_PRIVATE_KEY, tokenFee);
    const other = new Account();
    assert.ok(
      !verifyStreamTokenFeeSignature(other.address().to_string(), tokenFee, signature),
    );
  });
});
