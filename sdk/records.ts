/**
 * Helpers for locating unspent records needed by `test_zebec_stream_v4.aleo`
 * transitions: `credits.aleo` records for fees, IARC22 token records for
 * stream deposits, and stream ticket records for stream management.
 */

import type { AleoNetworkClient, RecordPlaintext } from "@provablehq/sdk";

import { matchesTicketRecord } from "./plaintext.js";
import type { TicketRecordName } from "./plaintext.js";

export { matchesTicketRecord } from "./plaintext.js";
export type { TicketRecordName } from "./plaintext.js";

const CREDITS_PROGRAM = "credits.aleo";

/**
 * Nonces collected during scans are persisted under `.nonce-cache/`, one
 * JSON file per program (e.g. `.nonce-cache/credits.aleo.json`), so later
 * scans pass them to `findUnspentRecords` and skip those records instead of
 * re-collecting them. Note that a cached record is excluded from every
 * future scan of that program, whatever the `match` criteria — delete the
 * cache file to make those records scannable again.
 *
 * `node:fs` is imported lazily inside the cache helpers so this module stays
 * importable from browser bundles (wallet mode never scans the chain).
 */
const NONCE_CACHE_DIR = ".nonce-cache";

function nonceCacheFile(programs: string[]): string {
  return `${NONCE_CACHE_DIR}/${programs.join("+")}.json`;
}

async function loadNonceCache(file: string): Promise<string[]> {
  try {
    const fs = await import("node:fs");
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((nonce): nonce is string => typeof nonce === "string");
  } catch {
    return [];
  }
}

async function saveNonceCache(file: string, nonces: string[]): Promise<void> {
  const fs = await import("node:fs");
  fs.mkdirSync(NONCE_CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(nonces, null, 2)}\n`);
}

/**
 * `AleoNetworkClient.findUnspentRecords` walks the chain backwards in
 * 50-block HTTP requests, firing them as fast as the network answers. The
 * public explorer API rate-limits that pattern (HTTP 429) and also returns
 * transient 5xx errors; the SDK's own retries fire instantly, which makes
 * the limiting worse. The scan below therefore wraps the client's HTTP
 * methods with a gate that paces requests and retries failures with
 * exponential backoff, and it stops as soon as a matching record is found.
 */
const SCAN_WINDOW_BLOCKS = 500;
const SCAN_MAX_ATTEMPTS = 6;
const SCAN_BASE_DELAY_MS = 2_000;
const REQUEST_INTERVAL_MS = 250;
const HEIGHT_CACHE_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Shared gate so concurrent scans stay below the explorer's rate limit.
let lastRequestAt = 0;

/** Run `fn` paced to `REQUEST_INTERVAL_MS`, retrying failures with backoff. */
async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SCAN_MAX_ATTEMPTS; attempt++) {
    const wait = Math.max(0, lastRequestAt + REQUEST_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    try {
      const result = await fn();
      lastRequestAt = Date.now();
      return result;
    } catch (error) {
      lastRequestAt = Date.now();
      lastError = error;
      if (attempt < SCAN_MAX_ATTEMPTS) {
        const backoff = SCAN_BASE_DELAY_MS * 2 ** (attempt - 1);
        await sleep(backoff + Math.floor(Math.random() * backoff));
      }
    }
  }
  throw lastError;
}

/**
 * Replace the client's raw HTTP methods with paced, retrying versions for
 * the duration of `fn`. `getLatestHeight` is additionally cached because
 * `findUnspentRecords` re-fetches it on every call. Methods are restored
 * before returning, even on error.
 */
async function withPacedClient<T>(
  networkClient: AleoNetworkClient,
  fn: () => Promise<T>,
): Promise<T> {
  const getBlockRange = networkClient.getBlockRange.bind(networkClient);
  const getLatestHeight = networkClient.getLatestHeight.bind(networkClient);
  const getTransitionId = networkClient.getTransitionId.bind(networkClient);
  let cachedHeight: { value: number; at: number } | undefined;
  networkClient.getBlockRange = (start, end) => throttled(() => getBlockRange(start, end));
  networkClient.getTransitionId = (inputOrOutputID) =>
    throttled(() => getTransitionId(inputOrOutputID));
  networkClient.getLatestHeight = () => {
    if (cachedHeight !== undefined && Date.now() - cachedHeight.at < HEIGHT_CACHE_MS) {
      return Promise.resolve(cachedHeight.value);
    }
    return throttled(async () => {
      const value = await getLatestHeight();
      cachedHeight = { value, at: Date.now() };
      return value;
    });
  };
  try {
    return await fn();
  } finally {
    networkClient.getBlockRange = getBlockRange;
    networkClient.getLatestHeight = getLatestHeight;
    networkClient.getTransitionId = getTransitionId;
  }
}

export interface RecordScanOptions {
  /**
   * Do not scan below this block height (defaults to 0, i.e. full history).
   * Set it (e.g. to `latestHeight - 100_000`) only when every record of
   * interest is known to be younger than that bound.
   */
  minHeight?: number;
}

/**
 * Scan the chain backwards from the latest block, window by window, and
 * return the first (i.e. newest) unspent record of `programs` owned by the
 * account behind `privateKey` that satisfies `match`. Returns `undefined`
 * when the whole range down to `options.minHeight` was scanned without a
 * match.
 */
async function scanForRecord(
  networkClient: AleoNetworkClient,
  privateKey: string,
  programs: string[],
  match: (record: RecordPlaintext) => boolean,
  options: RecordScanOptions = {},
): Promise<RecordPlaintext | undefined> {
  const floor = options.minHeight ?? 0;
  return withPacedClient(networkClient, async () => {
    let end = await networkClient.getLatestHeight();
    // Nonces of records already collected, so retried windows skip them.
    // Seeded from the per-program cache and persisted as the scan progresses.
    const cacheFile = nonceCacheFile(programs);
    const nonces: string[] = await loadNonceCache(cacheFile);
    while (end > floor) {
      const start = Math.max(floor, end - SCAN_WINDOW_BLOCKS);
      const records = await networkClient.findUnspentRecords(
        start,
        end,
        programs,
        undefined,
        undefined,
        nonces,
        privateKey,
      );
      for (const record of records) {
        nonces.push(record.nonce());
        if (match(record)) {
          await saveNonceCache(cacheFile, nonces);
          return record;
        }
      }
      await saveNonceCache(cacheFile, nonces);
      end = start;
    }
    return undefined;
  });
}

/**
 * `microcredits:`/`amount:` style member extraction from a record plaintext
 * (or anything stringifyable to one, e.g. a `RecordPlaintext`).
 */
export function recordAmount(
  record: RecordPlaintext | string,
  member: string,
): bigint | undefined {
  const text = typeof record === "string" ? record : record.toString();
  const match = new RegExp(`${member}:\\s*(\\d+)(?:u64|u128)`).exec(text);
  return match ? BigInt(match[1]!) : undefined;
}

/**
 * Find an unspent `credits.aleo` record with at least `minMicrocredits`.
 * Used for the `credit_input_record` of `create_stream_private` (and as a
 * fee record when paying fees privately).
 */
export async function findCreditsRecord(
  networkClient: AleoNetworkClient,
  privateKey: string,
  minMicrocredits: bigint,
  options: RecordScanOptions = {},
): Promise<RecordPlaintext> {
  const record = await scanForRecord(
    networkClient,
    privateKey,
    [CREDITS_PROGRAM],
    (candidate) => {
      const microcredits = recordAmount(candidate, "microcredits");
      return microcredits !== undefined && microcredits >= minMicrocredits;
    },
    options,
  );
  if (record === undefined) {
    throw new Error(
      `no unspent credits.aleo record with at least ${minMicrocredits} microcredits`,
    );
  }
  return record;
}

/**
 * Find an unspent token record of the given IARC22 token program with at
 * least `minAmount`. Used for the `token_input_record` of
 * `create_stream_private`.
 */
export async function findTokenRecord(
  networkClient: AleoNetworkClient,
  privateKey: string,
  tokenProgramId: string,
  minAmount: bigint,
  options: RecordScanOptions = {},
): Promise<RecordPlaintext> {
  const record = await scanForRecord(
    networkClient,
    privateKey,
    [tokenProgramId],
    (candidate) => {
      if (!candidate.toString().includes("owner:")) return false;
      const amount = recordAmount(candidate, "amount");
      return amount !== undefined && amount >= minAmount;
    },
    options,
  );
  if (record === undefined) {
    throw new Error(
      `no unspent token record in ${tokenProgramId} with at least ${minAmount}`,
    );
  }
  return record;
}

/**
 * Find the unspent stream ticket record of `recordName` for `streamId`
 * owned by the account behind `privateKey`. Throws if not found.
 */
export async function findTicketRecord(
  networkClient: AleoNetworkClient,
  privateKey: string,
  programId: string,
  recordName: TicketRecordName,
  streamId: string | bigint,
  options: RecordScanOptions = {},
): Promise<RecordPlaintext> {
  const idDigits = streamId.toString().replace(/field$/, "");
  const record = await scanForRecord(
    networkClient,
    privateKey,
    [programId],
    (candidate) => {
      const text = candidate.toString();
      return (
        matchesTicketRecord(text, recordName) &&
        new RegExp(`stream_id:\\s*${idDigits}field`).test(text)
      );
    },
    options,
  );
  if (record === undefined) {
    throw new Error(`no ${recordName} record found for stream ${idDigits}`);
  }
  return record;
}
