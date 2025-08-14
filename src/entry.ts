import express from "express";
import morgan from "morgan";
import { ccc } from "@ckb-ccc/core";
import Binance from "binance-api-node";

import {
  dbConnection,
  udtName,
  udtInfo,
  funder,
  refresherQueue,
  assemblerQueue,
} from "./env";
import { env, Logger } from "./utils";
import "./workers";
import "./signer";
import { rpc } from "./rpc";

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
  // TODO: right now the price is hardcoded to 1 CKB == 0.01 USDI,
  // we should allow customizations.

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

  const app = express();
  app.use(express.json());
  app.use(morgan("combined"));
  app.set("json replacer", (_: any, value: any) => {
    if (typeof value === "bigint") {
      return ccc.numToHex(value);
    }
    return value;
  });

  const logRequest = process.env["LOG_REQUEST"] === "true";
  app.post(process.env["RPC_PATH"] || "/rpc", (req, res) => {
    try {
      if (logRequest) {
        Logger.info("Request body:", req.body);
      }
      rpc.receive(req.body).then((resp) => {
        if (resp) {
          if (logRequest) {
            Logger.info("Response body:", JSON.stringify(resp));
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
