import express from "express";
import { ccc } from "@ckb-ccc/core";

import {
  dbConnection,
  udtName,
  funder,
  refresherQueue,
  assemblerQueue,
} from "./env";
import { env } from "./utils";
import "./workers";
import "./signer";
import { rpc } from "./rpc";

async function init() {
  // TODO: right now the price is hardcoded to 1 CKB == 0.01 USDI,
  // we should allow customizations.
  await dbConnection.set(`PRICE:${udtName}`, "0.01");

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
  app.set("json replacer", (_: any, value: any) => {
    if (typeof value === "bigint") {
      return ccc.numToHex(value);
    }
    return value;
  });

  app.post("/rpc", (req, res) => {
    rpc.receive(req.body).then((resp) => {
      if (resp) {
        res.json(resp);
      } else {
        res.sendStatus(204);
      }
    });
  });

  app.listen(process.env["PORT"] || 8000);
}

init();
