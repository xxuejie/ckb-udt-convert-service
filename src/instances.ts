import "./configs";
import { env, buildCccClient } from "./utils";

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { ccc } from "@ckb-ccc/core";

import fs from "fs";
import path from "path";

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

export const ckbClient = buildCccClient();
