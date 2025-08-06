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

  const udtArgs = ccc.hexFrom(env("ASK_UDT_ARGS"));
  const udtScript = await buildUdtScript(signer.client, udtArgs);

  const recipient = await ccc.Address.fromString(
    env("HELPER_RECIPIENT_ADDRESS"),
    ckbClient,
  );

  const sendAmount = ccc.fixedPointFrom(env("HELPER_SEND_UDT_AMOUNT"), 6);
  // Spare amounts are set aside to pay for converted CKBs
  const spareAmount = ccc.fixedPointFrom(env("HELPER_SPARE_AMOUNT"), 6);

  const tx = ccc.Transaction.from({
    outputs: [{ lock: recipient.script, type: udtScript }],
    outputsData: [ccc.numLeToBytes(sendAmount, 16)],
  });
  await tx.completeInputsByUdt(signer, udtScript, spareAmount);
  const inputsCapacity = await tx.getInputsCapacity(signer.client);
  const inputsAmount = await tx.getInputsUdtBalance(signer.client, udtScript);

  const signerLock = (await signer.getAddressObjSecp256k1()).script;
  tx.addOutput(
    {
      capacity: inputsCapacity,
      lock: signerLock,
      type: udtScript,
    },
    ccc.numLeToBytes(inputsAmount - sendAmount, 16),
  );
  await tx.prepareSighashAllWitness(signerLock, 65, signer.client);

  const {
    valid_until,
    transaction: completedTx,
    ask_tokens,
    bid_tokens,
  } = await rpcClient.request("initiate", [tx]);
  console.log("Request valid until:", valid_until);
  console.log("Ask USDI:", ccc.fixedPointFrom(ask_tokens, 6));
  console.log("Bid CKBytes:", ccc.fixedPointFrom(bid_tokens));
  console.log("Completed tx:", completedTx);

  const completedTxStr = JSON.stringify(completedTx, null, "  ");
  fs.writeFileSync(env("HELPER_OUTPUT_COMPLETED_TX"), completedTxStr);
}

run();
