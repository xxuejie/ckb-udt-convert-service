import dotenv from "dotenv";
dotenv.config({ path: process.env["DOTENV_FILE"] || ".env" });

import fs from "fs";

import { ccc } from "@ckb-ccc/core";

import { buildCccClient, env } from "../utils";
import { buildRpc } from "../multisig/rpc";
import { parseMultisigConfig } from "../multisig/utils";
import { bootExpressApp } from "./utils";

async function init() {
  const client = buildCccClient();
  const signer = new ccc.SignerCkbPrivateKey(
    client,
    env("MULTISIG_PRIVATE_KEY"),
  );
  const config = parseMultisigConfig(
    JSON.parse(fs.readFileSync(env("MULTISIG_CONFIG_FILE"), "utf8")),
  );

  const rpc = buildRpc({
    client,
    signer,
    config,
  });

  bootExpressApp(rpc);
}

init();
