import dotenv from "dotenv";
import { setTimeout } from "node:timers/promises";
import {
    configNameToField,
    createAleoWallet,
    loadAleoSdk,
    resolvedNetwork,
    StreamClient,
} from "../sdk/index.js";

dotenv.config();

const NETWORK = resolvedNetwork();
const sdk = await loadAleoSdk(NETWORK);
await sdk.initThreadPool();

const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;

if (!PRIVATE_KEY) {
    console.error("ADMIN_PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}
const HOST = process.env.ENDPOINT ?? "https://api.provable.com/v2";
const CONFIRM_POLL_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 600_000;
const EXPLORER =
    NETWORK === "mainnet" ? "https://explorer.provable.com" : "https://testnet.explorer.provable.com";
console.log("Network:", NETWORK);
console.log("Host:", HOST);

const WHITELIST_TOKENS = process.env.WHITELIST_TOKENS
    ? process.env.WHITELIST_TOKENS.split(",").map((token) => token.trim()).filter(Boolean)
    : NETWORK === "mainnet"
        ? ["usdcx_stablecoin", "usad_stablecoin"]
        : ["test_usdcx_stablecoin", "test_usad_stablecoin"];

const wallet = await createAleoWallet(PRIVATE_KEY, { host: HOST, network: NETWORK });
const client = new StreamClient(wallet, { host: HOST, network: NETWORK });
const admin = wallet.address;
console.log("Admin address:", admin);
const CONFIG_NAME = configNameToField(`Stream_Config_001`);

const publicBalance = await client.networkClient.getPublicBalance(admin);
console.log("Public credits balance (microcredits):", publicBalance);
if (!publicBalance) {
    const fundHint =
        NETWORK === "mainnet"
            ? `Send public ALEO to this address on mainnet, wait until the explorer shows a non-zero public balance, then rerun.`
            : `Request testnet credits for this address at https://faucet.aleo.org/, wait until the explorer shows a non-zero public balance, then rerun.`;
    console.error(
        `Admin ${admin} has no public credits.aleo balance on ${NETWORK}, so public-fee admin transactions cannot be broadcast.\n` +
        `${fundHint}\n` +
        `Explorer: ${EXPLORER}/address/${admin}`,
    );
    process.exit(1);
}

async function waitForConfirmation(txId: string) {
    const confirmation = await client.networkClient.waitForTransactionConfirmation(
        txId,
        CONFIRM_POLL_MS,
        CONFIRM_TIMEOUT_MS,
    );
    const confirmationStatus = confirmation.status;
    if (confirmationStatus.toLowerCase() !== "accepted") {
        throw new Error(`Transaction ${txId} failed with status: ${confirmationStatus}`);
    }
}

async function initializeStreamConfig() {
    const txId = await client.initializeConfig(
        {
            configName: CONFIG_NAME,
            admin,
            feeVault: admin,
            withdrawer: admin,
            baseFee: "0", // 10_000 microcredits
            platformFee: "0", // 100_000 microcredits
        },
        { priorityFee: 100_000 },
    );
    console.log("Config Initialization transaction ID:", txId);
    await waitForConfirmation(txId);
    await setTimeout(10000);
    const config = await client.getStreamConfig(CONFIG_NAME);
    console.log("Initialized config:", config);
}

async function updateStreamConfig() {
    const txId = await client.updateConfig(
        {
            configName: CONFIG_NAME,
            admin,
            feeVault: admin,
            withdrawer: admin,
            baseFee: "0", // 0 microcredits
            platformFee: "0", // 0 microcredits
        },
        { priorityFee: 100_000 },
    );
    console.log("Config Update transaction ID:", txId);
    await waitForConfirmation(txId);
    const config = await client.getStreamConfig(CONFIG_NAME);
    console.log("Updated config:", config);
}

async function whitelistTokens() {
    const ALLOWED = true;

    for (const token of WHITELIST_TOKENS) {
        const txId = await client.setTokenWhitelisted(CONFIG_NAME, token, ALLOWED, {
            priorityFee: 100_000,
        });
        console.log(`Whitelist token ${token} transaction ID:`, txId);
        await waitForConfirmation(txId);
        await setTimeout(10000);
        const isWhitelisted = await client.isTokenWhitelisted(CONFIG_NAME, token);
        console.log(`Is token ${token} whitelisted?`, isWhitelisted);
    }
}

async function main() {
    await initializeStreamConfig();
    // await updateStreamConfig();
    await whitelistTokens();
}

await main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});
