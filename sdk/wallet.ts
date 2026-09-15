/**
 * `createAleoWallet` — build an {@link AleoWallet} from a private key for
 * Node/CLI use, so `StreamService` runs identically in the browser (Shield
 * wallet) and in scripts.
 *
 * - `decrypt` / `requestRecords` use the account's view key; records are
 *   located via Provable's confidential RecordScanner service.
 * - `executeTransaction` builds a `ProvingRequest` locally (authorization
 *   only) and submits it to the delegated proving service, which proves and
 *   broadcasts the transaction. Submissions are retried with backoff;
 *   sticky 401s on the DPS `/pubkey` endpoint drop the cached JWT and retry
 *   with a fresh client.
 *
 * Requires `PROVER_API_KEY` and `PROVER_CONSUMER_ID` (or explicit options)
 * for both the scanner and the proving service.
 */

import { DEFAULT_ALEO_ENDPOINT, type Network } from "./config.js";
import { loadAleoSdk, type AleoSdk } from "./network.js";
import type { AleoWallet } from "./types.js";

/** Options for {@link createAleoWallet}. Every value falls back to env vars. */
export interface AleoWalletOptions {
  /** API host. Env: `ENDPOINT`. */
  host?: string;
  /** `mainnet` or `testnet`. Env: `NETWORK`. */
  network?: Network;
  /** Delegated proving service URI. Env: `PROVER_URI`. */
  proverUri?: string;
  /** Record scanner service URI. Env: `RECORD_SCANNER_URI`. */
  recordScannerUri?: string;
  /** Provable API key. Env: `PROVABLE_API_KEY` / `PROVER_API_KEY`. */
  apiKey?: string;
  /** Provable consumer id. Env: `PROVABLE_CONSUMER_ID` / `PROVER_CONSUMER_ID`. */
  consumerId?: string;
}

const programSourceCache = new Map<string, string>();

function networkRetries(): number {
  const configured = Number(process.env.NETWORK_RETRIES ?? "3");
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
}

function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 5000);
}

function provingRetries(): number {
  const configured = Number(
    process.env.PROVING_RETRIES ?? process.env.NETWORK_RETRIES ?? "8",
  );
  return Number.isInteger(configured) && configured > 0 ? configured : 8;
}

function provingRetryDelay(attempt: number, pubkeyAuthError: boolean): number {
  if (pubkeyAuthError) {
    return Math.min(5000 * attempt, 30000);
  }
  return Math.min(retryDelay(attempt) * 2, 15000);
}

function isPubkeyAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : undefined;
  return status === 401 || /401 could not get URL|\/pubkey/.test(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getProgramManager(
  sdk: AleoSdk,
  host: string,
  account: InstanceType<AleoSdk["Account"]>,
  networkClient: InstanceType<AleoSdk["AleoNetworkClient"]>,
): InstanceType<AleoSdk["ProgramManager"]> {
  const keyProvider = new sdk.AleoKeyProvider();
  const recordProvider = new sdk.NetworkRecordProvider(
    account,
    networkClient,
  );
  const pm = new sdk.ProgramManager(host, keyProvider, recordProvider);
  pm.setAccount(account);
  return pm;
}

async function loadProgramSource(
  networkClient: InstanceType<AleoSdk["AleoNetworkClient"]>,
  programId: string,
): Promise<string> {
  const cached = programSourceCache.get(programId);
  if (cached !== undefined) return cached;

  let lastError: unknown;
  for (let attempt = 1; attempt <= networkRetries(); attempt++) {
    try {
      const source = await networkClient.getProgram(programId);
      programSourceCache.set(programId, source);
      return source;
    } catch (error) {
      lastError = error;
      if (attempt === networkRetries()) break;
      console.warn(
        `[wallet] fetching ${programId} failed (attempt ${attempt}/${networkRetries()}); retrying in ${retryDelay(attempt)}ms`,
      );
      await sleep(retryDelay(attempt));
    }
  }

  throw new Error(
    `Unable to fetch ${programId} after ${networkRetries()} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Create a Node {@link AleoWallet} from a private key (`APrivateKey1...` or a
 * `PrivateKey` object) for `network`.
 */
export async function createAleoWallet(
  privateKey: string | { to_string(): string },
  options: AleoWalletOptions = {},
): Promise<AleoWallet> {
  const sdk = await loadAleoSdk(options.network);
  const {
    Account,
    AleoNetworkClient,
    RecordScanner,
  } = sdk;

  const host = options.host ?? process.env.ENDPOINT ?? DEFAULT_ALEO_ENDPOINT;
  const proverUri = options.proverUri ?? process.env.PROVER_URI ?? "https://api.provable.com/prove";
  const recordScannerUri =
    options.recordScannerUri ?? process.env.RECORD_SCANNER_URI ?? "https://api.provable.com/scanner";

  const apiKey = options.apiKey ?? process.env.PROVABLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing API key: pass options.apiKey or set PROVABLE_API_KEY");
  }
  const consumerId =
    options.consumerId ?? process.env.PROVABLE_CONSUMER_ID;
  if (!consumerId) {
    throw new Error("Missing consumer id: pass options.consumerId or set PROVABLE_CONSUMER_ID");
  }

  const networkClient = new AleoNetworkClient(host)
  networkClient.setProverUri(proverUri);
  networkClient.setRecordScannerUri(recordScannerUri);

  const keyString = typeof privateKey === "string" ? privateKey : privateKey.to_string();
  const account = new Account({ privateKey: keyString })

  const wallet: AleoWallet = {
    address: account.address().to_string(),

    decrypt: async (ciphertext) => {
      return account.decryptRecord(ciphertext).toString();
    },

    requestRecords: async (program, includePlaintext) => {
      const recordScanner = new RecordScanner({ url: recordScannerUri });
      recordScanner.setApiKey(apiKey!);
      recordScanner.setConsumerId(consumerId!);
      const regResult = await recordScanner.registerEncrypted(account.viewKey(), 0);
      if (!regResult.ok) {
        throw new Error(
          regResult.error?.message ?? `Record scanner registration failed: ${regResult.status}`,
        );
      }
      const records = await recordScanner.findRecords({
        uuid: regResult.data.uuid,
        unspent: true,
        filter: { programs: [program] },
      });
      return records.map((r) => ({
        ...r,
        recordCiphertext: r.record_ciphertext,
        recordPlaintext: includePlaintext ? r.record_plaintext : undefined,
      }));
    },

    executeTransaction: async (txOptions) => {
      const programManager = getProgramManager(sdk, host, account, networkClient);

      const imports = new Set(txOptions.imports ?? []);
      imports.add(txOptions.program);
      const programImports: Record<string, string> = {};
      for (const imported of imports) {
        programImports[imported] = await loadProgramSource(networkClient, imported);
      }

      let lastError: unknown;
      let provingClient = networkClient;
      for (let attempt = 1; attempt <= provingRetries(); attempt++) {
        try {
          // Rebuild the request on every attempt: DPS pubkey 401s leave a
          // consumed/stale ProvingRequest that will not succeed if
          // resubmitted as-is.
          const provingRequest = await programManager.provingRequest({
            programName: txOptions.program,
            functionName: txOptions.function,
            // The Provable SDK takes the priority fee in credits; the wallet
            // interface receives microcredits from StreamService.
            priorityFee: (txOptions.fee ?? 0) / 1_000_000,
            privateFee: txOptions.privateFee ?? false,
            ...(txOptions.feeRecord !== undefined ? { feeRecord: txOptions.feeRecord } : {}),
            inputs: txOptions.inputs,
            programImports,
            broadcast: true,
          });

          const response = await provingClient.submitProvingRequest({
            provingRequest,
            apiKey,
            consumerId,
          });

          const broadcast = response.broadcast_result;
          if (broadcast.status.toLowerCase() !== "accepted") {
            const detail = "message" in broadcast ? broadcast.message : undefined;
            throw new Error(
              `proving service failed to broadcast the transaction (status: ${broadcast.status})${detail ? `: ${detail}` : ""}`,
            );
          }

          return { transactionId: response.transaction.id };
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          const status =
            error && typeof error === "object" && "status" in error
              ? Number(error.status)
              : undefined;
          const pubkeyAuthError = isPubkeyAuthError(error);
          const retryable =
            pubkeyAuthError ||
            status === 500 ||
            status === 503 ||
            /503|ECONNRESET|ETIMEDOUT/.test(message);
          if (!retryable || attempt === provingRetries()) break;
          if (pubkeyAuthError) {
            // DPS 401 on /pubkey is often a sticky JWT/session. Drop the
            // cached token and use a fresh client.
            delete provingClient.jwtData;
            provingClient = new AleoNetworkClient(host);
            provingClient.setProverUri(proverUri);
            provingClient.setRecordScannerUri(recordScannerUri);
          }
          const delay = provingRetryDelay(attempt, pubkeyAuthError);
          console.warn(
            `[wallet] proving submit failed (attempt ${attempt}/${provingRetries()}); retrying in ${delay}ms`,
          );
          await sleep(delay);
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };

  return wallet;
}
