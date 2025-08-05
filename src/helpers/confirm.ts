import { ccc } from "@ckb-ccc/core";
import { JSONRPCClient } from "json-rpc-2.0";

import fs from "fs";

import { env, buildNoCacheClient, buildUdtScript } from "../utils";

const rpcClient = new JSONRPCClient(
  (jsonRPCRequest: any): Promise<any> =>
    fetch(env("SERVER_URL"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(jsonRPCRequest),
    }).then((response) => {
      if (response.status === 200) {
        // Use client.receive when you received a JSON-RPC response.
        return response
          .json()
          .then((jsonRPCResponse) => rpcClient.receive(jsonRPCResponse));
      } else if (jsonRPCRequest.id !== undefined) {
        return Promise.reject(new Error(response.statusText));
      }
    }),
);

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
  console.log("Confirming response:", response);
}

run();
