// TODO: split this later, signer specific code should be in its own
// module

import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";

import fs from "fs";
import path from "path";

export const Logger = pino();

process.on("unhandledRejection", (reason, promise) => {
  Logger.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

function assertIsDefined<T>(value: T | undefined | null, message?: string): T {
  if (value === undefined || value === null) {
    throw new Error(message || "Value cannot be undefined or null.");
  }
  return value;
}

export function env(value: string): string {
  return assertIsDefined(
    process.env[value],
    `${value} is not set in .env file!`,
  );
}

// We will use this till we figure out the details of ccc's cache
class NoCache extends ccc.ClientCache {
  async markUsableNoCache(
    ...cellLikes: (ccc.CellLike | ccc.CellLike[])[]
  ): Promise<void> {}

  async markUnusable(
    ...outPointLikes: (ccc.OutPointLike | ccc.OutPointLike[])[]
  ): Promise<void> {}

  async clear(): Promise<void> {}

  async *findCells(
    keyLike: cccA.ClientCollectableSearchKeyLike,
  ): AsyncGenerator<ccc.Cell> {}

  async isUnusable(outPointLike: ccc.OutPointLike): Promise<boolean> {
    return false;
  }
}

export function buildCccClient() {
  const network = env("CKB_NETWORK");
  switch (network) {
    case "mainnet":
      return new ccc.ClientPublicMainnet({
        url: env("CKB_RPC_URL"),
        cache: new NoCache(),
      });
    case "testnet":
      return new ccc.ClientPublicTestnet({
        url: env("CKB_RPC_URL"),
        cache: new NoCache(),
      });
    case "devnet":
      return new ccc.ClientPublicTestnet({
        url: env("CKB_RPC_URL"),
        scripts: JSON.parse(fs.readFileSync(env("SCRIPT_CONFIG_FILE"), "utf8")),
        fallbacks: [],
        cache: new NoCache(),
      });
    default:
      throw new Error(`Unknown network value: ${network}`);
  }
}

export const dbConnection = new IORedis(env("REDIS_DB_URL"), {
  maxRetriesPerRequest: null,
  scripts: {
    lockCell: {
      numberOfKeys: 3,
      lua: fs.readFileSync(
        path.resolve(__dirname, "..", "lua", "lock_cell.lua"),
        "utf8",
      ),
    },
    commitCell: {
      numberOfKeys: 2,
      lua: fs.readFileSync(
        path.resolve(__dirname, "..", "lua", "commit_cell.lua"),
        "utf8",
      ),
    },
    refresh: {
      numberOfKeys: 4,
      lua: fs.readFileSync(
        path.resolve(__dirname, "..", "lua", "refresh.lua"),
        "utf8",
      ),
    },
  },
});
export const queueConnection = new IORedis(env("REDIS_MQ_URL"), {
  maxRetriesPerRequest: null,
});
export const refresherQueue = new Queue("refresher", {
  connection: queueConnection,
});
export const signerQueue = new Queue("signer", { connection: queueConnection });

const ckbClient = buildCccClient();

export const funder = new ccc.SignerCkbPublicKey(
  ckbClient,
  process.env["FUND_POOL_PUBLIC_KEY"] ||
    new ccc.SignerCkbPrivateKey(ckbClient, env("FUND_POOL_PRIVATE_KEY"))
      .publicKey,
);
export const udtArgs = ccc.hexFrom(env("ASK_UDT_ARGS"));
export const initialUdtCellCkb = ccc.fixedPointFrom(
  env("INITIAL_UDT_CELL_CKB"),
);
export const minUdtCellCkb = ccc.fixedPointFrom(env("MIN_UDT_CELL_CKB"));

export const ASSEMBLE_BATCH = 50;
if (initialUdtCellCkb / minUdtCellCkb >= ASSEMBLE_BATCH) {
  Logger.warn(
    `More than ${ASSEMBLE_BATCH} cells are required to assemble one fund UDT cell!`,
  );
}

export const lockedSeconds = parseInt(env("LOCKED_SECONDS"));
