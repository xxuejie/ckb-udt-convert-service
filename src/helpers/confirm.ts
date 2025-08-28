import dotenv from "dotenv";
dotenv.config({ path: process.env["DOTENV_FILE"] || ".env" });

import { ccc } from "@ckb-ccc/core";

import fs from "fs";

import { buildJsonRpcClient } from "../jsonrpc";
import { env, buildNoCacheClient } from "../utils";

const rpcClient = buildJsonRpcClient(env("SERVER_URL"));

async function run() {
  const ckbClient = buildNoCacheClient(
    env("CKB_NETWORK"),
    env("CKB_RPC_URL"),
    env("SCRIPT_CONFIG_FILE"),
  );

  const signer = new ccc.SignerCkbPrivateKey(
    ckbClient,
    env("HELPER_SENDER_PRIVATE_KEY"),
  );

  const tx = ccc.Transaction.from(
    JSON.parse(fs.readFileSync(env("HELPER_INPUT_CONFIRMING_TX"), "utf8")),
  );
  const signedTx = await signer.signTransaction(tx);

  const response = await rpcClient.request("confirm", [signedTx]);
  const completeTx = ccc.Transaction.from(response.transaction);

  console.log("Final tx hash:", completeTx.hash());
}

run();
