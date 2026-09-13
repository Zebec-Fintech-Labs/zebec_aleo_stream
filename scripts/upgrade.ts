import dotenv from "dotenv";
import path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

dotenv.config();

const NETWORK = (process.env.NETWORK ?? "testnet").trim().toLowerCase();
if (NETWORK !== "mainnet" && NETWORK !== "testnet") {
    console.error(`Unsupported NETWORK="${NETWORK}". Set NETWORK=mainnet or NETWORK=testnet.`);
    process.exit(1);
}

const { Account, AleoKeyProvider, initThreadPool, ProgramManager } =
    NETWORK === "mainnet"
        ? await import("@provablehq/sdk/mainnet.js")
        : await import("@provablehq/sdk/testnet.js");

await initThreadPool();

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
    console.error("PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}
const HOST = process.env.ENDPOINT ?? "https://api.provable.com/v2";
const CONFIRM_POLL_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 600_000;
const EXPLORER =
    NETWORK === "mainnet" ? "https://explorer.provable.com" : "https://testnet.explorer.provable.com";
console.log("Network:", NETWORK);
console.log("Host:", HOST);

const here = path.dirname(fileURLToPath(import.meta.url));
// console.log("Current directory:", here);
const PROGRAM_ID = JSON.parse(
    fs.readFileSync(path.resolve(here, "../program.json"), "utf8"),
)["program"] as string;
const PROGRAM_IDENTIFIER = PROGRAM_ID.split(".aleo")[0];
const PROGRAM_SOURCE = fs.readFileSync(
    path.resolve(here, `../build/${PROGRAM_IDENTIFIER}/${PROGRAM_ID}`),
    "utf8",
);
console.log("Program id:", PROGRAM_ID);
// console.log("Program source loaded:\n", PROGRAM_SOURCE, "\n");

const account = new Account({ privateKey: PRIVATE_KEY });
const deployer = account.address().to_string();
console.log("Deployer:", deployer);

// Create a network client to connect to the Aleo network.
// const networkClient = new AleoNetworkClient(HOST);
// Create a key provider that will be used to find public proving & verifying keys for Aleo programs.
const keyProvider = new AleoKeyProvider();
keyProvider.useCache(true);
// Initialize a program manager to talk to the Aleo network with the configured key provider.
const programManager = new ProgramManager(HOST, keyProvider);
// Set the account for the program manager.
programManager.setAccount(account);
// const imports = await networkClient.getProgramImports(PROGRAM_SOURCE);
// console.log("Program imports:", imports);

const publicBalance = await programManager.networkClient.getPublicBalance(deployer);
console.log("Public credits balance (microcredits):", publicBalance);
if (!publicBalance) {
    const fundHint =
        NETWORK === "mainnet"
            ? `Send public ALEO to this address on mainnet and rerun.`
            : `Request testnet credits for this address at https://faucet.aleo.org/ and rerun.`;
    console.error(
        `Deployer ${deployer} has no public credits.aleo balance on ${NETWORK}, so a public-fee upgrade cannot be broadcast.\n` +
        `${fundHint}\n` +
        `Explorer: ${EXPLORER}/address/${deployer}`,
    );
    process.exit(1);
}

// Define a fee to pay to deploy the program
const fee = 1;
// Build a upgrade transaction for the program.
const tx = await programManager.buildUpgradeTransaction({
    program: PROGRAM_SOURCE,
    priorityFee: fee,
    privateFee: false,
});
const transactionId = tx.id();
console.log("Built upgrade transaction:", transactionId);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function submitUpgrade(): Promise<string> {
    while (true) {
        try {
            const submittedId = await programManager.networkClient.submitTransaction(tx);
            console.log("Submitted transaction:", submittedId);
            return submittedId;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes(`Transaction '${transactionId}' already exists in the ledger`)) {
                console.log("Transaction already exists in the ledger.");
                return transactionId;
            }
            if (
                message.includes("payer account balance is missing") ||
                message.includes("insufficient balance")
            ) {
                throw new Error(
                    `Public fee rejected on ${NETWORK}: ${message}\n` +
                    `Fund ${deployer} with public ${NETWORK} credits and rerun.`,
                );
            }
            console.error("Submit failed, retrying in 5s:", message);
            await sleep(5_000);
        }
    }
}

const submittedId = await submitUpgrade();
console.log(`Waiting for confirmation (up to ${CONFIRM_TIMEOUT_MS / 1000}s). 404s while polling are expected until the tx is included.`);
const transactionStatus = await programManager.networkClient.waitForTransactionConfirmation(
    submittedId,
    CONFIRM_POLL_MS,
    CONFIRM_TIMEOUT_MS,
);
console.log("Transaction Status:", transactionStatus.status);
if (transactionStatus.status.toLowerCase() !== "accepted") {
    throw new Error(`Upgrade was not accepted: ${transactionStatus.status}`);
}
console.log("Transaction confirmed successfully.");
