import dotenv from "dotenv";
dotenv.config({ path: process.env["DOTENV_FILE"] || ".env" });

import { ccc } from "@ckb-ccc/core";
import { JSONRPCClient } from "json-rpc-2.0";

import fs from "fs";

import { env, buildNoCacheClient, buildUdtScript } from "../utils";

async function run() {
  const ckbClient = buildNoCacheClient(
    env("CKB_NETWORK"),
    env("CKB_RPC_URL"),
    env("SCRIPT_CONFIG_FILE"),
  );

  const udtArgs = ccc.hexFrom(env("ASK_UDT_ARGS"));
  const udtScript = await buildUdtScript(ckbClient, udtArgs);

  const address = await ccc.Address.fromString(
    env("HELPER_QUERY_ADDRESS"),
    ckbClient,
  );

  let plainCells = 0;
  let udtCells = 0;
  let unknownCells = 0;
  for await (const cell of ckbClient.findCellsByLock(
    address.script,
    null,
    true,
  )) {
    if (cell.cellOutput.type === undefined) {
      console.log(
        "Plain cell:",
        cell.outPoint,
        "CKBytes:",
        ccc.fixedPointToString(cell.cellOutput.capacity),
      );
      plainCells += 1;
    } else if (cell.cellOutput.type.eq(udtScript)) {
      const udtBalance = ccc.udtBalanceFrom(cell.outputData);
      console.log(
        "UDT Cell:",
        cell.outPoint,
        "CKBytes:",
        ccc.fixedPointToString(cell.cellOutput.capacity),
        "UDT:",
        ccc.fixedPointToString(udtBalance, 6),
      );
      udtCells += 1;
    } else {
      console.log(
        "Unknown cell:",
        cell.outPoint,
        "CKBytes:",
        ccc.fixedPointToString(cell.cellOutput.capacity),
      );
      unknownCells += 1;
    }
  }

  console.log(
    `In total, ${plainCells} plain cells, ${udtCells} UDT cells, ${unknownCells} unknown cells`,
  );
}

run();
