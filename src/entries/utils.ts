import fs from "fs";

import express from "express";
import morgan from "morgan";
import { JSONRPCServer } from "json-rpc-2.0";
import { ccc } from "@ckb-ccc/core";

import { SignerCkbMultisig } from "../ccc";
import { RpcMode } from "../rpc";
import { env, Logger } from "../utils";
import { parseMultisigConfig } from "../multisig/utils";

export function jsonReplacer(_: any, value: any) {
  if (typeof value === "bigint") {
    return ccc.numToHex(value);
  }
  return value;
}

export function jsonFormatter(val: any) {
  return JSON.stringify(val, jsonReplacer, 2);
}

export function buildFunder(client: ccc.Client): [ccc.Signer, RpcMode] {
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
          new ccc.SignerCkbPrivateKey(client, env("FUND_POOL_PRIVATE_KEY"))
            .publicKey,
      ),
      "singlesig",
    ];
  }
}

export function bootExpressApp(rpc: JSONRPCServer) {
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
