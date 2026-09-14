# Fetching Streams On-Chain (Production Guide)

How to discover and read **public** and **private** streams created by
`test_zebec_stream_v4.aleo` from the browser, via the Shield wallet
(`app/src/stream/WalletStreamService.ts`) and `AleoNetworkClient` mapping
reads.

---

## 1. Where stream state lives

The program is a hybrid: coordination state is public in mappings; sensitive
state lives in encrypted records owned by the participants.

### Public (readable by anyone)

| Mapping | Key | Value | Written by |
| --- | --- | --- | --- |
| `stream_anchors` | `stream_id: field` | `StreamAnchor` | every create/lifecycle fn |
| `streams` | `stream_id: field` | `Stream` | `create_stream_public`, `topup_stream_public` only |
| `stream_configs` | `config: field` | `StreamConfig` | admin |
| `whitelisted_token_programs` | `BHP256(WhitelistKey)` | `bool` | admin |
| `outgoing_stream_counts` | `BHP256(StreamCountKey)` | `u64` | `create_stream_public` only |
| `incoming_stream_counts` | `BHP256(StreamCountKey)` | `u64` | `create_stream_public` only |
| `outgoing_stream_refs` | `BHP256(StreamRefKey)` | `stream_id: field` | `create_stream_public` only |
| `incoming_stream_refs` | `BHP256(StreamRefKey)` | `stream_id: field` | `create_stream_public` only |

`StreamCountKey` (the per-address, per-config count key):

```
account: address, config: field
```

`StreamRefKey` (the per-address, per-config registry slot key):

```
account: address, config: field, index: u64
```

The two `*_stream_counts` mappings track how many public streams an address has
ever created (sender) or received (receiver) **under a given config**. For
each, the corresponding `*_stream_refs` mapping is keyed by
`BHP256(StreamRefKey { account, config, index })` and holds the `stream_id` at
that slot — an **append-only** list. Canceled or
ended streams are *not* removed; filter them client-side via the anchor (§5).
Self-streams (sender == receiver) appear in both registries.

> This registry is only populated for **public** streams. Private-mode streams
> never write sender/receiver to public state — list those by scanning ticket
> records (§3/§4.2).

`StreamAnchor` (declaration order matters — see §5):

```
stream_id: field, start_time: i64, duration: u64,
paused: bool, canceled: bool, canceled_at: i64,
deposited_amount: u128, last_paused_time: i64, paused_interval: u64,
withdrawn_amount: u128, is_public: bool, created_timestamp: i64
```

`Stream` (public streams only):

```
stream_id: field, config: field, sender: address, receiver: address,
full_amount: u128, token_program: identifier,
is_cancelable: bool, is_pausable: bool, auto_withdrawable: bool,
can_topup: bool, topup_count: u64
```

**Key point:** even for *private* streams the `stream_anchors` entry exists and
is public — but it deliberately omits sender, receiver, salary, schedule, and
token program. Only existence + status (`paused`, `canceled`,
`deposited_amount`, `withdrawn_amount`) leak. The sensitive fields live only in
encrypted ticket records.

### Private (encrypted records)

Every stream mints three ticket records at creation, distinguished by
`ticket_type`:

| Record | `ticket_type` | Owner | Holds |
| --- | --- | --- | --- |
| `SenderStreamTicket` | 0 | employer | receiver, full_amount, permissions, topup_count |
| `ReceiverStreamTicket` | 1 | employee | sender, full_amount, auto_withdrawable |
| `WithdrawerStreamTicket` | 2 | authorized withdrawer | both addresses, full_amount |

Lifecycle behavior to keep in mind when reading state:

- `withdraw_stream_private` / `withdraw_stream_auto_private` consume and
  re-emit the receiver/withdrawer ticket (**new nonce each time** — old
  ciphertexts stay on chain forever as spent records).
- `pause_resume_stream_private` re-emits the sender ticket unchanged.
- `topup_stream_private` re-emits the sender ticket with `topup_count + 1`.
- `cancel_stream_private` **burns** the sender ticket; the receiver/withdrawer
  tickets remain unspent but inert (every lifecycle entry asserts
  `!canceled` from the anchor).
- Public-mode lifecycle functions write only to mappings — no records move.

---

## 2. Fetching a known public stream

If you know the `stream_id` (a `field`), everything is two mapping reads plus
off-chain math. No keys required.

```ts
import { AleoNetworkClient } from "@provablehq/sdk/mainnet.js"; // or /testnet.js
import {
  parseStreamAnchor, parseStream, computeWithdrawableAmount,
} from "../sdk/index.js";

const client = new AleoNetworkClient(network);
const PROGRAM = "test_zebec_stream_v4.aleo";
const key = `${streamId}field`; // plaintext literal form

const anchor = parseStreamAnchor(
  await client.getProgramMappingValue(PROGRAM, "stream_anchors", key),
);

if (anchor.isPublic) {
  const stream = parseStream(
    await client.getProgramMappingValue(PROGRAM, "streams", key),
  );
}

// Live amounts (sdk/math.ts): elapsed = min(now,end) - start - paused_durations
// withdrawable = rate * elapsed - withdrawn
const { withdrawable } = computeWithdrawableAmount(anchor, nowSec);
```

Equivalent one-liners already exist in `WalletStreamService`
(`app/src/stream/WalletStreamService.ts`):
`getStreamAnchor(id)`, `getStream(id)`, `getWithdrawableAmounts(id)` — plus
program previews for local/off-chain queries:
  `view fn get_stream(field) -> Stream`, `view fn get_stream_anchor(field) -> StreamAnchor`

For **listing** public streams by address, see §4.1 — the registries below
make this possible without walking the chain.

---

## 3. Fetching a private stream

Private streams need two things per participant:

1. **Anchor** — same public mapping read as §2 (status only).
2. **Ticket record** — decrypted with the owner's view key; this is where
   `full_amount`, counterparty, and permissions come from. Without the ticket
   you cannot reconstruct the vesting curve for a private stream.

### 3. Browser (Shield wallet)

Records-via-wallet pattern (`WalletStreamService.decryptProgramRecords`):

```ts
const envelopes = await wallet.requestRecords(PROGRAM, false); // false = include plaintext filter
for (const e of envelopes.filter((e) => e.spent === false)) {
  const text = (await wallet.decrypt(e.recordCiphertext))
    .replace(/\s+/g, " ").trim();           // single-line plaintext
}
```

Then classify structurally (decrypted plaintexts carry no record name):

```ts
const type = Number(text.match(/ticket_type:\s*(\d+)u8/)?.[1]);   // 0|1|2
const sid  = text.match(/stream_id:\s*(\d+)field/)?.[1];
```

Existing helpers: `findTicket(recordName, streamId)` and
**`listMyTickets()`** which enumerates every unspent ticket the wallet owns,
plus `listMyPrivateStreams()` which collapses them into `(stream_id, direction)`
entries — the employee-facing "list my streams" for private-mode streams.

Notes:

- The wallet proves ownership via its GraphKey internally; never handle raw view keys in the browser.
- Always filter `spent === false`: consumed tickets (e.g. after every private
  withdrawal) still decrypt fine and will double-count if included.
- Pick the highest-value credit/token record covering the minimum, not merely
  the first (`findCredits` in `WalletStreamService`).

---

## 4. Discovering streams

Mapping enumeration is still impossible on-chain (`get`/`get_or_use` only),
but the per-address registries (§1) now make **public** streams listable by
sender/receiver without a chain-walking indexer. Private streams continue to
be discovered only through wallet-held ticket records (§4.2).

### 4.1 Public streams — the on-chain registries

For a given `account` and `config`, read the count then each ref slot:

```ts
import { streamCountKey, streamRefKey } from "../sdk/index.js";

async function listPublicStreamIds(client, PROGRAM, account, config, direction) {
  const count = BigInt(
    await client.getProgramMappingValue(
      PROGRAM,
      `${direction}_stream_counts`,
      streamCountKey(account, config), // BHP256 hash of StreamCountKey{account,config}
    ),
  );
  const ids = [];
  for (let i = 0n; i < count; i++) {
    const ref = await client.getProgramMappingValue(
      PROGRAM,
      `${direction}_stream_refs`,
      streamRefKey(account, config, i), // BHP256 hash of StreamRefKey{account,config,index}
    );
    ids.push(ref); // "0field" only if the slot is unset (shouldn't happen)
  }
  return ids; // direction: "outgoing" (sender) | "incoming" (receiver)
}
```

`streamCountKey(account, config)` / `streamRefKey(account, config, index)`
reproduce the on-chain `BHP256::hash_to_field` keys; their derivation is
covered by SDK parity tests. Hydrate each id with
`getStreamAnchor` / `getStream` (§2). `WalletStreamService.listMyPublicStreams()`
and `StreamClient.listPublicStreams(config)` (scoped to the connected wallet)
already do this and merge the
two directions into one list with `direction: outgoing | incoming | both`.

Sample the new view functions directly:

```
view fn get_outgoing_stream_count(account, config) -> u64
view fn get_incoming_stream_count(account, config) -> u64
view fn get_outgoing_stream_ref(account, config, index) -> field   // 0field if unset
view fn get_incoming_stream_ref(account, config, index) -> field
```

Notes:
- The lists are **append-only**: canceled and ended streams remain and must be
  filtered client-side (`anchor.canceled`, `anchor.withdrawn_amount >= stream.fullAmount`).
- **Self-streams** (sender == receiver) appear in both `outgoing` and `incoming`.
- Only **public** streams are indexed; private-mode streams never touch these
  mappings.

### 4.2 Private streams — wallet ticket scan

No on-chain index exists for private streams by design. Discovery goes through
the wallet's unspent ticket records, enumerated by `listMyTickets()` (sender
tickets ⇒ outgoing, receiver tickets ⇒ incoming). `WalletStreamService.listMyPrivateStreams()`
returns them deduped per `(stream_id, direction)`, with the decrypted ticket
plaintext for counterparty/amount. Re-read the anchor per id and treat
`anchor.canceled == true` as terminal (the sender ticket is burned on cancel).
Withdrawer tickets (`ticket_type 2`) mirror an existing stream and are skipped
from the list.

### 4.3 Other discovery options

1. **Your own backend registry (still recommended for scale).** At creation
   time persist `(stream_id, role, mode, txId, parties)`; the on-chain registry
   covers public-only queries, but a backend gives audit history, pagination,
   and private-stream coverage in one place.
2. **Chain-walking indexer (fallback/compliance).** Every create emits
   transitions visible in blocks; a full-node indexer can extract
   `finalize_create_stream` writes to `stream_anchors`. For public streams the
   `streams` entries (and now the registry mappings) give full detail; for
   private streams you can index `(stream_id → anchor status)` but **cannot**
   recover parties or amounts — by design. Respect the privacy model: any
   indexer must not attempt to correlate private-stream timing/addresses into a
   public UI.

---

## 5. Reconstructing live state correctly

Given `anchor` (+ `stream` for public, or the decrypted ticket for private):

```
end_time   = start_time + duration + banked paused extensions
elapsed    = min(now, end_time) - start_time - paused_interval(s)
accrued    = rate_per_sec * elapsed            // rate = amount / duration
withdrawable = accrued - withdrawn_amount      // capped by funded buffer
```

Reference implementation: `computeWithdrawableAmount` (`sdk/math.ts`),
exposed as `getWithdrawableAmounts(streamId, now?, fullAmount?)` in
`WalletStreamService`. Accrual is uncapped; the payout is capped at the funded
remainder (`deposited_amount - withdrawn_amount`) — for buffer-mode streams,
accrued-but-unfunded amounts stay locked until a top-up — surface that in UI
rather than letting the tx revert.

Rules that will bite you if ignored:

- **Struct member order is consensus-critical.** Mapping values and signed
  structs are hashed as bits in Leo declaration order
  (`BHP256::hash_to_field`). This includes `StreamCountKey` / `StreamRefKey`
  (the registry keys), whose `account, config` / `account, config, index`
  order must match the SDK's `streamCountKey()` / `streamRefKey()` — covered
  by parity tests under `sdk-tests/unit/hashing.test.ts`. Never reorder fields
  in `sdk/plaintext.ts` emitters/parsers without regenerating vectors.
- **Private lifecycle fns take caller-supplied anchor snapshots** asserted
  equal on-chain (`assert_stream_anchor_eq`). Always fetch the anchor
  immediately before building the tx; a stale snapshot fails the proof after
  you've paid synthesis fees.
- **Spent vs unspent**: always exclude spent tickets; each withdrawal rotates
  the receiver ticket's nonce.
- **Cancelled streams**: sender ticket no longer exists; receiver/withdrawer
  tickets decrypt but every entry asserts `!canceled` — read `canceled` from
  the anchor before offering any action.

---

## 6. Quick reference

| Task | Tool |
| --- | --- |
| Read anchor / stream by id | `getProgramMappingValue` + `parseStreamAnchor` / `parseStream` |
| Preview amounts | `getWithdrawableAmounts(streamId)`, `view fn get_stream` |
| List public streams for the connected wallet | `listPublicStreams(config)` / `listMyPublicStreams()` (registries, §4.1) |
| Find my tickets | `wallet.requestRecords(prog, false)` → decrypt → classify `ticket_type` |
| List private streams for a wallet | `listMyPrivateStreams()` (record scan, §4.2) |
| List all streams (public + private) | `listMyStreams()` |
| Token/config checks | `isTokenWhitelisted`, `getStreamConfig` |
