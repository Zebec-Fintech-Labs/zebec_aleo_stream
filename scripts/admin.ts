import { initThreadPool } from "@provablehq/sdk/testnet.js";
import dotenv from "dotenv";
import { setTimeout } from "node:timers/promises";
import {
    configNameToField,
    createAleoWallet,
    StreamClient,
} from "../sdk/index.js";

dotenv.config();

await initThreadPool();

const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;

if (!ADMIN_PRIVATE_KEY) {
    console.error("ADMIN_PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}
const HOST = process.env.ENDPOINT ?? "https://api.explorer.provable.com/v1";

const wallet = await createAleoWallet(ADMIN_PRIVATE_KEY, { host: HOST });
const client = new StreamClient(wallet, { host: HOST });
const admin = wallet.address;
console.log("Admin address:", admin);
const CONFIG_NAME = configNameToField(`Stream_Config_001`);

async function waitForConfirmation(txId: string) {
    const confirmation = await client.networkClient.waitForTransactionConfirmation(txId, 2_000, 60_000);
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
            baseFee: "0", // 0 microcredits
            platformFee: "0", // 0 microcredits
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
    const TOKENS = ["test_usdcx_stablecoin", "test_usad_stablecoin"];
    const ALLOWED = true;

    for (const token of TOKENS) {
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
