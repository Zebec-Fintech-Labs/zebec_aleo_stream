import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * snarkVM `testnet-v4.11.0` activates consensus V21 (Varuna V3) at this height.
 * `@provablehq/sdk` 0.12.0 was published earlier the same day, and its testnet
 * wasm still has V21 at `u32::MAX`, so it proves Varuna V2 fees. Testnet
 * rejects those with `verify_batch` failed.
 */
const TESTNET_V21_HEIGHT = 20_234_000;
const V20_HEIGHT = 19_374_000;
const U32_MAX = 0xffff_ffff;

const require = createRequire(import.meta.url);

function heightMarker(v21Height: number): Buffer {
  const marker = Buffer.alloc(16);
  marker.writeUInt32LE(20, 0);
  marker.writeUInt32LE(V20_HEIGHT, 4);
  marker.writeUInt32LE(21, 8);
  marker.writeUInt32LE(v21Height, 12);
  return marker;
}

/**
 * Point the installed testnet wasm at the live V21 height. Idempotent.
 * Must run before `@provablehq/sdk/testnet.js` is imported.
 */
export function patchTestnetConsensusWasm(): void {
  const entry = require.resolve("@provablehq/wasm/testnet.js");
  const wasmPath = path.join(path.dirname(entry), "aleo_wasm.wasm");
  const data = readFileSync(wasmPath);
  const stale = heightMarker(U32_MAX);
  const current = heightMarker(TESTNET_V21_HEIGHT);

  if (!data.includes(stale)) {
    if (!data.includes(current)) {
      throw new Error(
        `Could not find the testnet consensus V21 slot in ${wasmPath}.`,
      );
    }
    return;
  }
  if (data.indexOf(stale) !== data.lastIndexOf(stale)) {
    throw new Error(`Ambiguous consensus height table in ${wasmPath}.`);
  }

  const patched = Buffer.from(data);
  const offset = patched.indexOf(stale);
  patched.writeUInt32LE(TESTNET_V21_HEIGHT, offset + 12);
  writeFileSync(wasmPath, patched);
  console.log(
    "Updated testnet SDK consensus V21 height to 20234000 so fee proofs use Varuna V3.",
  );
}
