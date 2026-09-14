/**
 * Network-level constants for the Zebec stream SDK: program ids per network,
 * default API endpoints, and the Sealance freeze-list APIs of the supported
 * compliant stablecoins (needed to build IARC22 exclusion proofs).
 */

/** Default explorer API endpoint (testnet). */
export const DEFAULT_ALEO_ENDPOINT = "https://api.explorer.provable.com/v1";

/** `credits.aleo` — the native token program. */
export const CREDITS_PROGRAM_ID = "credits.aleo";

/** Deployed Zebec stream program id per network. */
export const ZEBEC_STREAM_PROGRAM_ID = "test_zebec_stream_v4.aleo";

export interface StablecoinNetworkConfig {
  /**
   * Freeze-list API per stablecoin key (`usad` / `usdcx`), returning the
   * Sealance Merkle tree used to build exclusion proofs for IARC22 compliant
   * transfers.
   */
  freezeListApi: {
    usad: string;
    usdcx: string;
  };
}

/** Per-network configuration of the supported compliant stablecoins. */
export const STABLE_COINS_CONFIGS = {
  default: {
    freezeListApi: {
      usad: "https://api.explorer.provable.com/v2/testnet/programs/test_usad_freezelist.aleo/compliance/freeze-list",
      usdcx: "https://api.explorer.provable.com/v2/testnet/programs/test_usdcx_freezelist.aleo/compliance/freeze-list",
    },
  },
};
