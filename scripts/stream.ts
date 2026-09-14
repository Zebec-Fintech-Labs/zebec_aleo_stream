/**
 * Stream lifecycle script: create -> pause -> resume -> withdraw ->
 * cancel, against the `test_zebec_stream_v4.aleo` program on testnet.
 *
 * Transactions are executed through `createAleoWallet` — a Node `AleoWallet`
 * that proves via the delegated proving service and scans records via the
 * record scanner — so the script uses the exact same `StreamClient` API as
 * the browser app.
 *
 * Prerequisites:
 * - Config `Stream_Config_001` initialized (run `npm run admin` first) and
 *   `test_usdcx_stablecoin` whitelisted.
 * - The employer account (`SENDER_PRIVATE_KEY`) must hold unspent
 *   `test_usdcx_stablecoin.aleo` Token records covering the stream deposit
 *   plus the (token-denominated) stream fee, and a credits.aleo record
 *   covering the auto-withdrawal fee when auto-withdraw is enabled.
 * - The employee account (`RECEIVER_PRIVATE_KEY`) needs a small public credits
 *   balance for the withdraw priority fee. It must differ from the employer
 *   (the contract asserts `receiver != signer`).
 *
 * Environment variables:
 * - ADMIN_PRIVATE_KEY (required): config admin; signs the stream fee
 *   attestation (`StreamTokenFee`).
 * - SENDER_PRIVATE_KEY (required): employer/sender.
 * - RECEIVER_PRIVATE_KEY (required): employee who withdraws.
 * - PROVER_API_KEY / PROVER_CONSUMER_ID (required): delegated proving and
 *   record scanning credentials (see `createAleoWallet`).
 */

import { Field, initThreadPool } from "@provablehq/sdk/testnet.js";
import dotenv from "dotenv";
import { setTimeout } from "node:timers/promises";
import {
    computeStreamFee,
    configNameToField,
    createAleoWallet,
    fromMicroUnits,
    nowSeconds,
    StreamClient,
    signStreamTokenFee,
    type Config,
    type CreateStreamParams,
    type RawStreamTokenFee,
    type StreamTokenFee,
} from "../sdk/index.js";

dotenv.config();

await initThreadPool();

const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const SENDER_PRIVATE_KEY = process.env.SENDER_PRIVATE_KEY;
const RECEIVER_PRIVATE_KEY = process.env.RECEIVER_PRIVATE_KEY;

if (!ADMIN_PRIVATE_KEY) {
    console.error("ADMIN_PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}

if (!SENDER_PRIVATE_KEY) {
    console.error("SENDER_PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}

if (!RECEIVER_PRIVATE_KEY) {
    console.error("RECEIVER_PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}

const HOST = process.env.ENDPOINT ?? "https://api.explorer.provable.com/v1";

const senderWallet = await createAleoWallet(SENDER_PRIVATE_KEY, { host: HOST });
const receiverWallet = await createAleoWallet(RECEIVER_PRIVATE_KEY, { host: HOST });
const senderClient = new StreamClient(senderWallet, { host: HOST });
const receiverClient = new StreamClient(receiverWallet, { host: HOST });
const sender = senderWallet.address;
const receiver = receiverWallet.address;
console.log("Sender (employer) address:", sender);
console.log("Receiver (employee) address:", receiver);

if (sender === receiver) {
    console.error("SENDER_PRIVATE_KEY and RECEIVER_PRIVATE_KEY must be different accounts.");
    process.exit(1);
}

const CONFIG_NAME = configNameToField("Stream_Config_001");
const TOKEN_PROGRAM = "test_usdcx_stablecoin";
const TOKEN_DECIMALS = 6;
const TOKEN_PRICE_USD = 1_000_000n; // $1.00 per token, 6 decimals (used for off-chain fee quote only)
const PRIORITY_FEE = 100_000; // 0.1 ALEO, in microcredits

const STREAM_PARAMS: CreateStreamParams = {
    receiver,
    streamId: randomField(),
    amount: "2", // 2 USDCx
    startTime: 0n, // ignored: startNow is true
    duration: 10 * 60, // 10 minutes
    isCancelable: true,
    isPausable: true,
    autoWithdrawable: false,
    withdrawFrequency: 0,
    startNow: true,
    canTopup: false,
    initialBufferAmount: "0",
};

/** Random 128-bit field value (stream ids / fee nonces). */
export function randomField(): bigint {
    const bytes = Field.random().toBytesLe();
    return BigInt(
        "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    );
}

async function waitForConfirmation(txId: string) {
    const confirmation = await senderClient.networkClient.waitForTransactionConfirmation(txId, 2_000, 600_000);
    const confirmationStatus = confirmation.status;
    if (confirmationStatus.toLowerCase() !== "accepted") {
        throw new Error(`Transaction ${txId} failed with status: ${confirmationStatus}`);
    }
}

/** Read the on-chain stream config in the human form the client expects. */
async function getConfigInput(): Promise<Config> {
    return senderClient.getStreamConfig(CONFIG_NAME);
}

/**
 * Build a fresh admin-signed `StreamTokenFee` attestation: the raw (micro-unit)
 * form for the Schnorr signature and the human form for the client.
 */
function createSignedTokenFee(streamAmountMicro: bigint): {
    tokenFee: StreamTokenFee;
    signature: string;
} {
    const { streamFee } = computeStreamFee(streamAmountMicro, TOKEN_PRICE_USD);
    const rawFee: RawStreamTokenFee = {
        config: CONFIG_NAME,
        streamToken: TOKEN_PROGRAM,
        streamFeeAmount: streamFee,
        streamAmount: streamAmountMicro,
        expiry: nowSeconds() + 3600n,
        nonce: randomField(),
    };
    const tokenFee: StreamTokenFee = {
        ...rawFee,
        streamFeeAmount: fromMicroUnits(streamFee, TOKEN_DECIMALS),
        streamAmount: fromMicroUnits(streamAmountMicro, TOKEN_DECIMALS),
    };
    return { tokenFee, signature: signStreamTokenFee(ADMIN_PRIVATE_KEY!, rawFee) };
}

async function createStreamPrivate(): Promise<string | bigint> {
    const params = STREAM_PARAMS;
    console.log("streamId:", params.streamId);
    const config = await getConfigInput();
    const { tokenFee, signature } = createSignedTokenFee(
        2_000_000n, // params.amount in micro units
    );
    console.log(`Stream fee: ${tokenFee.streamFeeAmount} token units`);

    const txId = await senderClient.createStreamPrivate(
        params,
        TOKEN_PROGRAM,
        TOKEN_DECIMALS,
        config,
        tokenFee,
        signature,
        { priorityFee: PRIORITY_FEE },
    );
    console.log("Create stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(params.streamId);
    console.log("Created stream anchor:", anchor);
    return params.streamId;
}

async function createStreamPublic(): Promise<string | bigint> {
    const params = STREAM_PARAMS;
    console.log("streamId:", params.streamId);
    const config = await getConfigInput();
    const { tokenFee, signature } = createSignedTokenFee(2_000_000n);
    console.log(`Public stream fee: ${tokenFee.streamFeeAmount} token units`);
    // `create_stream_public` pulls both the deposit and the (token-denominated)
    // stream fee via `transfer_from_public`, so the stream program must be
    // approved as the spender for the combined amount first.
    const requiredAllowance = String(Number(params.amount) + Number(tokenFee.streamFeeAmount));
    const programAddress = await senderClient.programAddress();
    const approveTxId = await senderClient.approveTokenPublic(
        TOKEN_PROGRAM,
        programAddress,
        requiredAllowance,
        TOKEN_DECIMALS,
        { priorityFee: PRIORITY_FEE },
    );
    console.log("Approved stream program to spend tokens:", approveTxId);
    await waitForConfirmation(approveTxId);

    const txId = await senderClient.createStreamPublic(
        params,
        TOKEN_PROGRAM,
        TOKEN_DECIMALS,
        config,
        tokenFee,
        signature,
        { priorityFee: PRIORITY_FEE },
    );
    console.log("Create public stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(params.streamId);
    const stream = await senderClient.getStream(params.streamId);
    console.log("Created public stream anchor:", anchor);
    console.log("Created public stream stream:", stream);
    return params.streamId;
}

async function pauseStream(streamId: string | bigint) {
    const txId = await senderClient.pauseResumeStreamPrivate({ streamId }, { priorityFee: PRIORITY_FEE });
    console.log("Pause stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Stream paused?", anchor.paused, "at", anchor.lastPausedTime);
}

async function resumeStream(streamId: string | bigint) {
    const txId = await senderClient.pauseResumeStreamPrivate({ streamId }, { priorityFee: PRIORITY_FEE });
    console.log("Resume stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Stream paused?", anchor.paused, "paused interval:", anchor.pausedInterval);
}

async function pauseStreamPublic(streamId: string | bigint) {
    const txId = await senderClient.pauseResumeStreamPublic({ streamId }, { priorityFee: PRIORITY_FEE });
    console.log("Pause public stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Public stream paused?", anchor.paused, "at", anchor.lastPausedTime);
}

async function resumeStreamPublic(streamId: string | bigint) {
    const txId = await senderClient.pauseResumeStreamPublic({ streamId }, { priorityFee: PRIORITY_FEE });
    console.log("Resume public stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Public stream paused?", anchor.paused, "paused interval:", anchor.pausedInterval);
}

async function withdraw(streamId: string | bigint) {
    const preview = await receiverClient.getWithdrawableAmounts(streamId);
    console.log("Withdrawable preview:", preview);
    const txId = await receiverClient.withdrawStreamPrivate({ streamId }, { priorityFee: PRIORITY_FEE });
    console.log("Withdraw transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await receiverClient.getStreamAnchor(streamId);
    console.log("Withdrawn amount:", anchor.withdrawnAmount);
}

async function withdrawPublic(streamId: string | bigint) {
    const preview = await receiverClient.getWithdrawableAmounts(streamId);
    console.log("Public withdrawable preview:", preview);
    const txId = await receiverClient.withdrawStreamPublic({ streamId }, { priorityFee: PRIORITY_FEE });
    console.log("Withdraw public stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await receiverClient.getStreamAnchor(streamId);
    console.log("Public withdrawn amount:", anchor.withdrawnAmount);
}

async function cancelStream(streamId: string | bigint) {
    const txId = await senderClient.cancelStreamPrivate({ streamId }, { priorityFee: PRIORITY_FEE });
    console.log("Cancel stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Stream canceled?", anchor.canceled, "at", anchor.canceledAt);
}

async function cancelStreamPublic(streamId: string | bigint) {
    const txId = await senderClient.cancelStreamPublic({ streamId }, { priorityFee: PRIORITY_FEE });
    console.log("Cancel public stream transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(60000);
    const anchor = await senderClient.getStreamAnchor(streamId);
    console.log("Public stream canceled?", anchor.canceled, "at", anchor.canceledAt);
}

async function main() {
    const publicMode = process.env.PUBLIC_STREAM === "1";
    console.log(publicMode ? "Public mode is enabled." : "Private mode is enabled.");
    let start = Date.now();
    const streamId = publicMode ? await createStreamPublic() : await createStreamPrivate();
    let end = Date.now();
    console.log(`Stream creation took ${(end - start) / 1000} seconds`);
    await setTimeout(5_000);
    console.log("Pausing stream...");
    start = Date.now();
    if (publicMode) {
        await pauseStreamPublic(streamId);
    } else {
        await pauseStream(streamId);
    }
    end = Date.now();
    console.log(`Stream pause took ${(end - start) / 1000} seconds`);
    await setTimeout(5_000);
    console.log("Resuming stream...");
    start = Date.now();
    if (publicMode) {
        await resumeStreamPublic(streamId);
    } else {
        await resumeStream(streamId);
    }
    end = Date.now();
    console.log(`Stream resume took ${(end - start) / 1000} seconds`);
    await setTimeout(5_000);
    console.log("Withdrawing from stream...");
    start = Date.now();
    if (publicMode) {
        await withdrawPublic(streamId);
    } else {
        await withdraw(streamId);
    }
    end = Date.now();
    console.log(`Stream withdraw took ${(end - start) / 1000} seconds`);
    await setTimeout(5_000);
    console.log("Canceling stream...");
    start = Date.now();
    if (publicMode) {
        await cancelStreamPublic(streamId);
    } else {
        await cancelStream(streamId);
    }
    end = Date.now();
    console.log(`Stream cancel took ${(end - start) / 1000} seconds`);
    console.log("Stream lifecycle completed successfully.");
    console.log("Stream created with ID:", streamId);
}

await main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});
