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
// Program id per network: `program.json` holds the mainnet name; the testnet
// deployment uses a different on-chain id, overridable via env.
const MAINNET_PROGRAM_ID = JSON.parse(
    fs.readFileSync(path.resolve(here, "../program.json"), "utf8"),
)["program"] as string;
const MAINNET_IDENTIFIER = MAINNET_PROGRAM_ID.split(".aleo")[0];
const DEFAULT_TESTNET_PROGRAM_ID = `test_${MAINNET_IDENTIFIER}.aleo`;
const PROGRAM_ID =
    process.env.PROGRAM_ID ??
    (NETWORK === "mainnet" ? MAINNET_PROGRAM_ID : DEFAULT_TESTNET_PROGRAM_ID);

// Load the compiled source. For testnet (or any PROGRAM_ID that differs from
// the mainnet id) the on-chain id is the `program <id>.aleo;` line inside the
// source, so rewrite that one line from the compiled artifact.
function loadProgramSource(): string {
    const overridePath = process.env.PROGRAM_SOURCE_PATH;
    if (overridePath) {
        return fs.readFileSync(overridePath, "utf8");
    }
    if (PROGRAM_ID === MAINNET_PROGRAM_ID) {
        return fs.readFileSync(
            path.resolve(here, `../build/${MAINNET_IDENTIFIER}/${MAINNET_PROGRAM_ID}`),
            "utf8",
        );
    }
    const altIdentifier = PROGRAM_ID.split(".aleo")[0];
    const altPath = path.resolve(here, `../build/${altIdentifier}/${PROGRAM_ID}`);
    if (fs.existsSync(altPath)) {
        return fs.readFileSync(altPath, "utf8");
    }
    // Derive the testnet source from the compiled mainnet artifact.
    const base = fs.readFileSync(
        path.resolve(here, `../build/${MAINNET_IDENTIFIER}/${MAINNET_PROGRAM_ID}`),
        "utf8",
    );
    const renamed = base.replace(
        `program ${MAINNET_PROGRAM_ID};`,
        `program ${PROGRAM_ID};`,
    );
    if (renamed === base) {
        throw new Error(
            `Could not rewrite program id in compiled source. Expected to find "program ${MAINNET_PROGRAM_ID};".\n` +
            `Provide the source explicitly via PROGRAM_SOURCE_PATH.`,
        );
    }
    return renamed;
}

const PROGRAM_SOURCE = loadProgramSource();
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
// Note: Typescript throws error ^ here, its works in runtime as type gets set at runtime.
// So, no need to fix it.
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
            if (message.includes("Failed to verify proof") || message.includes("Fee verification failed")) {
                throw new Error(
                    `The network rejected this transaction's fee proof, so resubmitting it will keep failing.\n` +
                    `Rebuild the upgrade with the current SDK and submit that new transaction.\n` +
                    message,
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
