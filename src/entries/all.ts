// Runs background workers and RPC servers in one node.js instance

import { ccc } from "@ckb-ccc/core";
import Binance from "binance-api-node";

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
import { buildFunder, bootExpressApp } from "./utils";

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
    mode,
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

  bootExpressApp(rpc);
}

init();
