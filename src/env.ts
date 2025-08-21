import dotenv from "dotenv";
dotenv.config({ path: process.env["DOTENV_FILE"] || ".env" });

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { ccc } from "@ckb-ccc/core";

import fs from "fs";
import path from "path";

import { env, buildNoCacheClient, Logger } from "./utils";

export function buildCccClient() {
  return buildNoCacheClient(
    env("CKB_NETWORK"),
    env("CKB_RPC_URL"),
    env("SCRIPT_CONFIG_FILE"),
  );
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
      numberOfKeys: 4,
      lua: fs.readFileSync(
        path.resolve(__dirname, "..", "lua", "commit_cell.lua"),
        "utf8",
      ),
    },
    cancelCell: {
      numberOfKeys: 4,
      lua: fs.readFileSync(
        path.resolve(__dirname, "..", "lua", "cancel_cell.lua"),
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
export const assemblerQueue = new Queue("assembler", {
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

export const udts = JSON.parse(
  fs.readFileSync(env("UDT_SCRIPTS_FILE"), "utf8"),
);
export const udtName = env("ASK_UDT");
export const udtScript = ccc.Script.from(udts[udtName].script);
export const udtInfo = udts[udtName];
export const udtCellDeps = udts[udtName].cellDeps;

export const initialUdtCellCkb = ccc.fixedPointFrom(
  env("INITIAL_UDT_CELL_CKB"),
);
export const minUdtCellCkb = ccc.fixedPointFrom(env("MIN_UDT_CELL_CKB"));
export const maxTradedCkb = ccc.fixedPointFrom(env("MAX_TRADED_CKB"));

export const ASSEMBLE_BATCH = 50;
if (initialUdtCellCkb / minUdtCellCkb >= ASSEMBLE_BATCH) {
  Logger.warn(
    `More than ${ASSEMBLE_BATCH} cells are required to assemble one fund UDT cell!`,
  );
}

export const lockedSeconds = parseInt(env("LOCKED_SECONDS"));
export const commitingSeconds = parseInt(env("COMMITING_SECONDS"));

export const incentivePercent = env("INCENTIVE_PERCENT");
