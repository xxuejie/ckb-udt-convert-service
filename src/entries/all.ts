// Runs all background workers and RPC servers for singlesig case
// in one node.js instance

import express from "express";
import morgan from "morgan";
import { ccc } from "@ckb-ccc/core";
import Binance from "binance-api-node";

import fs from "fs";

import { SignerCkbMultisig } from "../ccc";
import { udtName, udtInfo } from "../configs";
import {
  dbConnection,
  queueConnection,
  refresherQueue,
  assemblerQueue,
  signerQueue,
  ckbClient,
} from "../instances";
import { env, Logger } from "../utils";
import { bootWorkers } from "../workers";
import { buildRpc, RpcMode } from "../rpc";
import { parseMultisigConfig } from "../multisig/utils";

function jsonReplacer(_: any, value: any) {
  if (typeof value === "bigint") {
    return ccc.numToHex(value);
  }
  return value;
}

function jsonFormatter(val: any) {
  return JSON.stringify(val, jsonReplacer, 2);
}

function buildFunder(client: ccc.Client): [ccc.Signer, RpcMode] {
  if (process.env["FUND_POOL_MODE"] === "multisig") {
    return [
      new SignerCkbMultisig(
        client,
        parseMultisigConfig(
          JSON.parse(fs.readFileSync(env("MULTISIG_CONFIG_FILE"), "utf8")),
        ),
      ),
      "multisig",
    ];
  } else {
    return [
      new ccc.SignerCkbPublicKey(
        client,
        process.env["FUND_POOL_PUBLIC_KEY"] ||
          new ccc.SignerCkbPrivateKey(ckbClient, env("FUND_POOL_PRIVATE_KEY"))
            .publicKey,
      ),
      "singlesig",
    ];
  }
}

async function init() {
  const strategy = env("PRICE_STRATEGY").toLowerCase();
  switch (strategy) {
    case "binance":
      {
        const client = Binance();
        client.ws.ticker([udtInfo.binancePairName], async (trade) => {
          await dbConnection.setex(`PRICE:${udtName}`, 10, trade.weightedAvg);
        });
      }
      break;
    case "custom":
      break;
    default:
      {
        const fixedPrice = ccc.fixedPointFrom(strategy, 6);
        if (fixedPrice > 0n) {
          await dbConnection.set(
            `PRICE:${udtName}`,
            ccc.fixedPointToString(fixedPrice, 6),
          );
        } else {
          throw new Error(`Unknown price strategy: ${strategy}`);
        }
      }
      break;
  }

  const [funder, mode] = buildFunder(ckbClient);

  bootWorkers({
    dbConnection,
    queueConnection,
    signerQueue,
    funder,
  });
  const refresherJob = await refresherQueue.upsertJobScheduler(
    "periodic-refresher",
    {
      every: parseInt(env("REFRESHER_TRIGGER_SECONDS")) * 1000,
    },
  );
  const assemblerJob = await assemblerQueue.upsertJobScheduler(
    "periodic-assembler",
    {
      every: parseInt(env("ASSEMBLER_TRIGGER_SECONDS")) * 1000,
    },
  );

  const rpc = buildRpc({
    dbConnection,
    signerQueue,
    funder,
    mode,
  });

  const app = express();
  app.use(express.json());
  app.use(morgan("combined"));
  app.set("json replacer", jsonReplacer);

  const logRequest = process.env["LOG_REQUEST"] === "true";
  app.post(process.env["RPC_PATH"] || "/rpc", (req, res) => {
    try {
      if (logRequest) {
        Logger.info("Request body:", jsonFormatter(req.body));
      }
      rpc.receive(req.body).then((resp) => {
        if (resp) {
          if (logRequest) {
            Logger.info("Response body:", jsonFormatter(resp));
          }
          res.json(resp);
        } else {
          res.sendStatus(204);
        }
      });
    } catch (e) {
      Logger.error("RPC processing error: ", e);
      res.sendStatus(400);
    }
  });

  app.listen(process.env["PORT"] || 8000);
}

init();
