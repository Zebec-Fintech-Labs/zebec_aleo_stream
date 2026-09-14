/**
 * Resolve `NETWORK` and load the matching `@provablehq/sdk` bundle.
 * Mainnet and testnet wasm are different; the testnet client always
 * appends `/testnet` to the API host.
 */

import type { Network } from "./config.js";

export type { Network };

export type AleoSdk = typeof import("@provablehq/sdk/testnet.js");

let loaded: AleoSdk | undefined;
let loadedNetwork: Network | undefined;
let loading: Promise<AleoSdk> | undefined;

/** Read `NETWORK` (`testnet` | `mainnet`). Defaults to `testnet`. */
export function resolvedNetwork(): Network {
  const network = (process.env.NETWORK ?? "testnet").trim().toLowerCase();
  if (network !== "mainnet" && network !== "testnet") {
    throw new Error(
      `Unsupported NETWORK="${network}". Set NETWORK=mainnet or NETWORK=testnet.`,
    );
  }
  return network;
}

/** Load (or return the cached) SDK for `network`. */
export async function loadAleoSdk(
  network: Network = resolvedNetwork(),
): Promise<AleoSdk> {
  if (loaded && loadedNetwork === network) return loaded;
  if (loading && loadedNetwork === network) return loading;

  loadedNetwork = network;
  loading = (network === "mainnet"
    ? import("@provablehq/sdk/mainnet.js")
    : import("@provablehq/sdk/testnet.js")) as Promise<AleoSdk>;
  loaded = await loading;
  loading = undefined;
  return loaded;
}

/**
 * The SDK last loaded by {@link loadAleoSdk}, or `undefined` if nothing has
 * been loaded yet (browser / tests that still use the testnet default).
 */
export function getLoadedAleoSdk(): AleoSdk | undefined {
  return loaded;
}
